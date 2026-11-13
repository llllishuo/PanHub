/**
 * 编排层测试：引擎管理 + 静态加密 + 重启免重登 + 下载队列
 *
 * 这里验证的是产品承诺里最难做对的部分：
 *  「用户登录一次，程序本地加密记录，后面下载不需要重复登录」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmRetry } from './helpers.ts';

import { PanhubService } from '../src/main/service.ts';
import { MemoryKeyStore } from '../src/core/vault.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(
  ROOT,
  'resources',
  'sidecar',
  process.platform === 'win32' ? 'windows-amd64' : `${process.platform}-amd64`,
  process.platform === 'win32' ? 'openlist.exe' : 'openlist',
);
const SKIP = !existsSync(BIN);

function makeService(appDataDir: string, keyStore = new MemoryKeyStore()) {
  return new PanhubService({ appDataDir, engineBin: BIN, keyStore, connections: 4 });
}

test('启动引擎并报告状态', { skip: SKIP }, async () => {
  const appData = await mkdtemp(join(tmpdir(), 'panhub-svc-'));
  const svc = makeService(appData);
  try {
    const { url } = await svc.startEngine();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const st = await svc.status();
    assert.equal(st.engineRunning, true);
    assert.equal(st.engineUrl, url);
  } finally {
    await svc.dispose();
    await rmRetry(appData, { recursive: true, force: true });
  }
});

test('账号持久化 + 静态加密 + 重启免重登', { skip: SKIP }, async () => {
  const appData = await mkdtemp(join(tmpdir(), 'panhub-svc-'));
  const src = await mkdtemp(join(tmpdir(), 'panhub-src-'));
  const storeDir = await mkdtemp(join(tmpdir(), 'panhub-store-'));
  // 刻意用 ~64 KB 而不是十几字节的文本：
  // OpenList 的 Local 驱动在 Windows 上对极小文件会在 HTTP 响应头里
  // 报出按分配单元取整的大小（实测 12 字节文件被报成 8192），
  // 导致分片规划整体错位。这是该驱动处理本地小文件的怪癖，
  // 真实网盘返回的 size 是准确的。此处不为迁就驱动而牺牲测试覆盖面。
  const CONTENT = 'panhub persistence check\n'.repeat(2400);
  await writeFile(join(src, 'a.txt'), CONTENT);

  const keyStore = new MemoryKeyStore();
  const engineDir = join(appData, 'engine');

  try {
    // ---------- 第一次会话：登录并挂载 ----------
    const svc1 = makeService(appData, keyStore);
    await svc1.startEngine();
    await svc1.addMount({
      mountPath: '/persist',
      driver: 'Local',
      addition: { root_folder_path: src },
      remark: 'persistence test',
    });
    assert.equal((await svc1.listMounts()).length, 1);
    assert.ok(existsSync(join(engineDir, 'config.json')), '运行期应有明文配置');
    await svc1.dispose();

    // ---------- 停机后：明文必须消失，密文进保险箱 ----------
    assert.ok(!existsSync(join(engineDir, 'config.json')), '停机后明文 config.json 未清除');
    assert.ok(!existsSync(join(engineDir, 'data.db')), '停机后明文 data.db 未清除');

    const raw = await readFile(join(appData, 'vault.json'), 'utf8');
    assert.ok(!raw.includes('root_folder_path'), '挂载配置明文泄漏到磁盘');
    assert.ok(raw.includes('engine:data.db'), 'data.db 未进入保险箱');

    // ---------- 第二次会话（模拟重启）：不应要求重新登录 ----------
    const svc2 = makeService(appData, keyStore);
    await svc2.startEngine();
    const mounts = await svc2.listMounts();
    assert.equal(mounts.length, 1, '重启后挂载丢失 —— 等于要用户重新登录');
    assert.equal(mounts[0].mount_path, '/persist');

    const files = await svc2.browse('/persist');
    assert.deepEqual(files.map((f) => f.name), ['a.txt']);

    // ---------- 下载队列 ----------
    const job = await svc2.enqueueDownload('/persist/a.txt', storeDir);
    assert.equal(job.status, 'queued');

    const finished = await new Promise<{ status: string; destPath: string; percent: number }>(
      (res) => {
        const t = setTimeout(() => res({ ...svc2.listJobs()[0], status: 'timeout' }), 30_000);
        svc2.on('job', (j) => {
          if (j.id === job.id && ['done', 'failed'].includes(j.status)) {
            clearTimeout(t);
            res(j);
          }
        });
      },
    );
    assert.equal(finished.status, 'done', `下载未完成：${JSON.stringify(finished)}`);
    assert.equal(finished.percent, 100);
    assert.equal(await readFile(finished.destPath, 'utf8'), CONTENT);

    await svc2.dispose();
  } finally {
    await rmRetry(appData, { recursive: true, force: true });
    await rmRetry(src, { recursive: true, force: true });
    await rmRetry(storeDir, { recursive: true, force: true });
  }
});

test('密钥丢失时不静默清空账号，而是明确报错', { skip: SKIP }, async () => {
  const appData = await mkdtemp(join(tmpdir(), 'panhub-svc-'));
  try {
    const svc1 = makeService(appData, new MemoryKeyStore());
    await svc1.startEngine();
    await svc1.dispose();

    // 模拟系统凭据库被清空
    const svc2 = makeService(appData, new MemoryKeyStore());
    await assert.rejects(
      () => svc2.startEngine(),
      (e: unknown) => /E_KEY_MISSING|主密钥不存在|无法连接到本地引擎/.test(String(e)),
      '主密钥丢失却静默继续，会导致用户账号凭据被悄悄丢弃',
    );
    await svc2.dispose().catch(() => {});
  } finally {
    await rmRetry(appData, { recursive: true, force: true });
  }
});

test('下载大文件：进度事件单调且最终字节一致', { skip: SKIP }, async () => {
  const appData = await mkdtemp(join(tmpdir(), 'panhub-svc-'));
  const src = await mkdtemp(join(tmpdir(), 'panhub-src-'));
  const storeDir = await mkdtemp(join(tmpdir(), 'panhub-store-'));
  const payload = randomBytes(4 * 1024 * 1024);
  const sha = createHash('sha256').update(payload).digest('hex');
  await writeFile(join(src, 'big.bin'), payload);

  const svc = makeService(appData);
  try {
    await svc.startEngine();
    await svc.addMount({ mountPath: '/big', driver: 'Local', addition: { root_folder_path: src } });

    const job = await svc.enqueueDownload('/big/big.bin', storeDir);
    const percents: number[] = [];
    const done = await new Promise<{ status: string; destPath: string }>((res) => {
      const t = setTimeout(() => res({ ...svc.listJobs()[0], status: 'timeout' }), 60_000);
      svc.on('job', (j) => {
        if (j.id !== job.id) return;
        percents.push(j.percent);
        if (['done', 'failed'].includes(j.status)) {
          clearTimeout(t);
          res(j);
        }
      });
    });
    assert.equal(done.status, 'done');
    for (let i = 1; i < percents.length; i++) {
      assert.ok(percents[i] >= percents[i - 1], '进度出现回退');
    }
    const got = await readFile(done.destPath);
    assert.equal(got.length, payload.length);
    assert.equal(createHash('sha256').update(got).digest('hex'), sha);
  } finally {
    await svc.dispose();
    await rmRetry(appData, { recursive: true, force: true });
    await rmRetry(src, { recursive: true, force: true });
    await rmRetry(storeDir, { recursive: true, force: true });
  }
});

// 说明：本文件内所有测试都能独立通过，且关闭后系统层面无残留引擎进程。
// 但 Node 的 undici 连接池会滞留若干 keep-alive 套接字，使测试进程在用例结束后
// 不立刻退出——因此测试脚本使用 `--test-force-exit`（Node 官方为此提供的开关）。
// 对桌面应用无影响：Electron 的 app.quit() 会直接终止进程。

