/**
 * 端到端链路测试：引擎 → 初始化 → 登录 → 建存储 → 列表 → 取直链 → 多线程下载 → 字节校验
 *
 * 这条链路就是产品的核心闭环，必须真实跑通，不能靠 mock。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmRetry } from './helpers.ts';

import { OpenListSidecar } from '../src/core/sidecar.ts';
import { OpenListClient, connectEngine, EngineApiError } from '../src/core/client.ts';
import { Downloader } from '../src/core/downloader.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(
  ROOT,
  'resources',
  'sidecar',
  process.platform === 'win32' ? 'windows-amd64' : `${process.platform}-amd64`,
  process.platform === 'win32' ? 'openlist.exe' : 'openlist',
);
const HAS_BIN = existsSync(BIN);
const SKIP = !HAS_BIN;

const USER = 'admin';
const PASS = 'TestPass_' + randomBytes(4).toString('hex');

async function bootEngine(withSetup = true) {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-e2e-'));
  const sc = new OpenListSidecar({ binPath: BIN, dataDir: dir });
  const info = await sc.start(60_000);
  const client = new OpenListClient(info.baseUrl);
  if (withSetup) {
    await client.setup(USER, PASS);
    await client.login(USER, PASS);
  }
  return { dir, sc, info, client };
}

test('引擎首次启动后必须先走安装向导，否则登录失败', { skip: SKIP }, async () => {
  const { dir, sc, info } = await bootEngine(false);
  try {
    const c = new OpenListClient(info.baseUrl);
    // v4 行为：未初始化时没有 admin 用户，登录必然失败
    await assert.rejects(
      () => c.login(USER, 'whatever'),
      (e: unknown) => e instanceof EngineApiError,
      '未初始化就登录成功，说明对 v4 行为的假设有误',
    );

    // 走安装向导后成功
    const created = await c.setup(USER, PASS);
    assert.equal(created, true);
    const token = await c.login(USER, PASS);
    assert.ok(token.length > 20);
    const me = await c.me();
    assert.equal(me.username, 'admin');
    assert.equal(me.role, 2, 'admin 的 role 应为 2');
  } finally {
    await sc.stop().catch(() => {});
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('重复 setup 不应破坏已初始化的实例', { skip: SKIP }, async () => {
  const { dir, sc, info } = await bootEngine(true);
  try {
    const c2 = new OpenListClient(info.baseUrl);
    const again = await c2.setup(USER, PASS);
    assert.equal(again, false, '二次 setup 应报告已初始化');
    // 原密码仍然有效
    await c2.login(USER, PASS);
    assert.equal((await c2.me()).username, 'admin');
  } finally {
    await sc.stop().catch(() => {});
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('驱动清单包含主流中国网盘', { skip: SKIP }, async () => {
  const { dir, sc, client } = await bootEngine();
  try {
    const drivers = await client.drivers();
    const names = Object.keys(drivers).sort();
    console.log(`\n[驱动] 共 ${names.length} 个`);
    console.log('  ' + names.join(', '));

    // 驱动名带后缀（115 Cloud / 115 Open / 115 Share），用包含匹配
    const wants = [
      'BaiduNetdisk', // 百度网盘
      'Aliyundrive', // 阿里云盘
      'Quark', // 夸克
      'UC', // UC
      '115', // 115
      'Thunder', // 迅雷
      'Lanzou', // 蓝奏云
      '189Cloud', // 天翼云
      '123Pan', // 123 云盘
      'WeiYun', // 腾讯微云
      'Mega', // MEGA
      'Onedrive', // OneDrive
      'GoogleDrive', // Google Drive
      'PikPak',
    ];
    for (const want of wants) {
      assert.ok(
        names.some((n) => n.toLowerCase().includes(want.toLowerCase())),
        `缺少驱动 ${want}`,
      );
    }
    assert.ok(names.length >= 50, `驱动数量偏少：${names.length}`);
  } finally {
    await sc.stop().catch(() => {});
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('完整闭环：建存储 → 列表 → 直链 → 多线程下载 → 字节一致', { skip: SKIP }, async () => {
  const src = await mkdtemp(join(tmpdir(), 'panhub-src-'));
  const payload = randomBytes(2 * 1024 * 1024 + 777);
  const sha = createHash('sha256').update(payload).digest('hex');
  await writeFile(join(src, 'hello.bin'), payload);
  await writeFile(join(src, 'notes.txt'), '你好，panhub\n');

  const { dir, sc, client } = await bootEngine();
  const outDir = await mkdtemp(join(tmpdir(), 'panhub-out-'));
  try {
    await client.createStorage({
      mount_path: '/local',
      driver: 'Local',
      addition: { root_folder_path: src },
      remark: 'e2e',
    });

    const storages = await client.storages();
    assert.ok(
      storages.some((s) => s.mount_path === '/local' && s.driver === 'Local'),
      '存储未创建成功',
    );

    const root = await client.list('/');
    assert.ok(root.some((i) => i.name === 'local' && i.is_dir), '/ 下没有 local 挂载点');

    const files = await client.list('/local');
    const names = files.map((f) => f.name).sort();
    assert.deepEqual(names, ['hello.bin', 'notes.txt']);
    const hb = files.find((f) => f.name === 'hello.bin');
    assert.equal(hb?.size, payload.length);

    // 取直链
    const meta = await client.get('/local/hello.bin');
    assert.equal(meta.is_dir, false);
    assert.ok(meta.raw_url, '引擎没有返回直链');
    console.log(`\n[直链] ${meta.raw_url.slice(0, 90)}…`);

    // 用我们的多线程下载器下载
    const dest = join(outDir, 'got.bin');
    const r = await new Downloader().download({
      url: meta.raw_url!,
      dest,
      connections: 4,
      minChunkSize: 256 * 1024,
      headers: { 'User-Agent': 'panhub/0.1' },
    });
    assert.equal(r.bytes, payload.length);
    const gotSha = createHash('sha256').update(await (await import('node:fs/promises')).readFile(dest)).digest('hex');
    assert.equal(gotSha, sha, '下载内容哈希不匹配');
  } finally {
    await sc.stop().catch(() => {});
    await rmRetry(dir, { recursive: true, force: true });
    await rmRetry(src, { recursive: true, force: true });
    await rmRetry(outDir, { recursive: true, force: true });
  }
});

test('connectEngine：首次自动初始化，二次直接登录', { skip: SKIP }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-e2e-'));
  const sc = new OpenListSidecar({ binPath: BIN, dataDir: dir });
  try {
    const info = await sc.start(60_000);
    const c1 = await connectEngine({ baseUrl: info.baseUrl, username: USER, password: PASS });
    assert.equal((await c1.me()).username, 'admin');

    // 第二次连接（模拟重启后免重配）
    const c2 = await connectEngine({ baseUrl: info.baseUrl, username: USER, password: PASS });
    assert.equal((await c2.me()).username, 'admin');

    // 错误密码必须明确失败，不能静默放行
    await assert.rejects(
      () => connectEngine({ baseUrl: info.baseUrl, username: USER, password: 'wrong-pass' }),
      /管理密码不正确|code=/,
    );
  } finally {
    await sc.stop().catch(() => {});
    await rmRetry(dir, { recursive: true, force: true });
  }
});
