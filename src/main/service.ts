/**
 * PanhubService —— 应用编排层
 *
 * 刻意不 import 任何 electron 模块：这样它能被 headless 测试完整覆盖，
 * Electron 主进程只负责把 KeyStore 和事件通道接进来。
 *
 * 职责：
 *  1. 保险箱：持有引擎管理密码等私密配置
 *  2. 引擎生命周期：启动 / 健康检查 / 优雅停止
 *  3. 引擎数据静态加密：config.json + data.db 落盘前加密，启动时解密
 *  4. 下载任务队列：把引擎直链交给多线程下载器
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { Vault, VaultError, type KeyStore } from '../core/vault.ts';
import { OpenListSidecar, SidecarError } from '../core/sidecar.ts';
import { OpenListClient, connectEngine, EngineApiError } from '../core/client.ts';
import { Downloader, DownloadError, type Progress } from '../core/downloader.ts';

/** 引擎数据里需要静态加密的文件（含网盘凭据、配置、JWT） */
const SECRET_FILES = ['config.json', 'data.db', 'data.db-wal', 'data.db-shm'];

/** 一次性会话目录前缀（系统临时目录下） */
const SESSION_PREFIX = 'panhub-engine-';

export interface ServiceOptions {
  /** 应用数据根目录 */
  appDataDir: string;
  /** 引擎可执行文件 */
  engineBin: string;
  /** 密钥保管后端（Electron 传 safeStorage 实现；测试传内存实现） */
  keyStore: KeyStore;
  /** 下载并发数，默认 8 */
  connections?: number;
  /** 引擎数据根目录，默认 <appDataDir>/engine */
  engineDataDir?: string;
}

export interface MountInput {
  mountPath: string;
  driver: string;
  addition: Record<string, unknown>;
  remark?: string;
}

export interface JobState {
  id: string;
  name: string;
  remotePath: string;
  destPath: string;
  total: number;
  downloaded: number;
  percent: number;
  speedBps: number;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  error?: string;
}

export interface ServiceStatus {
  engineRunning: boolean;
  engineUrl: string | null;
  initialized: boolean;
  accounts: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 进程是否还活着（EPERM 表示存在但无权限，仍算活着） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Windows 上进程刚退出时句柄释放有延迟，读写会短暂 EBUSY/EPERM */
function isBusyError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}

/**
 * 对敏感文件的加密与删除必须重试到成功 ——
 * 单次 EBUSY 失败会让明文凭据永久留在磁盘上，这是安全底线问题。
 */
async function retryBusy<T>(fn: () => Promise<T>, attempts = 15, delayMs = 150): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isBusyError(e)) throw e;
      await sleep(delayMs);
    }
  }
  throw last;
}

export class PanhubService extends EventEmitter {
  private readonly opts: Required<Omit<ServiceOptions, 'keyStore'>> & { keyStore: KeyStore };
  private vault: Vault | null = null;
  private sidecar: OpenListSidecar | null = null;
  private client: OpenListClient | null = null;
  private readonly downloader = new Downloader();
  private jobs = new Map<string, JobState>();
  private aborters = new Map<string, AbortController>();
  /** 本次会话的一次性引擎工作目录（明文只在这里出现） */
  private sessionDir: string | null = null;

  constructor(opts: ServiceOptions) {
    super();
    this.opts = {
      engineDataDir: join(opts.appDataDir, 'engine'),
      connections: 8,
      ...opts,
    } as never;
  }

  // ---------------- 保险箱 ----------------

  private get vaultFile(): string {
    return join(this.opts.appDataDir, 'vault.json');
  }

  /**
   * 开始一次会话：在系统临时目录里新建一个一次性工作目录。
   *
   * 为什么不直接用 appDataDir/engine：
   * 引擎退出时 Windows 常仍有别的句柄（杀软扫描、索引器）占着 data.db，
   * 删除可能长时间失败。与其在「能否删掉」上赌博，不如让**永久目录里
   * 从不出现明文**：明文只存在于本次会话的临时目录，退出时封盘并尽力清理，
   * 清不掉的残留会在下次启动时统一清扫。
   */
  private async beginSession(): Promise<string> {
    await this.purgeStaleSessions();
    // 目录名带 pid：清扫时据此判断归属，绝不误删仍在运行实例的目录
    const dir = await mkdtemp(join(tmpdir(), `${SESSION_PREFIX}${process.pid}-`));
    this.sessionDir = dir;
    return dir;
  }

  /**
   * 清理历史遗留的会话目录。
   *
   * 安全约束：只删「拥有者进程已不存在」的目录。
   * 早期实现只按前缀删除，结果会误删另一个正在运行实例的工作目录，
   * 直接导致对方引擎启动失败（Access is denied）。
   */
  async purgeStaleSessions(): Promise<void> {
    const base = tmpdir();
    let names: string[] = [];
    try {
      names = await readdir(base);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.startsWith(SESSION_PREFIX)) continue;
      const p = join(base, n);
      if (p === this.sessionDir) continue;

      const rest = n.slice(SESSION_PREFIX.length);
      const dash = rest.indexOf('-');
      const pidStr = dash >= 0 ? rest.slice(0, dash) : '';
      const pid = Number(pidStr);

      if (Number.isInteger(pid) && pid > 0) {
        if (pid === process.pid) continue; // 自己的
        if (isPidAlive(pid)) continue; // 另一个仍在运行的实例，别碰
      } else {
        // 无法判定归属（旧版命名）：只在明显陈旧时才删
        const ageMs = Date.now() - (await stat(p).then((s) => s.mtimeMs).catch(() => 0));
        if (ageMs < 2 * 60 * 60 * 1000) continue;
      }

      await rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async endSession(): Promise<void> {
    const dir = this.sessionDir;
    this.sessionDir = null;
    if (!dir) return;
    // 多次尝试：杀软/索引器释放句柄有延迟
    for (let i = 0; i < 10; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // 仍失败就留着，下次启动由 purgeStaleSessions 清理
    this.emit(
      'warn',
      `临时工作目录未能删除，将在下次启动时自动清理：${dir}`,
    );
  }

  async openVault(): Promise<Vault> {
    if (this.vault) return this.vault;
    await mkdir(this.opts.appDataDir, { recursive: true });
    this.vault = await Vault.open({
      file: this.vaultFile,
      keyStore: this.opts.keyStore,
    });
    return this.vault;
  }

  // ---------------- 引擎数据静态加密 ----------------

  /**
   * 把引擎目录里的敏感文件加密进保险箱，并删除明文。
   * 调用前必须确保引擎已停止，否则读到的是一致性未保证的文件。
   *
   * 返回未能清除的明文文件列表（正常应为空）。单个文件失败不中断整批，
   * 因为「已经封好 3 个」比「遇到 1 个失败就全放弃」安全得多。
   */
  async sealEngineData(): Promise<string[]> {
    const vault = await this.openVault();
    const dir = this.opts.engineDataDir;
    if (!existsSync(dir)) return [];
    const trace = process.env.PANHUB_DEBUG_SEAL === '1';
    const log = (m: string) => {
      if (trace) process.stderr.write(`[seal] ${m}\n`);
    };

    let leftovers: string[] = [];

    // 多轮封盘：实测引擎在退出的最后时刻会做一次 SQLite checkpoint，
    // 把已经删掉的 data.db 重新写回来。单轮删除看起来成功，文件却复活。
    // 因此每轮结束后重新检查，发现复活就再封一次（最多 4 轮）。
    for (let round = 1; round <= 4; round++) {
      leftovers = [];
      for (const name of [...SECRET_FILES, 'admin.json']) {
        const src = join(dir, name);
        if (!existsSync(src)) continue;
        log(`第${round}轮 ${name}: 存在，处理中`);

        let buf: Buffer;
        try {
          buf = await retryBusy(() => readFile(src), 40, 250);
        } catch (e) {
          log(`第${round}轮 ${name}: 读取失败 ${(e as Error).message}`);
          leftovers.push(`${name}（读取失败：${(e as Error).message}）`);
          continue;
        }

        // 先落密文，再删明文：顺序反了会在崩溃时丢数据
        await vault.put(
          `engine:${name}`,
          { b64: buf.toString('base64'), size: buf.length },
          { file: name },
        );

        try {
          await retryBusy(() => rm(src, { force: true }), 40, 250);
          log(`第${round}轮 ${name}: 已入保险箱并删除明文`);
        } catch (e) {
          log(`第${round}轮 ${name}: 删除失败 ${(e as Error).message}`);
          leftovers.push(`${name}（删除失败：${(e as Error).message}）`);
        }
      }

      // 等一段足够长的时间，观察是否有文件被引擎临死前的写入复活。
      // 实测 250ms 太短：检查时文件确实不在，但进程完全退出后才出现，
      // 说明写入发生在退出流程更后段。这里给 1.5 秒。
      await new Promise((r) => setTimeout(r, 1500));
      const reappeared = [...SECRET_FILES, 'admin.json'].filter((n) =>
        existsSync(join(dir, n)),
      );
      if (reappeared.length === 0) {
        log(`第${round}轮结束：明文已全部清除`);
        return [];
      }
      log(`第${round}轮结束：仍有 ${reappeared.join(',')} 存在，再来一轮`);
    }

    if (leftovers.length > 0) {
      this.emit(
        'warn',
        `以下引擎数据未能从磁盘清除明文：${leftovers.join('；')}。` +
          `内容已加密存入保险箱，但明文副本仍在磁盘上，建议手动删除。`,
      );
    } else {
      this.emit('warn', '引擎数据仍残留在磁盘上，已加密入库，但明文未能清除。');
    }
    return leftovers.length > 0 ? leftovers : [...SECRET_FILES];
  }

  /** 解密还原引擎数据（启动引擎前调用） */
  async unsealEngineData(): Promise<void> {
    const vault = await this.openVault();
    const dir = this.opts.engineDataDir;
    await mkdir(dir, { recursive: true });
    for (const name of [...SECRET_FILES, 'admin.json']) {
      const id = `engine:${name}`;
      if (!(await vault.has(id))) continue;
      const secret = (await vault.get(id)) as { b64: string } | null;
      if (!secret?.b64) continue;
      const dst = join(dir, name);
      const tmp = `${dst}.unseal.tmp`;
      await writeFile(tmp, Buffer.from(secret.b64, 'base64'), { mode: 0o600 });
      await rename(tmp, dst);
    }
  }

  /** 清空引擎数据（重置账号，需用户显式确认） */
  async wipeEngineData(): Promise<void> {
    const vault = await this.openVault();
    await this.stopEngine();
    // 会话目录 + 历史遗留目录都清掉
    await this.purgeStaleSessions();
    const dir = this.opts.engineDataDir;
    if (existsSync(dir)) {
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const f of files) {
        await rm(join(dir, f), { recursive: true, force: true }).catch(() => {});
      }
    }
    for (const name of [...SECRET_FILES, 'admin.json']) {
      await vault.delete(`engine:${name}`).catch(() => {});
    }
  }

  /** 生成并保管引擎管理密码（首次安装时） */
  private async ensureAdminPassword(): Promise<string> {
    const vault = await this.openVault();
    const existing = (await vault.get('engine:admin')) as { password?: string } | null;
    if (existing?.password) return existing.password;
    const password = randomBytes(24).toString('base64url');
    await vault.put('engine:admin', { username: 'admin', password }, { note: '引擎管理凭据' });
    return password;
  }

  // ---------------- 引擎生命周期 ----------------

  async startEngine(): Promise<{ url: string }> {
    if (this.sidecar?.running && this.client) {
      return { url: this.sidecar.info!.baseUrl };
    }

    // 每次启动用全新的临时会话目录，明文绝不落到永久目录
    const sessionDir = await this.beginSession();
    this.opts.engineDataDir = sessionDir;

    await this.unsealEngineData();

    this.sidecar = new OpenListSidecar({
      binPath: this.opts.engineBin,
      dataDir: sessionDir,
    });
    const info = await this.sidecar.start(60_000);

    const password = await this.ensureAdminPassword();
    try {
      this.client = await connectEngine({
        baseUrl: info.baseUrl,
        username: 'admin',
        password,
      });
    } catch (e) {
      await this.stopEngine();
      if (e instanceof VaultError) throw e;
      throw new Error(
        `无法连接到本地引擎：${(e as Error).message}。` +
          `如果这是升级后首次启动，可能需要重置本地引擎数据。`,
      );
    }
    this.emit('engine', { running: true, url: info.baseUrl });
    return { url: info.baseUrl };
  }

  async stopEngine(): Promise<void> {
    try {
      await this.sidecar?.stop();
    } finally {
      this.sidecar = null;
      this.client = null;
      this.emit('engine', { running: false, url: null });
    }
    // 先封盘（明文内容进保险箱），再尽力清掉一次性目录
    await this.sealEngineData().catch((e) => {
      this.emit('warn', `引擎数据加密失败：${(e as Error).message}`);
    });
    await this.endSession();
  }

  async status(): Promise<ServiceStatus> {
    let accounts = 0;
    if (this.client) {
      try {
        accounts = (await this.client.storages()).length;
      } catch {
        accounts = 0;
      }
    }
    return {
      engineRunning: Boolean(this.sidecar?.running),
      engineUrl: this.sidecar?.info?.baseUrl ?? null,
      initialized: Boolean(this.vault),
      accounts,
    };
  }

  private needClient(): OpenListClient {
    if (!this.client) throw new Error('引擎尚未启动');
    return this.client;
  }

  // ---------------- 账号 / 存储 ----------------

  async driverCatalog(): Promise<Record<string, unknown>> {
    return await this.needClient().drivers();
  }

  async listMounts() {
    return await this.needClient().storages();
  }

  async addMount(input: MountInput): Promise<void> {
    await this.needClient().createStorage({
      mount_path: input.mountPath,
      driver: input.driver,
      addition: input.addition,
      remark: input.remark,
    });
  }

  async removeMount(id: number): Promise<void> {
    await this.needClient().deleteStorage(id);
  }

  async browse(path: string) {
    return await this.needClient().list(path);
  }

  // ---------------- 下载 ----------------

  async enqueueDownload(remotePath: string, destDir: string): Promise<JobState> {
    const client = this.needClient();
    const meta = await client.get(remotePath);
    if (meta.is_dir) {
      throw new Error('暂不支持整目录下载，请选择具体文件');
    }
    if (!meta.raw_url) {
      throw new Error('引擎未返回直链（可能是该网盘限制或需要重新登录）');
    }

    const id = randomBytes(8).toString('hex');
    const destPath = join(destDir, meta.name);
    const job: JobState = {
      id,
      name: meta.name,
      remotePath,
      destPath,
      total: meta.size,
      downloaded: 0,
      percent: 0,
      speedBps: 0,
      status: 'queued',
    };
    this.jobs.set(id, job);
    this.emit('job', { ...job });

    const ac = new AbortController();
    this.aborters.set(id, ac);

    void (async () => {
      // 让出一次微任务：保证 enqueueDownload 返回给调用方的一定是 queued 快照，
      // 状态迁移从下一拍开始。否则「返回值刚拿到就已变成 running」。
      await Promise.resolve();
      job.status = 'running';
      this.emit('job', { ...job });
      try {
        const r = await this.downloader.download({
          url: meta.raw_url!,
          dest: destPath,
          // 刻意不传 meta.size：引擎 API 报的大小可能与实际 HTTP 响应不一致
          // （实测 Local 驱动对 12 字节文件报 8192），必须以真实
          // Content-Range / Content-Length 为准，否则分片规划会整体错位。
          connections: this.opts.connections,
          signal: ac.signal,
          onProgress: (p: Progress) => {
            job.downloaded = p.downloaded;
            job.total = p.total;
            job.percent = p.percent;
            job.speedBps = p.speedBps;
            this.emit('job', { ...job });
          },
        });
        job.status = 'done';
        job.downloaded = r.bytes;
        job.total = r.bytes;
        job.percent = 100;
        this.emit('job', { ...job });
      } catch (e) {
        if (e instanceof DownloadError && e.code === 'E_ABORTED') {
          job.status = 'cancelled';
        } else {
          job.status = 'failed';
          job.error = (e as Error).message;
        }
        this.emit('job', { ...job });
      } finally {
        this.aborters.delete(id);
      }
    })();

    // 返回快照而不是活引用：否则调用方手里的对象会被后台任务就地改写，
    // 出现「刚返回就被改成 running」这种不可预期的竞态。
    return { ...job };
  }

  cancelJob(id: string): boolean {
    const ac = this.aborters.get(id);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  listJobs(): JobState[] {
    return [...this.jobs.values()].sort((a, b) => b.id.localeCompare(a.id));
  }

  // ---------------- 关闭 ----------------

  async dispose(): Promise<void> {
    for (const ac of this.aborters.values()) ac.abort();
    this.aborters.clear();
    await this.stopEngine().catch(() => {});
    this.vault?.destroy();
    this.vault = null;
    this.removeAllListeners();
  }
}

export { SidecarError, EngineApiError, VaultError };
