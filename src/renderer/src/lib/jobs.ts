/**
 * 下载任务外部 store
 *
 * 为什么不用 useState：
 * 引擎的进度事件是高频的（每个任务每 200ms 一次，多任务叠加可达每秒几十次）。
 * 若直接 setState，整个组件树会跟着重渲染，长列表会明显掉帧。
 *
 * 这里把事件先攒进 pending，最多每 150ms 合并提交一次，
 * 并用 useSyncExternalStore 让**只有订阅任务列表的组件**重渲染。
 */
import { useSyncExternalStore } from 'react';
import type { Job } from '../types.ts';

const FLUSH_MS = 150;

let snapshot: Job[] = [];
let pending = new Map<string, Job>();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
const listeners = new Set<() => void>();

const STATUS_RANK: Record<string, number> = {
  running: 0,
  queued: 1,
  failed: 2,
  done: 3,
  cancelled: 4,
};

function sortJobs(list: Job[]): Job[] {
  return [...list].sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return b.id.localeCompare(a.id);
  });
}

function commit(): void {
  if (pending.size === 0) return;
  const map = new Map(snapshot.map((j) => [j.id, j]));
  for (const [id, job] of pending) map.set(id, job);
  pending = new Map();
  snapshot = sortJobs([...map.values()]);
  for (const l of listeners) l();
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    commit();
  }, FLUSH_MS);
}

function upsert(job: Job): void {
  pending.set(job.id, job);
  schedule();
}

function replaceAll(list: Job[]): void {
  pending = new Map();
  snapshot = sortJobs(list);
  for (const l of listeners) l();
}

/** 启动订阅（应用初始化时调用一次） */
export function initJobStore(): () => void {
  if (started) return () => {};
  started = true;
  const off = window.panhub.onJob((j) => upsert(j as Job));
  void window.panhub.jobs().then(replaceAll).catch(() => {});
  return () => {
    off();
    started = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function refreshJobs(): void {
  void window.panhub.jobs().then(replaceAll).catch(() => {});
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): Job[] {
  return snapshot;
}

export function useJobs(): Job[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 已完成/失败的计数，用于折叠态摘要 */
export function summarize(list: Job[]): {
  running: number;
  queued: number;
  failed: number;
  done: number;
} {
  let running = 0;
  let queued = 0;
  let failed = 0;
  let done = 0;
  for (const j of list) {
    if (j.status === 'running') running++;
    else if (j.status === 'queued') queued++;
    else if (j.status === 'failed') failed++;
    else if (j.status === 'done') done++;
  }
  return { running, queued, failed, done };
}
