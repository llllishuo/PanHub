import { useCallback, useEffect, useRef, useState } from 'react';

import type { DriverCatalog, EngineStatus, FsItem, Mount } from './types.ts';
import { driverLabel } from './types.ts';
import { bridge, humanError } from './lib/bridge.ts';
import { initJobStore } from './lib/jobs.ts';
import { joinPath, parentPath } from './lib/format.ts';

import TitleBar from './components/TitleBar.tsx';
import Sidebar from './components/Sidebar.tsx';
import FileBrowser from './components/FileBrowser.tsx';
import JobQueue from './components/JobQueue.tsx';
import AddDriveDialog, { type DrivePrefill } from './components/AddDriveDialog.tsx';
import ShareDialog from './components/ShareDialog.tsx';
import { ToastHost, toast, toastError } from './components/Toast.tsx';

export default function App() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [catalog, setCatalog] = useState<DriverCatalog | null>(null);
  const [path, setPath] = useState('/');
  const [items, setItems] = useState<FsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [prefill, setPrefill] = useState<DrivePrefill | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await bridge.status());
    } catch {
      /* 引擎未就绪时忽略 */
    }
  }, []);

  const refreshMounts = useCallback(async () => {
    try {
      setMounts(await bridge.mounts());
    } catch {
      setMounts([]);
    }
  }, []);

  const browse = useCallback(async (p: string) => {
    setLoading(true);
    setPath(p);
    try {
      const list = await bridge.list(p);
      setItems(list);
    } catch (e) {
      setItems([]);
      toastError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const c = await bridge.drivers();
      setCatalog(Object.keys(c).length > 0 ? c : null);
    } catch {
      /* 引擎未就绪时留待 engine 事件触发后再取 */
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await refreshStatus();
    await refreshMounts();
    await loadCatalog();
    await browse(pathRef.current);
  }, [refreshStatus, refreshMounts, loadCatalog, browse]);

  // 首次挂载：订阅任务事件、拉取状态与驱动表
  useEffect(() => {
    const off = initJobStore();
    void (async () => {
      await refreshStatus();
      await refreshMounts();
      await loadCatalog();
      await browse('/');
    })();

    // 引擎就绪后必须重新取一次驱动表 —— 启动早期取到的会是空表
    const offEngine = window.panhub.onEngine(() => {
      void refreshAll();
    });
    const offErr = window.panhub.onEngineError((m) => toast(`引擎启动失败：${m}`, 'error', 8000));
    const offWarn = window.panhub.onWarn((m) => toast(m, 'warn', 8000));

    return () => {
      off();
      offEngine();
      offErr();
      offWarn();
    };
  }, [refreshStatus, refreshMounts, loadCatalog, refreshAll, browse]);

  // 键盘快捷操作
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        document.getElementById('file-filter')?.focus();
        return;
      }
      if (typing) return;
      if (e.key === 'Backspace') {
        e.preventDefault();
        const up = parentPath(pathRef.current);
        if (up !== pathRef.current) void browse(up);
      }
      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        document.getElementById('file-filter')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [browse]);

  const onStartEngine = async () => {
    setBusy(true);
    try {
      await bridge.startEngine();
      toast('引擎已启动', 'success');
      await refreshAll();
    } catch (e) {
      toastError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const onOpen = useCallback(
    (p: string) => {
      // 侧栏传入的是挂载点或 "/"，文件行传入的是名称
      const target = p.startsWith('/') ? p : joinPath(pathRef.current, p);
      void browse(target);
    },
    [browse],
  );

  const onDownload = useCallback(async (item: FsItem) => {
    const remote = joinPath(pathRef.current, item.name);
    const destDir = await bridge.pickFolder();
    if (!destDir) return;
    try {
      await bridge.download({ remotePath: remote, destDir });
      toast(`已加入队列：${item.name}`, 'success');
    } catch (e) {
      toastError(humanError(e));
    }
  }, []);

  const onRemoveMount = async (id: number) => {
    const m = mounts.find((x) => x.id === id);
    try {
      await bridge.removeMount(id);
      toast(`已移除 ${m ? driverLabel(m.driver).label : '网盘'}`, 'success');
      await refreshAll();
    } catch (e) {
      toastError(humanError(e));
    }
  };

  const engineReady = status?.engineRunning ?? false;

  /** 打开添加对话框前确保驱动表已就绪，否则用户会看到一个空列表 */
  const openAddDialog = useCallback(async () => {
    if (!catalog) await loadCatalog();
    setDialogOpen(true);
  }, [catalog, loadCatalog]);

  return (
    <div className="app">
      <TitleBar
        status={status}
        busy={busy}
        onAdd={() => void openAddDialog()}
        onShare={() => setShareOpen(true)}
        onRefresh={() => void refreshAll()}
        onStartEngine={onStartEngine}
      />

      <div className="body">
        <Sidebar
          mounts={mounts}
          activePath={path}
          onOpen={(p) => void browse(p)}
          onAdd={() => void openAddDialog()}
          onRemove={onRemoveMount}
        />

        {!engineReady ? (
          <div className="hero">
            <div className="hero-icon">◈</div>
            <h1>正在准备本地引擎</h1>
            <p className="muted">
              首次启动需要初始化引擎与加密保险箱。若长时间无响应，可点下方按钮重试。
            </p>
            <button className="btn primary" onClick={onStartEngine} disabled={busy}>
              {busy ? '启动中…' : '启动引擎'}
            </button>
          </div>
        ) : mounts.length === 0 && path === '/' ? (
          <div className="hero">
            <div className="hero-icon">🗂️</div>
            <h1>连接你的第一个网盘</h1>
            <p className="muted">
              支持 {catalog ? Object.keys(catalog).length : 90}+ 种存储后端：百度网盘、阿里云盘、
              夸克、115、迅雷、天翼、123、微云、OneDrive、Google Drive…
            </p>
            <button className="btn primary" onClick={() => setDialogOpen(true)}>
              选择网盘类型
            </button>
            <p className="tiny muted" style={{ marginTop: 18 }}>
              登录凭据加密保存在本机，下次打开无需重复登录
            </p>
          </div>
        ) : (
          <FileBrowser
            path={path}
            items={items}
            loading={loading}
            onOpen={onOpen}
            onDownload={(it) => void onDownload(it)}
            onRefresh={() => void browse(pathRef.current)}
            onBack={() => void browse(parentPath(pathRef.current))}
          />
        )}
      </div>

      <JobQueue />

      {dialogOpen && catalog && (
        <AddDriveDialog
          catalog={catalog}
          initial={prefill ?? undefined}
          onClose={() => {
            setDialogOpen(false);
            setPrefill(null);
          }}
          onAdded={() => void refreshAll()}
        />
      )}

      {shareOpen && (
        <ShareDialog
          onClose={() => setShareOpen(false)}
          onUse={(r) => {
            if (!r.driver) return;
            setPrefill({ driver: r.driver, values: r.addition });
            setShareOpen(false);
            void openAddDialog();
          }}
        />
      )}

      <ToastHost />
    </div>
  );
}
