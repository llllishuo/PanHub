/**
 * OpenList 引擎进程管理
 *
 * 安全基线（不是可选项）：
 *  1. 只绑 127.0.0.1 —— 引擎默认绑 0.0.0.0，等于把「已登录的所有网盘」
 *     连同管理接口暴露给整个局域网。这里必须覆盖。
 *  2. 每次安装生成独立 jwt_secret，不用引擎默认的固定值。
 *  3. ftp / sftp / s3 / mcp 全部关掉，只留 HTTP。
 *  4. 端口由我们探测空闲端口决定，避免固定端口被别的程序占用或预测。
 *  5. 管理密码随机生成，不落磁盘明文（走 vault）。
 *
 * 不做的事：不启动引擎自带的 Web UI（dist_dir 留空亦可，引擎内置打包的
 * 前端会响应，但我们不对局域网暴露，所以没有实际风险面）。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join } from 'node:path';

export interface SidecarOptions {
  /** openlist 可执行文件路径 */
  binPath: string;
  /** 数据目录（config.json / data.db / log 都在这里） */
  dataDir: string;
  /** 指定端口；不传则自动探测空闲端口 */
  port?: number;
  /** 默认 127.0.0.1，不要改成 0.0.0.0 */
  host?: string;
  /** JWT 密钥；不传则自动生成随机值 */
  jwtSecret?: string;
  /** 额外的日志行回调 */
  onLog?: (line: string) => void;
}

export interface StartedInfo {
  baseUrl: string;
  port: number;
  host: string;
}

export class SidecarError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SidecarError';
    this.code = code;
  }
}

/** 仅当 PANHUB_DEBUG_SIDECAR=1 时输出生命周期日志，便于排查进程泄漏 */
function dbg(what: string, pid?: number, extra?: string): void {
  if (process.env.PANHUB_DEBUG_SIDECAR !== '1') return;
  process.stderr.write(`[sidecar] ${what} pid=${pid ?? '?'} ${extra ?? ''}\n`);
}

/** 进程是否还活着（EPERM 表示存在但无权限，仍算活着） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 轮询等待进程消失 */
async function waitPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}

/** 强杀整个进程树（引擎不会派生孙进程，但要防万一） */
function forceKillTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    /* ignore */
  }
}

/** 找一个空闲端口 */
export async function pickFreePort(host = '127.0.0.1'): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 生成一份安全的引擎配置 */
export function buildConfig(opts: {
  dataDir: string;
  port: number;
  host: string;
  jwtSecret: string;
}): Record<string, unknown> {
  const { dataDir, port, host, jwtSecret } = opts;
  const dataDb = join(dataDir, 'data.db');
  return {
    force: false,
    site_url: '',
    cdn: '',
    jwt_secret: jwtSecret,
    token_expires_in: 48,
    database: {
      type: 'sqlite3',
      host: '',
      port: 0,
      user: '',
      password: '',
      name: '',
      db_file: dataDb,
      table_prefix: 'x_',
      ssl_mode: '',
      dsn: '',
    },
    scheme: {
      address: host,
      http_port: port,
      https_port: -1,
      force_https: false,
      cert_file: '',
      key_file: '',
      unix_file: '',
      unix_file_perm: '',
      enable_h2c: false,
      enable_h3: false,
    },
    temp_dir: join(dataDir, 'temp'),
    bleve_dir: join(dataDir, 'bleve'),
    dist_dir: '',
    log: {
      enable: true,
      name: join(dataDir, 'log', 'log.log'),
      max_size: 20,
      max_backups: 3,
      max_age: 7,
      compress: false,
      filter: { enable: false, filters: [] },
    },
    delayed_start: 0,
    auto_memory_limit: 4,
    min_free_memory: 0,
    max_block_limit: 0,
    max_connections: 0,
    max_concurrency: 64,
    tls_insecure_skip_verify: false,
    tasks: {
      download: { workers: 5, max_retry: 1, task_persistant: false },
      transfer: { workers: 5, max_retry: 2, task_persistant: false },
      upload: { workers: 5, max_retry: 0, task_persistant: false },
      copy: { workers: 5, max_retry: 2, task_persistant: false },
      move: { workers: 5, max_retry: 2, task_persistant: false },
      decompress: { workers: 5, max_retry: 2, task_persistant: false },
      decompress_upload: { workers: 5, max_retry: 2, task_persistant: false },
      allow_retry_canceled: false,
    },
    cors: { allow_origins: ['http://127.0.0.1'], allow_methods: ['*'], allow_headers: ['*'] },
    s3: { enable: false, port: 0, ssl: false, multipart_ttl: '24h' },
    ftp: {
      enable: false,
      listen: '',
      find_pasv_port_attempts: 50,
      active_transfer_port_non_20: false,
      idle_timeout: 900,
      connection_timeout: 30,
      disable_active_mode: false,
      default_transfer_binary: false,
      enable_active_conn_ip_check: true,
      enable_pasv_conn_ip_check: true,
    },
    sftp: { enable: false, listen: '' },
    mcp: { enable: false },
    last_launched_version: '',
    proxy_address: '',
  };
}

export class OpenListSidecar {
  private child: ChildProcess | null = null;
  private readonly opts: Required<Pick<SidecarOptions, 'binPath' | 'dataDir' | 'host'>> &
    SidecarOptions;
  private startedInfo: StartedInfo | null = null;
  private logBuf: string[] = [];

  constructor(opts: SidecarOptions) {
    this.opts = {
      host: opts.host ?? '127.0.0.1',
      ...opts,
    } as never;
  }

  get info(): StartedInfo | null {
    return this.startedInfo;
  }

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** 最近若干行引擎日志，便于诊断 */
  recentLog(n = 40): string[] {
    return this.logBuf.slice(-n);
  }

  async start(timeoutMs = 45_000): Promise<StartedInfo> {
    if (this.running) throw new SidecarError('E_ALREADY', '引擎已在运行');

    try {
      await access(this.opts.binPath, FS.X_OK);
    } catch {
      // Windows 上 X_OK 语义不可靠，退化为存在性检查
      try {
        await access(this.opts.binPath, FS.F_OK);
      } catch {
        throw new SidecarError('E_NOBIN', `找不到引擎可执行文件：${this.opts.binPath}`);
      }
    }

    await mkdir(this.opts.dataDir, { recursive: true });

    const host = this.opts.host!;
    const port = this.opts.port ?? (await pickFreePort(host));
    const jwtSecret = this.opts.jwtSecret ?? randomBytes(24).toString('hex');

    const cfg = buildConfig({ dataDir: this.opts.dataDir, port, host, jwtSecret });
    const cfgPath = join(this.opts.dataDir, 'config.json');

    // 已有配置时保留其 jwt_secret，避免重启后所有 token 失效
    let finalCfg = cfg;
    try {
      const prev = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
      if (typeof prev.jwt_secret === 'string' && prev.jwt_secret.length >= 16 && !this.opts.jwtSecret) {
        finalCfg = { ...cfg, jwt_secret: prev.jwt_secret };
      }
    } catch {
      /* 没有旧配置就用新的 */
    }
    await writeFile(cfgPath, JSON.stringify(finalCfg, null, 2), 'utf8');

    const child = spawn(this.opts.binPath, ['server', '--data', this.opts.dataDir, '--log-std'], {
      // 关键：不要把「数据目录」当成子进程的 CWD。
      // Windows 下进程的当前目录会锁住该目录，导致引擎退出后仍无法删除 /
      // 重置数据目录（EBUSY）。所有路径我们都传绝对值，CWD 用什么无所谓。
      cwd: tmpdir(),
      env: {
        // 只给必要环境变量，避免把宿主的代理/密钥泄给引擎
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        TEMP: process.env.TEMP ?? '',
        TMP: process.env.TMP ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    dbg('spawn', child.pid, this.opts.dataDir);

    const push = (s: string) => {
      for (const line of s.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logBuf.push(line);
        if (this.logBuf.length > 500) this.logBuf.shift();
        this.opts.onLog?.(line);
      }
    };
    child.stdout?.on('data', (b: Buffer) => push(b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => push(b.toString('utf8')));

    const exited = new Promise<never>((_, reject) => {
      child.once('exit', (code, sig) => {
        if (this.startedInfo) return;
        reject(
          new SidecarError(
            'E_EXIT',
            `引擎启动即退出（code=${code} signal=${sig}）：${this.recentLog(10).join(' | ')}`,
          ),
        );
      });
    });

    const baseUrl = `http://${host}:${port}`;
    await Promise.race([this.waitHealthy(baseUrl, timeoutMs), exited]);
    // 启动已成功：此后进程若退出，不该冒出一个未处理的 Promise 拒绝
    // （未处理拒绝在 Node 里会直接终止进程，属于会静默杀死应用的隐患）
    exited.catch(() => {});

    this.startedInfo = { baseUrl, port, host };
    return this.startedInfo;
  }

  private async waitHealthy(baseUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/ping`, { signal: AbortSignal.timeout(2000) });
        const text = (await res.text()).trim();
        if (res.ok && /pong/i.test(text)) return;
        lastErr = `HTTP ${res.status} body=${text.slice(0, 40)}`;
      } catch (e) {
        lastErr = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new SidecarError('E_TIMEOUT', `引擎在 ${timeoutMs}ms 内未就绪：${lastErr}`);
  }

  /**
   * 停止引擎。
   *
   * 不用 child.once('exit') 作为唯一判据 —— 实测在密集启停时该事件可能不按时到达，
   * 导致 stop() 一律走 5 秒超时、进程也会残留。这里改为：
   *   1) 先发 SIGTERM
   *   2) 按 pid 轮询确认进程真的消失（process.kill(pid,0) 抛错即为消失）
   *   3) 没消失就强杀整个进程树，再轮询一次
   */
  async stop(): Promise<void> {
    const child = this.child;
    this.startedInfo = null;
    if (!child) return;
    this.child = null;

    const pid = child.pid;
    // 主动释放管道，否则挂起的 PipeWrap 会拖住事件循环
    child.stdout?.destroy();
    child.stderr?.destroy();

    if (pid === undefined) return;

    if (isPidAlive(pid)) {
      dbg('stop-term', pid);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      if (!(await waitPidGone(pid, 3000))) {
        dbg('stop-force', pid);
        forceKillTree(pid);
        if (!(await waitPidGone(pid, 4000))) {
          dbg('stop-still-alive', pid);
          throw new SidecarError('E_STOP', `引擎进程 ${pid} 无法终止`);
        }
      }
    }
    // 解除对事件循环的绑定：进程已确认消失，句柄不应继续拖住宿主退出
    try {
      child.unref();
    } catch {
      /* ignore */
    }
    dbg('stop-done', pid);
  }

  /** 用 CLI 设置管理密码（引擎未启动时也可执行；这里在启动前调用） */
  async runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.opts.binPath, [...args, '--data', this.opts.dataDir], {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
      child.stderr?.on('data', (b: Buffer) => (err += b.toString('utf8')));
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
    });
  }

  /**
   * 设置管理密码。
   *
   * 重要前提（v4.2.9 实测）：本命令**只在 admin 用户已存在时**有效。
   * 全新实例里 admin 尚未创建，此命令会「退出码 0 但什么都不做」——
   * 这是引擎的静默失败，务必先用 /api/public/init/setup 完成初始化。
   */
  async setAdminPassword(password: string): Promise<void> {
    const r = await this.runCli(['admin', 'set', password]);
    if (r.code !== 0) {
      throw new SidecarError('E_CLI', `设置管理密码失败：${r.stderr || r.stdout}`);
    }
  }
}
