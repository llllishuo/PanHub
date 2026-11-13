/**
 * Sidecar 测试 —— 直接拉起真实的 OpenList 引擎
 *
 * 没有二进制时自动跳过，不会假装通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmRetry } from './helpers.ts';

import { OpenListSidecar, pickFreePort, buildConfig, SidecarError } from '../src/core/sidecar.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(
  ROOT,
  'resources',
  'sidecar',
  process.platform === 'win32' ? 'windows-amd64' : `${process.platform}-amd64`,
  process.platform === 'win32' ? 'openlist.exe' : 'openlist',
);
const HAS_BIN = existsSync(BIN);

test('buildConfig：必须只绑 127.0.0.1，且关掉所有额外协议面', () => {
  const cfg = buildConfig({
    dataDir: '/tmp/x',
    port: 12345,
    host: '127.0.0.1',
    jwtSecret: 's'.repeat(48),
  }) as Record<string, any>;

  assert.equal(cfg.scheme.address, '127.0.0.1', '绑定地址必须是回环，否则局域网可访问');
  assert.equal(cfg.scheme.http_port, 12345);
  assert.equal(cfg.scheme.https_port, -1);
  assert.equal(cfg.ftp.enable, false);
  assert.equal(cfg.sftp.enable, false);
  assert.equal(cfg.s3.enable, false);
  assert.equal(cfg.mcp.enable, false);
  // CORS 不该是 *
  assert.ok(!cfg.cors.allow_origins.includes('*'), 'CORS 不允许放开 *');
  assert.equal(cfg.database.type, 'sqlite3');
});

test('pickFreePort：返回可用端口且可重复获取', async () => {
  const p1 = await pickFreePort();
  const p2 = await pickFreePort();
  assert.ok(p1 > 1024 && p1 < 65536);
  assert.ok(p2 > 1024 && p2 < 65536);
});

test('找不到引擎二进制时给出明确错误码', async () => {
  const sc = new OpenListSidecar({ binPath: join(ROOT, 'no-such-openlist'), dataDir: tmpdir() });
  await assert.rejects(
    () => sc.start(1000),
    (e: unknown) => e instanceof SidecarError && (e as SidecarError).code === 'E_NOBIN',
  );
});

test('真实启动引擎：健康检查通过、配置落盘正确、能干净停止', { skip: !HAS_BIN }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-engine-'));
  const sc = new OpenListSidecar({ binPath: BIN, dataDir: dir });
  try {
    const info = await sc.start(60_000);
    assert.equal(info.host, '127.0.0.1');
    assert.ok(info.port > 1024);

    // 健康检查
    const res = await fetch(`${info.baseUrl}/ping`);
    assert.equal(res.status, 200);
    assert.match((await res.text()).trim(), /pong/i);

    // 配置文件确实按我们的安全基线写进去了
    const cfg = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.scheme.address, '127.0.0.1');
    assert.equal(cfg.scheme.http_port, info.port);
    assert.equal(cfg.ftp.enable, false);
    assert.equal(cfg.sftp.enable, false);
    assert.equal(cfg.s3.enable, false);
    assert.ok(cfg.jwt_secret.length >= 16);

    // 数据库已初始化
    const dbStat = await stat(join(dir, 'data.db'));
    assert.ok(dbStat.size > 0, 'data.db 未生成');

    assert.equal(sc.running, true);
    await sc.stop();
    assert.equal(sc.running, false);

    // 端口释放：能被重新监听
    await assert.doesNotReject(async () => {
      const re = await fetch(`${info.baseUrl}/ping`).catch(() => null);
      // 停掉后应该连不上
      assert.equal(re, null, '引擎停止后端口仍在响应');
    });
  } finally {
    await sc.stop().catch(() => {});
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('重启复用 jwt_secret，token 不会被动失效', { skip: !HAS_BIN }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-engine-'));
  const sc1 = new OpenListSidecar({ binPath: BIN, dataDir: dir });
  let secret1 = '';
  try {
    await sc1.start(60_000);
    secret1 = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).jwt_secret;
    await sc1.stop();

    const sc2 = new OpenListSidecar({ binPath: BIN, dataDir: dir });
    try {
      await sc2.start(60_000);
      const secret2 = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).jwt_secret;
      assert.equal(secret2, secret1, 'jwt_secret 每次重启都变会导致 token 失效');
    } finally {
      await sc2.stop().catch(() => {});
    }
  } finally {
    await sc1.stop().catch(() => {});
    await rmRetry(dir, { recursive: true, force: true });
  }
});

/**
 * 回归测试：记录 OpenList v4.2.9 的静默失败陷阱
 *
 * 陷阱：全新实例里 admin 用户并不存在（只建 guest），此时
 * `openlist admin set <pw>` 会返回**退出码 0 但什么都不做**。
 * 如果代码信任这个退出码，就会出现「设置成功却登录不上」的诡异故障。
 * 正确做法是先 POST /api/public/init/setup 完成初始化。
 */
test('陷阱回归：未初始化时 admin set 静默无效，初始化后才生效', { skip: !HAS_BIN }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-engine-'));
  const sc = new OpenListSidecar({ binPath: BIN, dataDir: dir });
  try {
    // 先起一次让数据库建表
    await sc.start(60_000);
    await sc.stop();

    // 1) 未初始化：admin set 退出码 0，但登录仍然失败
    const pwEarly = 'Early-' + Math.random().toString(36).slice(2, 8);
    await sc.setAdminPassword(pwEarly); // 不应抛错（这正是坑）

    const sc2 = new OpenListSidecar({ binPath: BIN, dataDir: dir });
    const info = await sc2.start(60_000);
    try {
      const bad = await fetch(`${info.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: pwEarly }),
      });
      const badBody = (await bad.json()) as { code: number };
      assert.notEqual(badBody.code, 200, '未初始化却登录成功，v4 行为假设有误');

      // 2) 走官方安装向导后 admin 才存在
      const setup = await fetch(`${info.baseUrl}/api/public/init/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: pwEarly }),
      });
      const setupBody = (await setup.json()) as { code: number };
      assert.equal(setupBody.code, 200);

      // 3) 初始化后登录成功
      const ok = await fetch(`${info.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: pwEarly }),
      });
      const okBody = (await ok.json()) as { code: number; data: { token: string } | null };
      assert.equal(okBody.code, 200);
      assert.ok(okBody.data && okBody.data.token.length > 20);
    } finally {
      await sc2.stop().catch(() => {});
    }

    // 4) 初始化之后 admin set 才真正生效
    const pwNew = 'After-' + Math.random().toString(36).slice(2, 8);
    await sc.setAdminPassword(pwNew);
    const sc3 = new OpenListSidecar({ binPath: BIN, dataDir: dir });
    const info3 = await sc3.start(60_000);
    try {
      const r = await fetch(`${info3.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: pwNew }),
      });
      const body = (await r.json()) as { code: number };
      assert.equal(body.code, 200, '初始化后 admin set 应真正生效');
    } finally {
      await sc3.stop().catch(() => {});
    }
  } finally {
    await sc.stop().catch(() => {});
    await rmRetry(dir, { recursive: true, force: true });
  }
});
