/**
 * 引擎路径解析测试
 *
 * 这段逻辑一旦出错，表现就是「应用启动后引擎永远找不到」。
 * 而它的分支全由平台命名差异驱动，所以必须在 Linux 上也能验证
 * Windows / macOS 的布局。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  engineBinaryName,
  engineDirName,
  resolveEnginePath,
  type EnginePathContext,
} from '../src/core/engine-path.ts';

/** 用内存里的「文件系统」模拟平台布局 */
function ctx(
  files: string[],
  opts: Partial<EnginePathContext> = {},
): EnginePathContext {
  // 按路径风格归一：Windows 盘符路径统一成反斜杠，POSIX 路径统一成正斜杠
  const norm = (s: string): string =>
    /^[A-Za-z]:/.test(s) ? s.replace(/\//g, '\\') : s.replace(/\\/g, '/');

  const set = new Set(files.map(norm));

  return {
    platform: 'win32',
    arch: 'x64',
    isPackaged: true,
    resourcesPath: 'C:\\app\\resources',
    appPath: 'C:\\repo',
    exists: (p) => set.has(norm(p)),
    listDirs: (p) => {
      const prefix = norm(p).replace(/[\\/]+$/, '') + (norm(p).includes('\\') ? '\\' : '/');
      const sep = prefix.endsWith('\\') ? '\\' : '/';
      const out = new Set<string>();
      for (const f of set) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const i = rest.indexOf(sep);
        if (i > 0) out.add(rest.slice(0, i));
      }
      return [...out];
    },
    ...opts,
  };
}

test('engineDirName：平台与架构的命名映射', () => {
  assert.equal(engineDirName('win32', 'x64'), 'windows-amd64');
  assert.equal(engineDirName('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(engineDirName('darwin', 'x64'), 'darwin-amd64');
  assert.equal(engineDirName('linux', 'x64'), 'linux-amd64');
  assert.equal(engineDirName('linux', 'arm64'), 'linux-arm64');
});

test('engineBinaryName：Windows 带 .exe，其它不带', () => {
  assert.equal(engineBinaryName('win32'), 'openlist.exe');
  assert.equal(engineBinaryName('darwin'), 'openlist');
  assert.equal(engineBinaryName('linux'), 'openlist');
});

test('开发模式：固定仓库布局', () => {
  const p = resolveEnginePath(ctx([], { isPackaged: false }));
  assert.equal(p, 'C:\\repo\\resources\\sidecar\\windows-amd64\\openlist.exe');
});

test('打包-摊平布局优先', () => {
  const c = ctx(['C:/app/resources/sidecar/openlist.exe']);
  assert.equal(resolveEnginePath(c), 'C:\\app\\resources\\sidecar\\openlist.exe');
});

test('打包-Windows 嵌套布局（windows-amd64）', () => {
  const c = ctx(['C:/app/resources/sidecar/windows-amd64/openlist.exe']);
  assert.equal(
    resolveEnginePath(c),
    'C:\\app\\resources\\sidecar\\windows-amd64\\openlist.exe',
  );
});

test('打包-macOS arm64（darwin-arm64）', () => {
  const c = ctx(['/app/resources/sidecar/darwin-arm64/openlist'], {
    platform: 'darwin',
    arch: 'arm64',
    resourcesPath: '/app/resources',
  });
  assert.equal(resolveEnginePath(c), '/app/resources/sidecar/darwin-arm64/openlist');
});

test('打包-macOS x64：electron-builder 会用 darwin-x64，也要能找到', () => {
  const c = ctx(['/app/resources/sidecar/darwin-x64/openlist'], {
    platform: 'darwin',
    arch: 'x64',
    resourcesPath: '/app/resources',
  });
  assert.equal(resolveEnginePath(c), '/app/resources/sidecar/darwin-x64/openlist');
});

test('打包-Linux x64（linux-amd64）', () => {
  const c = ctx(['/app/resources/sidecar/linux-amd64/openlist'], {
    platform: 'linux',
    arch: 'x64',
    resourcesPath: '/app/resources',
  });
  assert.equal(resolveEnginePath(c), '/app/resources/sidecar/linux-amd64/openlist');
});

test('未知目录名：靠扫描兜底', () => {
  const c = ctx(['C:/app/resources/sidecar/whatever-arch/openlist.exe']);
  assert.equal(
    resolveEnginePath(c),
    'C:\\app\\resources\\sidecar\\whatever-arch\\openlist.exe',
  );
});

test('完全找不到：返回摊平候选，交给调用方明确报错', () => {
  const c = ctx([]);
  assert.equal(resolveEnginePath(c), 'C:\\app\\resources\\sidecar\\openlist.exe');
});

test('多个平台目录共存时，优先选当前平台的', () => {
  const c = ctx([
    'C:/app/resources/sidecar/linux-amd64/openlist',
    'C:/app/resources/sidecar/windows-amd64/openlist.exe',
  ]);
  assert.equal(
    resolveEnginePath(c),
    'C:\\app\\resources\\sidecar\\windows-amd64\\openlist.exe',
  );
});
