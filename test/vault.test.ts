/**
 * 保险箱测试 —— 重点验证「安全属性」而不只是「能存能取」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmRetry } from './helpers.ts';

import { Vault, VaultError, MemoryKeyStore, FileKeyStore, MAGIC } from '../src/core/vault.ts';

async function freshVault() {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-vault-'));
  const keyStore = new MemoryKeyStore();
  const file = join(dir, 'vault.json');
  const vault = await Vault.open({ file, keyStore });
  return { dir, file, keyStore, vault };
}

test('初始化：首次打开会生成 32 字节主密钥且条目为空', async () => {
  const { dir, vault, keyStore } = await freshVault();
  try {
    assert.deepEqual(vault.list(), []);
    const key = await keyStore.load();
    assert.equal(key?.length, 32);
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('存取往返：put 后 get 拿到完全一致的对象', async () => {
  const { dir, vault } = await freshVault();
  try {
    const secret = { cookie: 'BDUSS=abc; STOKEN=def', refreshToken: 'r1', nested: { a: 1 } };
    await vault.put('baidu', secret, { account: 'user@example.com' });
    assert.deepEqual(await vault.get('baidu'), secret);
    assert.equal(await vault.has('baidu'), true);
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('不存在的条目返回 null，而不是抛错', async () => {
  const { dir, vault } = await freshVault();
  try {
    assert.equal(await vault.get('not-exist'), null);
    assert.equal(await vault.has('not-exist'), false);
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('持久化：重新打开同一文件能解出原值', async () => {
  const { dir, file, keyStore } = await freshVault();
  try {
    const v1 = await Vault.open({ file, keyStore });
    await v1.put('quark', { cookie: 'k=1' });

    const v2 = await Vault.open({ file, keyStore });
    assert.deepEqual(await v2.get('quark'), { cookie: 'k=1' });
    assert.equal(v2.list().length, 1);
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('落盘内容是密文：文件里不得出现明文凭据', async () => {
  const { dir, file, vault } = await freshVault();
  try {
    await vault.put('baidu', { cookie: 'SUPER_SECRET_BDUSS_VALUE_12345' });
    const raw = await readFile(file, 'utf8');
    assert.ok(!raw.includes('SUPER_SECRET_BDUSS_VALUE_12345'), '明文泄露到磁盘！');
    assert.ok(raw.includes(MAGIC));
    // 但 meta 是故意明文的
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('防替换攻击：跨条目搬运密文导致校验失败（AAD 绑定 providerId）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-vault-'));
  const file = join(dir, 'vault.json');
  const keyStore = new MemoryKeyStore();
  try {
    const v1 = await Vault.open({ file, keyStore });
    await v1.put('baidu', { cookie: 'a' });
    await v1.put('quark', { cookie: 'b' });

    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.entries.quark = { ...raw.entries.baidu, updatedAt: Date.now() };
    await writeFile(file, JSON.stringify(raw), 'utf8');

    const v2 = await Vault.open({ file, keyStore });
    await assert.rejects(
      () => v2.get('quark'),
      (e: unknown) => e instanceof VaultError && (e as VaultError).code === 'E_DECRYPT',
    );
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('防篡改：改动密文任一字节，解密必须失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-vault-'));
  const file = join(dir, 'vault.json');
  const keyStore = new MemoryKeyStore();
  try {
    const v1 = await Vault.open({ file, keyStore });
    await v1.put('ali', { token: 'x' });

    const raw = JSON.parse(await readFile(file, 'utf8'));
    const ct = Buffer.from(raw.entries.ali.ct, 'base64');
    ct[0] ^= 0xff;
    raw.entries.ali.ct = ct.toString('base64');
    await writeFile(file, JSON.stringify(raw), 'utf8');

    const v2 = await Vault.open({ file, keyStore });
    await assert.rejects(
      () => v2.get('ali'),
      (e: unknown) => e instanceof VaultError && (e as VaultError).code === 'E_DECRYPT',
    );
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('list() 不泄露任何凭据内容', async () => {
  const { dir, vault } = await freshVault();
  try {
    await vault.put('baidu', { cookie: 'SECRET' }, { account: 'u1' });
    const items = vault.list();
    assert.equal(items.length, 1);
    const dumped = JSON.stringify(items);
    assert.ok(!dumped.includes('SECRET'));
    assert.equal(items[0].providerId, 'baidu');
    assert.deepEqual(items[0].meta, { account: 'u1' });
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('delete 生效且幂等', async () => {
  const { dir, vault } = await freshVault();
  try {
    await vault.put('baidu', { cookie: 'a' });
    assert.equal(await vault.delete('baidu'), true);
    assert.equal(await vault.delete('baidu'), false);
    assert.equal(await vault.get('baidu'), null);
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('文件头不匹配时拒绝打开', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-vault-'));
  const file = join(dir, 'vault.json');
  try {
    await writeFile(file, JSON.stringify({ magic: 'evil', version: 1, entries: {} }));
    await assert.rejects(
      () => Vault.open({ file, keyStore: new MemoryKeyStore() }),
      (e: unknown) => e instanceof VaultError && (e as VaultError).code === 'E_FORMAT',
    );
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('主密钥丢失但保险箱有凭据时，必须显式报错而不是静默清空重建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-vault-'));
  const file = join(dir, 'vault.json');
  try {
    const ks = new MemoryKeyStore();
    const v1 = await Vault.open({ file, keyStore: ks });
    await v1.put('baidu', { cookie: 'precious' });

    // 模拟：系统凭据库被清空 / 换机，但配置文件还在
    const lostKeyStore = new MemoryKeyStore();
    await assert.rejects(
      () => Vault.open({ file, keyStore: lostKeyStore }),
      (e: unknown) => e instanceof VaultError && (e as VaultError).code === 'E_KEY_MISSING',
    );

    // 且原文件不能被动过
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(raw.entries.baidu, '原保险箱内容被破坏了');
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('空保险箱文件 + 无密钥：可以安全接管，不报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-vault-'));
  const file = join(dir, 'vault.json');
  try {
    await writeFile(file, JSON.stringify({ magic: MAGIC, version: 1, entries: {} }));
    const v = await Vault.open({ file, keyStore: new MemoryKeyStore() });
    assert.deepEqual(v.list(), []);
    await v.put('quark', { cookie: 'x' });
    assert.deepEqual(await v.get('quark'), { cookie: 'x' });
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('FileKeyStore：主密钥不落盘，重开可解出；换机器标识则解不开', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panhub-vault-'));
  const file = join(dir, 'vault.json');
  try {
    const ks1 = new FileKeyStore({ keyDir: dir, machineId: 'machine-A' });
    const v1 = await Vault.open({ file, keyStore: ks1 });
    await v1.put('115', { cookie: 'c1' });

    // 同一机器 → 能解
    const ks2 = new FileKeyStore({ keyDir: dir, machineId: 'machine-A' });
    const v2 = await Vault.open({ file, keyStore: ks2 });
    assert.deepEqual(await v2.get('115'), { cookie: 'c1' });

    // 换机器标识 → 主密钥解不开，明确报错而不是静默返回空
    const ks3 = new FileKeyStore({ keyDir: dir, machineId: 'machine-B' });
    await assert.rejects(
      () => Vault.open({ file, keyStore: ks3 }),
      (e: unknown) => e instanceof VaultError && (e as VaultError).code === 'E_KEY_UNWRAP',
    );

    // 主密钥文件里不应出现可用的裸密钥
    const wrapped = await readFile(join(dir, 'master.key.enc'));
    assert.equal(wrapped.length, 12 + 16 + 32);
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});
