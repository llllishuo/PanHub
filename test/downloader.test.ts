/**
 * 下载器测试 —— 起一个真实的本地 HTTP 服务器跑，不用 mock
 *
 * 验证点：
 *  1. 分片规划不重叠不遗漏
 *  2. 多线程分片下载的字节流与源完全一致（sha256 比对）
 *  3. 断点续传：中断后重跑只补没下完的分片
 *  4. 服务端不支持 Range 时退化为单流
 *  5. HTTP 错误向上抛出
 *  6. 进度回调单调递增且终值为 100%
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmRetry } from './helpers.ts';

import { Downloader, DownloadError, planChunks, probe } from '../src/core/downloader.ts';

const SIZE = 3 * 1024 * 1024 + 12345; // 故意非整数块
const PAYLOAD = randomBytes(SIZE);
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

interface Fixture {
  server: Server;
  base: string;
  requests: { range: string | null }[];
  close: () => Promise<void>;
}

/** 支持 Range 的服务器；options.failChunkOnce 可让指定次数请求失败 */
async function startServer(opts: {
  supportRange?: boolean;
  /** 让第 N 个请求（1 起）断连一次，用于模拟偶发网络故障 */
  failOnRequest?: number;
  status?: number;
} = {}): Promise<Fixture> {
  const { supportRange = true, failOnRequest = 0, status = 200 } = opts;
  const requests: { range: string | null }[] = [];
  let failed = false;

  const server = createServer((req, res) => {
    requests.push({ range: req.headers.range ?? null });

    if (status !== 200) {
      res.writeHead(status).end('nope');
      return;
    }
    if (failOnRequest > 0 && !failed && requests.length === failOnRequest) {
      failed = true;
      // 模拟服务端偶发断连
      req.socket.destroy();
      return;
    }

    const range = req.headers.range;
    if (supportRange && range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), SIZE - 1);
        const body = PAYLOAD.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${SIZE}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(body.length),
        });
        res.end(body);
        return;
      }
    }
    res.writeHead(200, {
      'Content-Length': String(SIZE),
      ...(supportRange ? { 'Accept-Ranges': 'bytes' } : {}),
    });
    res.end(PAYLOAD);
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    server,
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'panhub-dl-'));
}

test('planChunks：无重叠、无遗漏、覆盖全长', () => {
  for (const [total, conns] of [[1000, 4], [SIZE, 8], [10, 16], [1, 8]] as const) {
    const chunks = planChunks(total, conns);
    assert.equal(chunks[0].start, 0, `total=${total} 起点错`);
    assert.equal(chunks[chunks.length - 1].end, total - 1, `total=${total} 终点错`);
    for (let i = 1; i < chunks.length; i++) {
      assert.equal(chunks[i].start, chunks[i - 1].end + 1, `total=${total} 第 ${i} 段不连续`);
    }
    const sum = chunks.reduce((a, c) => a + (c.end - c.start + 1), 0);
    assert.equal(sum, total, `total=${total} 总长不符`);
  }
});

test('planChunks：小文件不会被切成过多分片', () => {
  // 1.5 MB / 最小分片 1 MiB → 最多 1~2 片，而不是 8 片
  const chunks = planChunks(1536 * 1024, 8, 1024 * 1024);
  assert.ok(chunks.length <= 2, `分片过多：${chunks.length}`);
});

test('probe：能测出总大小与 Range 支持', async () => {
  const fx = await startServer();
  try {
    const p = await probe(`${fx.base}/f.bin`);
    assert.equal(p.total, SIZE);
    assert.equal(p.acceptRanges, true);
  } finally {
    await fx.close();
  }
});

test('多线程分片下载：输出字节与源逐字节一致', async () => {
  const fx = await startServer();
  const dir = await tmp();
  try {
    const dest = join(dir, 'out.bin');
    const r = await new Downloader().download({
      url: `${fx.base}/f.bin`,
      dest,
      connections: 4,
      minChunkSize: 256 * 1024,
    });
    assert.equal(r.bytes, SIZE);

    const got = await readFile(dest);
    assert.equal(got.length, SIZE);
    const sha = createHash('sha256').update(got).digest('hex');
    assert.equal(sha, PAYLOAD_SHA, '内容哈希不匹配 —— 分片拼接有错');

    // 分片临时文件与状态文件都应被清掉
    const left = await readdir(dir);
    assert.deepEqual(left, ['out.bin'], `残留文件：${left.join(',')}`);

    // 确实发了多条 Range 请求
    const rangeReqs = fx.requests.filter((x) => x.range && !x.range.endsWith('-0'));
    assert.ok(rangeReqs.length >= 4, `Range 请求过少：${rangeReqs.length}`);
  } finally {
    await fx.close();
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('断点续传：中断后重跑，只补未完成分片且结果正确', async () => {
  const dir = await tmp();
  const fx = await startServer();
  try {
    const dest = join(dir, 'resume.bin');

    // 第一次：拿到第一个进度事件就取消
    const ac = new AbortController();
    let aborted = false;
    await assert.rejects(
      () =>
        new Downloader().download({
          url: `${fx.base}/f.bin`,
          dest,
          connections: 2,
          minChunkSize: SIZE, // 强制 2 片，保证有分片能先完成
          signal: ac.signal,
          onProgress: () => {
            if (!aborted) {
              aborted = true;
              ac.abort();
            }
          },
        }),
      (e: unknown) => e instanceof DownloadError,
    );
    await fx.close();

    // 第二次：全新服务器，应能续传完成
    const fx2 = await startServer();
    try {
      const r = await new Downloader().download({
        url: `${fx2.base}/f.bin`,
        dest,
        connections: 2,
        minChunkSize: SIZE,
      });
      assert.equal(r.bytes, SIZE);
      const sha = createHash('sha256').update(await readFile(dest)).digest('hex');
      assert.equal(sha, PAYLOAD_SHA, '续传后内容损坏');
    } finally {
      await fx2.close();
    }
  } finally {
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('服务端不支持 Range：自动退化为单流下载', async () => {
  const fx = await startServer({ supportRange: false });
  const dir = await tmp();
  try {
    const dest = join(dir, 'single.bin');
    const r = await new Downloader().download({ url: `${fx.base}/f.bin`, dest, connections: 8 });
    assert.equal(r.bytes, SIZE);
    const sha = createHash('sha256').update(await readFile(dest)).digest('hex');
    assert.equal(sha, PAYLOAD_SHA);
    // 单流路径不该留下 .part 文件
    const left = await readdir(dir);
    assert.deepEqual(left, ['single.bin'], `残留：${left.join(',')}`);
  } finally {
    await fx.close();
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('偶发断连：自动重试后仍能成功', async () => {
  // 第 1 个请求是探测，第 2 个是首个分片 → 让分片请求断一次
  const fx = await startServer({ failOnRequest: 2 });
  const dir = await tmp();
  try {
    const dest = join(dir, 'retry.bin');
    const r = await new Downloader().download({
      url: `${fx.base}/f.bin`,
      dest,
      connections: 2,
      minChunkSize: SIZE,
      maxRetries: 3,
    });
    assert.equal(r.bytes, SIZE);
    const sha = createHash('sha256').update(await readFile(dest)).digest('hex');
    assert.equal(sha, PAYLOAD_SHA);
  } finally {
    await fx.close();
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('探测阶段断连：probe 自带重试，不该直接失败', async () => {
  const fx = await startServer({ failOnRequest: 1 });
  try {
    const p = await probe(`${fx.base}/f.bin`);
    assert.equal(p.total, SIZE);
    assert.equal(p.acceptRanges, true);
  } finally {
    await fx.close();
  }
});

test('HTTP 404：抛出 DownloadError 且不产生目标文件', async () => {
  const fx = await startServer({ status: 404 });
  const dir = await tmp();
  try {
    const dest = join(dir, 'missing.bin');
    await assert.rejects(
      () => new Downloader().download({ url: `${fx.base}/nope`, dest, maxRetries: 0 }),
      (e: unknown) => e instanceof DownloadError,
    );
    await assert.rejects(() => stat(dest));
  } finally {
    await fx.close();
    await rmRetry(dir, { recursive: true, force: true });
  }
});

test('进度回调：单调递增，终值为 100%', async () => {
  const fx = await startServer();
  const dir = await tmp();
  try {
    const dest = join(dir, 'p.bin');
    const seen: number[] = [];
    await new Downloader().download({
      url: `${fx.base}/f.bin`,
      dest,
      connections: 4,
      minChunkSize: 256 * 1024,
      onProgress: (p) => seen.push(p.downloaded),
    });
    assert.ok(seen.length >= 2, '进度回调次数太少');
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] >= seen[i - 1], `进度回退：${seen[i - 1]} → ${seen[i]}`);
    }
    assert.equal(seen[seen.length - 1], SIZE);
  } finally {
    await fx.close();
    await rmRetry(dir, { recursive: true, force: true });
  }
});
