/**
 * 凭据保险箱 —— 本地加密存储网盘登录态
 *
 * 设计要点：
 *  1. 主密钥由「密钥保管后端」持有，永不落盘：桌面端用 Electron safeStorage
 *     （Windows DPAPI / macOS Keychain / Linux KWallet-libsecret），headless 端
 *     退化为 scrypt(机器标识 + 随机 salt)，salt 落盘但主密钥不落盘。
 *  2. 每条凭据用 AES-256-GCM 独立加密，AAD 绑定 providerId。
 *     → 攻击者即使拿到密文，也无法把 A 网盘的密文替换成 B 网盘的（防替换攻击）。
 *  3. 落盘用「临时文件 + 原子 rename」，避免写一半断电导致整个保险箱报废。
 *  4. 文件权限 0600。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MAGIC = 'panhub-vault';
export const VERSION = 1;
export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 密钥保管后端：只负责「安全地取/存 32 字节主密钥」，不关心业务 */
export interface KeyStore {
  readonly kind: string;
  load(): Promise<Buffer | null>;
  save(key: Buffer): Promise<void>;
}

/** 单条密文凭据 */
export interface SealedEntry {
  iv: string;
  tag: string;
  ct: string;
  /** 明文的非敏感元数据，便于 UI 展示而不必解密 */
  meta?: Record<string, unknown>;
  updatedAt: number;
}

export interface VaultFile {
  magic: string;
  version: number;
  entries: Record<string, SealedEntry>;
}

/** 对外暴露的条目（不含密文） */
export interface VaultSummary {
  providerId: string;
  updatedAt: number;
  meta?: Record<string, unknown>;
}

export class VaultError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/**
 * 文件型密钥后端 —— 给 headless 环境（服务器 / CI / Linux 无 libsecret）兜底。
 *
 * 它解决不了「本地攻击者拿得到 root」这种威胁，但能防住：
 *   - 明文凭据被随手拷走（配置目录里没有可用明文）
 *   - 配置被同步到云盘 / 被 git 提交后泄露（同步出去的是密文）
 */
export class FileKeyStore implements KeyStore {
  readonly kind = 'file-scrypt';
  private readonly keyFile: string;
  private readonly saltFile: string;
  private readonly machineId: string;

  constructor(opts: { keyDir: string; machineId?: string }) {
    this.keyFile = `${opts.keyDir}/master.key.enc`;
    this.saltFile = `${opts.keyDir}/master.salt`;
    this.machineId = opts.machineId ?? 'panhub-default-machine';
  }

  async load(): Promise<Buffer | null> {
    let wrapped: Buffer;
    let salt: Buffer;
    try {
      wrapped = await readFile(this.keyFile);
      salt = await readFile(this.saltFile);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    // 包裹格式：iv(12) | tag(16) | ct(32)
    if (wrapped.length !== IV_BYTES + TAG_BYTES + KEY_BYTES) {
      throw new VaultError('E_KEY_CORRUPT', '主密钥文件损坏');
    }
    const wrapKey = this.deriveWrapKey(salt);
    const iv = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = wrapped.subarray(IV_BYTES + TAG_BYTES);
    try {
      const d = createDecipheriv('aes-256-gcm', wrapKey, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    } catch {
      // 机器标识变了（换盘/重装/克隆到别的机器）→ 解不开是预期行为
      throw new VaultError(
        'E_KEY_UNWRAP',
        '主密钥无法解开：机器身份已变化。请重新登录各网盘账号。',
      );
    }
  }

  async save(key: Buffer): Promise<void> {
    if (key.length !== KEY_BYTES) {
      throw new VaultError('E_KEY_LEN', `主密钥必须是 ${KEY_BYTES} 字节`);
    }
    await mkdir(dirname(this.keyFile), { recursive: true });
    const salt = randomBytes(16);
    const wrapKey = this.deriveWrapKey(salt);
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv('aes-256-gcm', wrapKey, iv);
    const ct = Buffer.concat([c.update(key), c.final()]);
    const tag = c.getAuthTag();
    await atomicWrite(this.saltFile, salt, 0o600);
    await atomicWrite(this.keyFile, Buffer.concat([iv, tag, ct]), 0o600);
  }

  private deriveWrapKey(salt: Buffer): Buffer {
    return scryptSync(this.machineId, salt, KEY_BYTES, { N: 16384, r: 8, p: 1 });
  }
}

/** 内存型密钥后端 —— 只用于测试 */
export class MemoryKeyStore implements KeyStore {
  readonly kind = 'memory';
  private key: Buffer | null = null;
  constructor(initial?: Buffer) {
    this.key = initial ?? null;
  }
  async load(): Promise<Buffer | null> {
    return this.key;
  }
  async save(key: Buffer): Promise<void> {
    this.key = Buffer.from(key);
  }
}

export class Vault {
  private key: Buffer;
  private doc: VaultFile;
  private readonly file: string;
  private readonly keyStore: KeyStore;

  private constructor(key: Buffer, doc: VaultFile, file: string, keyStore: KeyStore) {
    this.key = key;
    this.doc = doc;
    this.file = file;
    this.keyStore = keyStore;
  }

  /** 打开（或初始化）保险箱 */
  static async open(opts: { file: string; keyStore: KeyStore }): Promise<Vault> {
    let key = await opts.keyStore.load();

    // 先看场上有没有存量保险箱
    let raw: string | null = null;
    try {
      raw = await readFile(opts.file, 'utf8');
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    let doc: VaultFile = { magic: MAGIC, version: VERSION, entries: {} };
    if (raw !== null) {
      // 文件存在就先校验结构：文件损坏要立刻报错，不能装作没看见
      doc = Vault.parse(raw);
    }

    if (!key) {
      // 有凭据但本机主密钥丢了 —— 这是数据丢失，必须显式报错，
      // 绝不能静默重建把用户已保存的所有登录态覆盖掉。
      const n = Object.keys(doc.entries).length;
      if (n > 0) {
        throw new VaultError(
          'E_KEY_MISSING',
          `保险箱中有 ${n} 个网盘的凭据，但本机主密钥不存在`
            + `（可能重装了系统 / 换了机器 / 清空了系统凭据库）。`
            + `如确认要放弃这些凭据并重新登录，请显式重置保险箱。`,
        );
      }
      key = randomBytes(KEY_BYTES);
      await opts.keyStore.save(key);
    }
    if (key.length !== KEY_BYTES) {
      throw new VaultError('E_KEY_LEN', '密钥后端返回了错误长度');
    }
    return new Vault(key, doc, opts.file, opts.keyStore);
  }

  static parse(raw: string): VaultFile {
    let doc: VaultFile;
    try {
      doc = JSON.parse(raw) as VaultFile;
    } catch {
      throw new VaultError('E_FORMAT', '保险箱文件不是合法 JSON');
    }
    if (doc.magic !== MAGIC) throw new VaultError('E_FORMAT', '保险箱文件头不匹配');
    if (doc.version !== VERSION) {
      throw new VaultError('E_VERSION', `不支持的保险箱版本 ${doc.version}`);
    }
    if (!doc.entries || typeof doc.entries !== 'object') {
      throw new VaultError('E_FORMAT', '保险箱缺少 entries');
    }
    return doc;
  }

  /** 存入一条凭据（明文只在本次调用内存在） */
  async put(
    providerId: string,
    secret: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    if (!providerId) throw new VaultError('E_ARG', 'providerId 不能为空');
    const plaintext = Buffer.from(JSON.stringify(secret), 'utf8');
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    // AAD 绑定 providerId —— 防止密文跨条目替换
    c.setAAD(Buffer.from(providerId, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    const tag = c.getAuthTag();
    plaintext.fill(0);

    this.doc.entries[providerId] = {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
      meta,
      updatedAt: Date.now(),
    };
    await this.flush();
  }

  /** 取出一条凭据 */
  async get(providerId: string): Promise<Record<string, unknown> | null> {
    const e = this.doc.entries[providerId];
    if (!e) return null;
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(e.iv, 'base64'));
    d.setAAD(Buffer.from(providerId, 'utf8'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    let out: Buffer;
    try {
      out = Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]);
    } catch {
      throw new VaultError(
        'E_DECRYPT',
        `「${providerId}」凭据解密失败：文件被篡改，或密钥已更换`,
      );
    }
    try {
      return JSON.parse(out.toString('utf8')) as Record<string, unknown>;
    } finally {
      out.fill(0);
    }
  }

  async has(providerId: string): Promise<boolean> {
    return Boolean(this.doc.entries[providerId]);
  }

  /** 列出已保存的网盘（不含任何密文/明文凭据） */
  list(): VaultSummary[] {
    return Object.entries(this.doc.entries)
      .map(([providerId, e]) => ({
        providerId,
        updatedAt: e.updatedAt,
        meta: e.meta,
      }))
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  async delete(providerId: string): Promise<boolean> {
    if (!this.doc.entries[providerId]) return false;
    delete this.doc.entries[providerId];
    await this.flush();
    return true;
  }

  async clear(): Promise<void> {
    this.doc.entries = {};
    await this.flush();
  }

  /** 原子落盘 */
  private async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const body = JSON.stringify(this.doc, null, 2);
    await atomicWrite(this.file, Buffer.from(body, 'utf8'), 0o600);
  }

  /** 擦除内存中的主密钥（退出时调用；之后本实例不可再用） */
  destroy(): void {
    this.key.fill(0);
    this.doc.entries = {};
  }
}

async function atomicWrite(file: string, data: Buffer | string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, { mode });
  try {
    await chmod(tmp, mode);
  } catch {
    /* Windows 上 chmod 语义有限，忽略 */
  }
  try {
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
