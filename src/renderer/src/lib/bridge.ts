/** 渲染层对 window.panhub 的类型化封装 + 错误信息归一 */
import type { DriverCatalog, EngineStatus, FsItem, Job, Mount } from '../types.ts';

function api() {
  const a = window.panhub;
  if (!a) throw new Error('预加载桥未就绪，请重启应用');
  return a;
}

/** 把各种形态的错误统一成一句人话 */
export function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Electron IPC 会把错误包成 "Error invoking remote method 'x': Error: 真正原因"
  const m = /Error:\s*(.+)$/.exec(raw);
  return (m ? m[1] : raw).trim();
}

export const bridge = {
  status: (): Promise<EngineStatus> => api().status(),
  startEngine: (): Promise<{ url: string }> => api().startEngine(),
  stopEngine: (): Promise<{ ok: boolean }> => api().stopEngine(),

  drivers: (): Promise<DriverCatalog> => api().drivers() as Promise<DriverCatalog>,
  mounts: (): Promise<Mount[]> => api().mounts() as Promise<Mount[]>,
  addMount: (input: {
    mountPath: string;
    driver: string;
    addition: unknown;
    remark?: string;
  }): Promise<{ ok: boolean }> => api().addMount(input),
  removeMount: (id: number): Promise<{ ok: boolean }> => api().removeMount(id),

  list: (path: string): Promise<FsItem[]> => api().list(path) as Promise<FsItem[]>,

  download: (input: { remotePath: string; destDir: string }): Promise<Job> =>
    api().download(input) as Promise<Job>,
  cancel: (id: string): Promise<{ ok: boolean }> => api().cancel(id),

  pickFolder: (): Promise<string | null> => api().pickFolder(),
  reveal: (path: string): Promise<{ ok: boolean }> => api().reveal(path),
  resetAccounts: (): Promise<{ ok: boolean }> => api().resetAccounts(),
};
