/**
 * Electron safeStorage 版密钥后端
 *
 * 主密钥交给操作系统的凭据保护机制：
 *   Windows → DPAPI（绑定当前用户账户）
 *   macOS   → Keychain
 *   Linux   → libsecret / KWallet
 *
 * 落盘的只是一个 safeStorage 加密后的 blob，其它进程/其它用户无法解开。
 *
 * 注意：Electron 45 起同步 API（isEncryptionAvailable / encryptString /
 * decryptString）已标记弃用，优先使用 Async 变体，仅在缺失时回退。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KeyStore } from '../core/vault.ts';

interface SafeStorageLike {
  isEncryptionAvailable?(): boolean;
  encryptString?(plainText: string): Buffer;
  decryptString?(encrypted: Buffer): string;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  encryptStringAsync?(plainText: string): Promise<Buffer>;
  decryptStringAsync?(encrypted: Buffer): Promise<string>;
}

export class SafeStorageKeyStore implements KeyStore {
  readonly kind = 'electron-safeStorage';
  private readonly file: string;
  private readonly ss: SafeStorageLike;

  constructor(file: string, safeStorage: SafeStorageLike) {
    this.file = file;
    this.ss = safeStorage;
  }

  private async available(): Promise<boolean> {
    if (this.ss.isAsyncEncryptionAvailable) {
      try {
        return await this.ss.isAsyncEncryptionAvailable();
      } catch {
        /* 落到同步 */
      }
    }
    return this.ss.isEncryptionAvailable?.() ?? false;
  }

  /**
   * Electron 45 起同步 API 已弃用，优先用 Async 变体；
   * 但 Async 变体的实际入参契约在不同小版本间并不稳定
   * （实测可能抛 "first argument must be of type string or Buffer"），
   * 因此失败时回退到仍可用的同步接口，保证功能不因弃用而中断。
   */
  private async encrypt(text: string): Promise<Buffer> {
    if (this.ss.encryptStringAsync) {
      try {
        const r = await this.ss.encryptStringAsync(text);
        if (Buffer.isBuffer(r)) return r;
      } catch {
        /* 回退 */
      }
    }
    if (this.ss.encryptString) return this.ss.encryptString(text);
    throw new Error('当前 Electron 版本不提供可用的加密接口');
  }

  private async decrypt(blob: Buffer): Promise<string> {
    if (this.ss.decryptStringAsync) {
      try {
        const r = await this.ss.decryptStringAsync(blob);
        if (typeof r === 'string') return r;
      } catch {
        /* 回退 */
      }
    }
    if (this.ss.decryptString) return this.ss.decryptString(blob);
    throw new Error('当前 Electron 版本不提供可用的解密接口');
  }

  async load(): Promise<Buffer | null> {
    if (!(await this.available())) {
      throw new Error(
        '系统凭据加密不可用（Windows DPAPI / macOS Keychain / Linux libsecret），' +
          '无法安全保存登录状态。请检查系统环境后重试。',
      );
    }
    let blob: Buffer;
    try {
      blob = await readFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const b64 = await this.decrypt(blob);
    const key = Buffer.from(b64, 'base64');
    return key.length === 32 ? key : null;
  }

  async save(key: Buffer): Promise<void> {
    if (!(await this.available())) {
      throw new Error('系统凭据加密不可用，拒绝以明文形式保存主密钥');
    }
    await mkdir(dirname(this.file), { recursive: true });
    const enc = await this.encrypt(key.toString('base64'));
    await writeFile(this.file, enc, { mode: 0o600 });
  }
}
