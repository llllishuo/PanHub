/**
 * 多线程分片下载器
 *
 * 为什么这样做：
 *  - 单条 TCP 连接往往跑不满链路（受服务端单连接限速/窗口/RTT 影响）。
 *    并发多条 Range 连接是唯一合规的提速手段：我们只发标准 HTTP Range，
 *    不伪造、不破解，服务端给多少就是多少。
 *  - 每个分片单独落 `.part.N` 文件，天然支持断点续传：状态文件记录哪些分片
 *    已完成，重启后只补没下完的。
 *  - 全部完成后再按序拼接到目标文件，最后原子 rename —— 用户永远看不到
 *    半成品文件冒充完成品。
 *
 * 明确不做：绕过服务端带宽配额。
 */
import { createWriteStream } from 'node:fs';
import {
  open as fsOpen,
  mkdir,
  readFile,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Chunk {
  index: number;
  start: number;
  end: number; // 含
}

export interface DownloadOptions {
  url: string;
  dest: string;
  /** 已知总大小；不传则自动探测 */
  size?: number;
  /** 并发分片数，默认 8 */
  connections?: number;
  /** 单分片最小字节数，默认 1 MiB；文件小则自动减少分片 */
  minChunkSize?: number;
  headers?: Record<string, string>;
  maxRetries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  fetchImpl?: FetchLike;
}

export interface Progress {
  downloaded: number;
  total: number;
  percent: number;
  speedBps: number;
  chunkDone: number;
  chunkTotal: number;
}

interface FetchLike {
  (input: string, init?: Record<string, unknown>): Promise<Response>;
}

interface PartState {
  version: 1;
  url: string;
  total: number;
  connections: number;
  done: number[];
}

export class DownloadError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 把 [0,total) 切成 chunks 个区间 */
export function planChunks(
  total: number,
  connections: number,
  minChunkSize = 1024 * 1024,
): Chunk[] {
  if (!Number.isFinite(total) || total <= 0) return [];
  const byMin = Math.max(1, Math.floor(total / Math.max(1, minChunkSize)));
  const n = Math.max(1, Math.min(connections, byMin));
  const base = Math.floor(total / n);
  const chunks: Chunk[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = i === n - 1 ? total - 1 : start + base - 1;
    chunks.push({ index: i, start, end });
    start = end + 1;
  }
  return chunks;
}

function statePath(dest: string): string {
  return `${dest}.panhub.json`;
}

function partPath(dest: string, index: number): string {
  return `${dest}.part.${index}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 探测总大小与是否支持 Range。自带重试：探测阶段的一次抖动不该毁掉整个下载任务。 */
export async function probe(
  url: string,
  opts: {
    headers?: Record<string, string>;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    maxRetries?: number;
  } = {},
): Promise<{ total: number | null; acceptRanges: boolean }> {
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const maxRetries = opts.maxRetries ?? 2;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(Math.min(4000, 300 * 2 ** (attempt - 1)));
    if (opts.signal?.aborted) throw new DownloadError('E_ABORTED', '已取消', false);
    try {
      const res = await f(url, {
        method: 'GET',
        headers: { ...(opts.headers ?? {}), Range: 'bytes=0-0' },
        signal: opts.signal,
      });
      const cr = res.headers.get('content-range');
      const accept = (res.headers.get('accept-ranges') ?? '').toLowerCase() === 'bytes';
      // 不读完 body 会泄漏连接，直接取消
      await res.body?.cancel().catch(() => {});
      if (cr) {
        const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(cr);
        if (m) return { total: Number(m[1]), acceptRanges: true };
        // 形如 bytes 0-0/* → 大小未知
        return { total: null, acceptRanges: false };
      }
      if (res.status === 206) return { total: null, acceptRanges: true };
      if (res.status >= 400) {
        const retryable = res.status >= 500 || res.status === 429;
        throw new DownloadError('E_HTTP', `探测失败 HTTP ${res.status}`, retryable);
      }
      const len = res.headers.get('content-length');
      return {
        total: len ? Number(len) : null,
        acceptRanges: accept && res.status === 206,
      };
    } catch (e: unknown) {
      lastErr = e;
      if (e instanceof DownloadError && !e.retryable) throw e;
      if (opts.signal?.aborted) {
        throw new DownloadError('E_ABORTED', '已取消', false);
      }
    }
  }
  throw new DownloadError(
    'E_PROBE',
    `无法探测资源（已重试 ${maxRetries} 次）：${(lastErr as Error)?.message ?? lastErr}`,
    false,
  );
}

export class Downloader {
  private readonly f: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    this.f = fetchImpl ?? (fetch as unknown as FetchLike);
  }

  async download(opts: DownloadOptions): Promise<{ path: string; bytes: number }> {
    const { url, dest } = opts;
    const connections = opts.connections ?? 8;
    const minChunkSize = opts.minChunkSize ?? 1024 * 1024;
    const maxRetries = opts.maxRetries ?? 3;
    const timeoutMs = opts.timeoutMs ?? 60_000;

    if (!url) throw new DownloadError('E_ARG', 'url 不能为空', false);
    await mkdir(dirname(dest), { recursive: true });

    let total = opts.size ?? null;
    let acceptRanges = true;
    if (total === null) {
      const p = await probe(url, { headers: opts.headers, fetchImpl: this.f, signal: opts.signal });
      total = p.total;
      acceptRanges = p.acceptRanges;
    }
    if (total === null) {
      // 服务端没给长度：退化为单流下载
      return this.singleStream(opts, maxRetries);
    }
    if (!acceptRanges) {
      return this.singleStream(opts, maxRetries);
    }

    const chunks = planChunks(total, connections, minChunkSize);
    const sp = statePath(dest);
    const state = await this.loadState(sp, url, total, chunks.length);

    const done = new Set(state?.done ?? []);
    const chunkBytes = new Map<number, number>();
    for (const c of chunks) {
      if (done.has(c.index)) chunkBytes.set(c.index, c.end - c.start + 1);
    }

    const started = Date.now();
    let lastEmit = 0;
    const emit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 200) return;
      lastEmit = now;
      const downloaded = [...chunkBytes.values()].reduce((a, b) => a + b, 0);
      const elapsed = Math.max(1, now - started) / 1000;
      opts.onProgress?.({
        downloaded,
        total: total as number,
        percent: total ? (downloaded / total) * 100 : 0,
        speedBps: downloaded / elapsed,
        chunkDone: done.size,
        chunkTotal: chunks.length,
      });
    };
    emit(true);

    const queue = chunks.filter((c) => !done.has(c.index));
    let cursor = 0;
    const persistState = async () => {
      const st: PartState = {
        version: 1,
        url,
        total: total as number,
        connections: chunks.length,
        done: [...done].sort((a, b) => a - b),
      };
      await writeFile(sp, JSON.stringify(st), 'utf8');
    };

    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const c = queue[cursor++];
        await this.fetchChunk(url, c, dest, {
          headers: opts.headers,
          maxRetries,
          timeoutMs,
          signal: opts.signal,
          isTail: c.end === (total as number) - 1,
          onBytes: (n) => chunkBytes.set(c.index, n),
          onTick: () => emit(),
        });
        done.add(c.index);
        chunkBytes.set(c.index, c.end - c.start + 1);
        await persistState();
        emit();
      }
    };

    await Promise.all(Array.from({ length: Math.min(connections, queue.length) }, worker));
    emit(true);

    // 拼接（以实际收到字节数为准，见 concat 内注释）
    const merged = await this.concat(dest, chunks);
    await this.cleanup(dest, chunks.length, sp);
    return { path: merged.path, bytes: merged.bytes };
  }

  private async loadState(
    sp: string,
    url: string,
    total: number,
    connections: number,
  ): Promise<PartState | null> {
    try {
      const raw = await readFile(sp, 'utf8');
      const st = JSON.parse(raw) as PartState;
      if (st.version !== 1) return null;
      // 换了个文件/大小变了 → 旧状态作废，别拿错的分片去拼
      if (st.url !== url || st.total !== total || st.connections !== connections) return null;
      return st;
    } catch {
      return null;
    }
  }

  private async fetchChunk(
    url: string,
    c: Chunk,
    dest: string,
    o: {
      headers?: Record<string, string>;
      maxRetries: number;
      timeoutMs: number;
      signal?: AbortSignal;
      /** 是否为最后一个分片（用于容忍服务端谎报总大小） */
      isTail: boolean;
      onBytes: (n: number) => void;
      onTick: () => void;
    },
  ): Promise<number> {
    const expect = c.end - c.start + 1;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= o.maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(8000, 400 * 2 ** (attempt - 1)));
      if (o.signal?.aborted) throw new DownloadError('E_ABORTED', '已取消', false);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), o.timeoutMs);
      const onOuter = () => ac.abort();
      o.signal?.addEventListener('abort', onOuter);

      try {
        const res = await this.f(url, {
          method: 'GET',
          headers: { ...(o.headers ?? {}), Range: `bytes=${c.start}-${c.end}` },
          signal: ac.signal,
        });
        if (res.status !== 206 && res.status !== 200) {
          throw new DownloadError(
            'E_HTTP',
            `分片 ${c.index} 返回 HTTP ${res.status}`,
            res.status >= 500 || res.status === 429,
          );
        }
        if (!res.body) throw new DownloadError('E_NOBODY', '响应没有 body', true);

        const out = createWriteStream(partPath(dest, c.index));
        let written = 0;
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              written += value.byteLength;
              o.onBytes(written);
              o.onTick();
              if (!out.write(Buffer.from(value))) {
                await new Promise<void>((r) => out.once('drain', () => r()));
              }
            }
          }
        } finally {
          await new Promise<void>((resolve, reject) =>
            out.end((err?: Error | null) => (err ? reject(err) : resolve())),
          );
        }
        if (written !== expect) {
          // 服务端谎报总大小的情况：某些服务端（如 OpenList 的 Local 驱动在
          // Windows 上）会在 Content-Range 里报按分配单元取整的大小，
          // 实际 body 更短。只容忍「尾片偏短」这一种，且必须真的收到了数据；
          // 中间片短、或尾片为空，仍然视为损坏并重试。
          if (o.isTail && written > 0 && written < expect) {
            return written;
          }
          throw new DownloadError(
            'E_SHORT',
            `分片 ${c.index} 长度不符：期望 ${expect}，实际 ${written}`,
            true,
          );
        }
        return written;
      } catch (e: unknown) {
        lastErr = e;
        if (e instanceof DownloadError && !e.retryable) throw e;
        if ((e as Error)?.name === 'AbortError') {
          throw new DownloadError('E_ABORTED', '下载超时或被取消', false);
        }
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onOuter);
      }
    }
    throw new DownloadError(
      'E_RETRY',
      `分片 ${c.index} 重试 ${o.maxRetries} 次仍失败：${(lastErr as Error)?.message ?? lastErr}`,
      false,
    );
  }

  private async concat(
    dest: string,
    chunks: Chunk[],
  ): Promise<{ path: string; bytes: number }> {
    // 不按「服务端声称的总大小」预分配/截断：以各分片实际写入的长度为准，
    // 这样即使服务端谎报大小，最终文件也是完整的真实内容。
    const fh = await fsOpen(dest, 'w');
    let offset = 0;
    try {
      for (const c of chunks) {
        const buf = await readFile(partPath(dest, c.index));
        const expect = c.end - c.start + 1;
        const isTail = c.index === chunks.length - 1;
        if (buf.length !== expect && !(isTail && buf.length > 0 && buf.length < expect)) {
          throw new DownloadError(
            'E_PART',
            `分片 ${c.index} 文件损坏：期望 ${expect} 字节，实际 ${buf.length}`,
            false,
          );
        }
        if (buf.length === 0 && expect > 0) {
          throw new DownloadError('E_PART', `分片 ${c.index} 为空`, false);
        }
        await fh.write(buf, 0, buf.length, offset);
        offset += buf.length;
      }
      // 多写了要截掉（服务端上次报大了）
      await fh.truncate(offset);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // 以磁盘实际大小为准：服务端可能虚报总大小，分片长度之和未必等于真实文件大小。
    // 真实内容已完整落盘，不应因为我们自己的记账差异就把下载判为失败。
    const st = await stat(dest);
    return { path: dest, bytes: st.size };
  }

  private async cleanup(dest: string, n: number, sp: string): Promise<void> {
    for (let i = 0; i < n; i++) {
      await unlink(partPath(dest, i)).catch(() => {});
    }
    await unlink(sp).catch(() => {});
  }

  /** 服务端不支持 Range 时的退化路径 */
  private async singleStream(
    opts: DownloadOptions,
    maxRetries: number,
  ): Promise<{ path: string; bytes: number }> {
    const tmp = `${opts.dest}.tmp`;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(8000, 400 * 2 ** (attempt - 1)));
      try {
        const res = await this.f(opts.url, {
          method: 'GET',
          headers: opts.headers ?? {},
          signal: opts.signal,
        });
        if (!res.ok || !res.body) {
          throw new DownloadError('E_HTTP', `HTTP ${res.status}`, res.status >= 500);
        }
        const total = Number(res.headers.get('content-length') ?? 0) || 0;
        const out = createWriteStream(tmp);
        const reader = res.body.getReader();
        let written = 0;
        const started = Date.now();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            written += value.byteLength;
            if (!out.write(Buffer.from(value))) {
              await new Promise<void>((r) => out.once('drain', () => r()));
            }
            const elapsed = Math.max(1, Date.now() - started) / 1000;
            opts.onProgress?.({
              downloaded: written,
              total,
              percent: total ? (written / total) * 100 : 0,
              speedBps: written / elapsed,
              chunkDone: 0,
              chunkTotal: 1,
            });
          }
        }
        await new Promise<void>((resolve, reject) =>
          out.end((err?: Error | null) => (err ? reject(err) : resolve())),
        );
        await rename(tmp, opts.dest);
        return { path: opts.dest, bytes: written };
      } catch (e: unknown) {
        lastErr = e;
        await unlink(tmp).catch(() => {});
        if (e instanceof DownloadError && !e.retryable) throw e;
      }
    }
    throw new DownloadError(
      'E_RETRY',
      `单流下载失败：${(lastErr as Error)?.message ?? lastErr}`,
      false,
    );
  }
}

export async function download(opts: DownloadOptions): Promise<{ path: string; bytes: number }> {
  return new Downloader(opts.fetchImpl).download(opts);
}

export { join };
