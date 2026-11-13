/**
 * Preload —— 唯一的渲染层 ↔ 主进程桥
 *
 * 只暴露白名单方法，不把 ipcRenderer / node API 泄漏给页面。
 */
// preload 同样以 CJS 输出，可具名导入
import { contextBridge, ipcRenderer } from 'electron';

export interface PanhubApi {
  status(): Promise<{
    engineRunning: boolean;
    engineUrl: string | null;
    initialized: boolean;
    accounts: number;
  }>;
  startEngine(): Promise<{ url: string }>;
  stopEngine(): Promise<{ ok: boolean }>;
  drivers(): Promise<Record<string, { name?: string; local_sort?: boolean }>>;
  mounts(): Promise<
    { id: number; mount_path: string; driver: string; status: string; remark?: string }[]
  >;
  addMount(input: {
    mountPath: string;
    driver: string;
    addition: unknown;
    remark?: string;
  }): Promise<{ ok: boolean }>;
  removeMount(id: number): Promise<{ ok: boolean }>;
  list(path: string): Promise<
    { name: string; size: number; is_dir: boolean; modified: string }[]
  >;
  download(input: { remotePath: string; destDir: string }): Promise<{
    id: string;
    name: string;
    status: string;
  }>;
  cancel(id: string): Promise<{ ok: boolean }>;
  jobs(): Promise<
    {
      id: string;
      name: string;
      destPath: string;
      total: number;
      downloaded: number;
      percent: number;
      speedBps: number;
      status: string;
      error?: string;
    }[]
  >;
  pickFolder(): Promise<string | null>;
  reveal(path: string): Promise<{ ok: boolean }>;
  resetAccounts(): Promise<{ ok: boolean }>;
  onJob(cb: (j: unknown) => void): () => void;
  onEngine(cb: (s: unknown) => void): () => void;
  onEngineError(cb: (m: string) => void): () => void;
  onWarn(cb: (m: string) => void): () => void;
}

const api: PanhubApi = {
  status: () => ipcRenderer.invoke('app:status'),
  startEngine: () => ipcRenderer.invoke('app:startEngine'),
  stopEngine: () => ipcRenderer.invoke('app:stopEngine'),
  drivers: () => ipcRenderer.invoke('drivers:list'),
  mounts: () => ipcRenderer.invoke('mounts:list'),
  addMount: (input) => ipcRenderer.invoke('mounts:add', input),
  removeMount: (id) => ipcRenderer.invoke('mounts:remove', id),
  list: (path) => ipcRenderer.invoke('fs:list', path),
  download: (input) => ipcRenderer.invoke('download:start', input),
  cancel: (id) => ipcRenderer.invoke('download:cancel', id),
  jobs: () => ipcRenderer.invoke('jobs:list'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  resetAccounts: () => ipcRenderer.invoke('app:resetAccounts'),
  onJob: (cb) => {
    const h = (_e: unknown, j: unknown) => cb(j);
    ipcRenderer.on('job:update', h);
    return () => ipcRenderer.removeListener('job:update', h);
  },
  onEngine: (cb) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('engine:update', h);
    return () => ipcRenderer.removeListener('engine:update', h);
  },
  onEngineError: (cb) => {
    const h = (_e: unknown, m: string) => cb(m);
    ipcRenderer.on('engine:error', h);
    return () => ipcRenderer.removeListener('engine:error', h);
  },
  onWarn: (cb) => {
    const h = (_e: unknown, m: string) => cb(m);
    ipcRenderer.on('engine:warn', h);
    return () => ipcRenderer.removeListener('engine:warn', h);
  },
};

contextBridge.exposeInMainWorld('panhub', api);
