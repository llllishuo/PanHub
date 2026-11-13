/**
 * OpenList 引擎 HTTP 客户端
 *
 * 初始化协议（已实测校准，勿照抄 AList v3 文档）：
 *   1) 引擎首次启动**不会**创建 admin（v4 行为变更，只建 guest）
 *   2) 首次需 POST /api/public/init/setup {username,password} 完成安装向导
 *   3) 之后 POST /api/auth/login {username,password} 换取 token
 *   4) 所有管理接口带 Authorization: <token>（裸 token，不加 Bearer）
 *
 * 所有响应统一为 {code, message, data}；code!==200 视为业务失败。
 */

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export class EngineApiError extends Error {
  code: number;
  path: string;
  constructor(path: string, code: number, message: string) {
    super(`[${path}] code=${code} ${message}`);
    this.name = 'EngineApiError';
    this.path = path;
    this.code = code;
  }
}

export interface FsItem {
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  created: string;
  sign?: string;
  thumb?: string;
  type?: number;
  hashinfo?: string;
}

export interface FsGetResult {
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  sign?: string;
  /** 直链；交给我们的多线程下载器 */
  raw_url?: string;
}

export interface StorageEntry {
  id: number;
  mount_path: string;
  order: number;
  driver: string;
  status: string;
  addition: string;
  remark?: string;
  disabled?: boolean;
}

export interface CreateStorageInput {
  mount_path: string;
  driver: string;
  addition: Record<string, unknown> | string;
  order?: number;
  remark?: string;
  status?: 'work' | 'disabled';
  cache_expiration?: number;
  web_proxy?: boolean;
  webdav_policy?: string;
}

export class OpenListClient {
  readonly baseUrl: string;
  private token: string | null;

  constructor(baseUrl: string, token?: string | null) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token ?? null;
  }

  get authToken(): string | null {
    return this.token;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      // 引擎在 127.0.0.1，握手成本可忽略；
      // 但 keep-alive 套接字会滞留在 undici 连接池里拖住宿主进程退出。
      Connection: 'close',
      ...extra,
    };
    if (this.token) h.Authorization = this.token;
    return h;
  }

  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown; allowCodes?: number[] } = {},
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: this.headers(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });
    let env: ApiEnvelope<T>;
    try {
      env = (await res.json()) as ApiEnvelope<T>;
    } catch {
      throw new EngineApiError(path, res.status, `响应不是 JSON（HTTP ${res.status}）`);
    }
    if (env.code !== 200 && !(init.allowCodes ?? []).includes(env.code)) {
      throw new EngineApiError(path, env.code, env.message);
    }
    return env.data;
  }

  // ---------- 初始化 ----------

  /** 安装向导是否已完成（能否直接登录） */
  async isInitialized(): Promise<boolean> {
    try {
      await this.call<unknown>('/api/me', { allowCodes: [401, 500] });
      return true;
    } catch {
      return false;
    }
  }

  /** 首次初始化：创建 admin。返回 false 表示已初始化过 */
  async setup(username: string, password: string): Promise<boolean> {
    try {
      await this.call<unknown>('/api/public/init/setup', {
        method: 'POST',
        body: { username, password },
      });
      return true;
    } catch (e) {
      if (e instanceof EngineApiError && /already|exist|initialized|已/i.test(e.message)) {
        return false;
      }
      throw e;
    }
  }

  /** 登录，成功后 token 写入本实例 */
  async login(username: string, password: string): Promise<string> {
    const data = await this.call<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    if (!data?.token) throw new EngineApiError('/api/auth/login', 0, '登录响应里没有 token');
    this.token = data.token;
    return data.token;
  }

  /** 确认当前 token 是否有效（用于判断是否需要重新登录） */
  async me(): Promise<{ id: number; username: string; role: number }> {
    return await this.call('/api/me');
  }

  // ---------- 驱动与存储 ----------

  /** 可用存储驱动清单（键=驱动名，值=该驱动的配置字段定义） */
  async drivers(): Promise<Record<string, { name?: string; local_sort?: boolean }>> {
    return await this.call('/api/admin/driver/list');
  }

  async storages(): Promise<StorageEntry[]> {
    const data = await this.call<{ content: StorageEntry[]; total: number }>(
      '/api/admin/storage/list',
    );
    return data?.content ?? [];
  }

  async createStorage(input: CreateStorageInput): Promise<void> {
    await this.call('/api/admin/storage/create', {
      method: 'POST',
      body: {
        mount_path: input.mount_path,
        driver: input.driver,
        addition:
          typeof input.addition === 'string' ? input.addition : JSON.stringify(input.addition),
        order: input.order ?? 0,
        remark: input.remark ?? '',
        status: input.status ?? 'work',
        cache_expiration: input.cache_expiration ?? 30,
        web_proxy: input.web_proxy ?? false,
        webdav_policy: input.webdav_policy ?? '302_redirect',
      },
    });
  }

  async deleteStorage(id: number): Promise<void> {
    await this.call('/api/admin/storage/delete', { method: 'POST', body: { id } });
  }

  // ---------- 文件系统 ----------

  async list(dir: string, password = ''): Promise<FsItem[]> {
    const data = await this.call<{ content: FsItem[] | null; total: number }>('/api/fs/list', {
      method: 'POST',
      body: { path: dir, password, page: 1, per_page: 1000, refresh: false },
    });
    return data?.content ?? [];
  }

  /** 取单个文件的元信息与直链 */
  async get(path: string, password = ''): Promise<FsGetResult> {
    return await this.call<FsGetResult>('/api/fs/get', {
      method: 'POST',
      body: { path, password },
    });
  }
}

/** 便捷构造：初始化（若需要）→ 登录 */
export async function connectEngine(opts: {
  baseUrl: string;
  username: string;
  password: string;
}): Promise<OpenListClient> {
  const c = new OpenListClient(opts.baseUrl);
  try {
    await c.login(opts.username, opts.password);
    return c;
  } catch {
    const created = await c.setup(opts.username, opts.password);
    if (created) {
      await c.login(opts.username, opts.password);
      return c;
    }
    throw new Error('引擎已初始化，但提供的管理密码不正确');
  }
}
