import { useCallback, useEffect, useMemo, useState } from 'react';

type Status = {
  engineRunning: boolean;
  engineUrl: string | null;
  initialized: boolean;
  accounts: number;
};
type Mount = { id: number; mount_path: string; driver: string; status: string; remark?: string };
type FsItem = { name: string; size: number; is_dir: boolean; modified: string };
type Job = {
  id: string;
  name: string;
  destPath: string;
  total: number;
  downloaded: number;
  percent: number;
  speedBps: number;
  status: string;
  error?: string;
};
type Driver = { name?: string };

function fmtSize(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtSpeed(n: number): string {
  return n > 0 ? `${fmtSize(n)}/s` : '—';
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [cwd, setCwd] = useState('/');
  const [items, setItems] = useState<FsItem[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [drivers, setDrivers] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 添加网盘表单
  const [driver, setDriver] = useState('Local');
  const [mountPath, setMountPath] = useState('/mydisk');
  const [addition, setAddition] = useState('{\n  "root_folder_path": ""\n}');

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.panhub.status());
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  const refreshMounts = useCallback(async () => {
    try {
      setMounts(await window.panhub.mounts());
    } catch {
      /* 引擎未就绪时忽略 */
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      setJobs(await window.panhub.jobs());
    } catch {
      /* ignore */
    }
  }, []);

  const browse = useCallback(async (path: string) => {
    try {
      setItems(await window.panhub.list(path));
      setCwd(path);
      setErr(null);
    } catch (e) {
      setItems([]);
      setErr(`读取目录失败：${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshMounts();
    void refreshJobs();
    const offJob = window.panhub.onJob((j) => {
      const job = j as Job;
      setJobs((prev) => {
        const i = prev.findIndex((x) => x.id === job.id);
        if (i < 0) return [job, ...prev];
        const next = [...prev];
        next[i] = job;
        return next;
      });
    });
    const offEngine = window.panhub.onEngine(() => {
      void refreshStatus();
      void refreshMounts();
      void browse('/');
    });
    const offErr = window.panhub.onEngineError((m) => setErr(`引擎启动失败：${m}`));
    const offWarn = window.panhub.onWarn((m) => setErr(m));
    return () => {
      offJob();
      offEngine();
      offErr();
      offWarn();
    };
  }, [refreshStatus, refreshMounts, refreshJobs, browse]);

  const canUse = status?.engineRunning ?? false;

  const onStartEngine = async () => {
    setBusy(true);
    try {
      await window.panhub.startEngine();
      await refreshStatus();
      await refreshMounts();
      await browse('/');
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onAddMount = async () => {
    setBusy(true);
    setErr(null);
    try {
      JSON.parse(addition); // 提前校验，给用户明确报错
      await window.panhub.addMount({ mountPath, driver, addition });
      await refreshMounts();
      await browse('/');
    } catch (e) {
      setErr(`添加失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onRemoveMount = async (id: number) => {
    try {
      await window.panhub.removeMount(id);
      await refreshMounts();
      await browse('/');
    } catch (e) {
      setErr(String(e));
    }
  };

  const onDownload = async (item: FsItem) => {
    const remote = cwd.replace(/\/$/, '') + '/' + item.name;
    const destDir = await window.panhub.pickFolder();
    if (!destDir) return;
    try {
      await window.panhub.download({ remotePath: remote, destDir });
      await refreshJobs();
    } catch (e) {
      setErr(`下载失败：${String(e)}`);
    }
  };

  const crumbs = useMemo(() => {
    const parts = cwd.split('/').filter(Boolean);
    const acc = [{ label: '根目录', path: '/' }];
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      acc.push({ label: p, path: cur });
    }
    return acc;
  }, [cwd]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          PanHub <span className="badge">核心版</span>
        </div>
        <div className={`engine ${canUse ? 'ok' : 'off'}`}>
          <span className="dot" />
          {canUse ? `引擎运行中 · ${status?.engineUrl}` : '引擎未运行'}
        </div>
        {!canUse && (
          <button className="btn primary" onClick={onStartEngine} disabled={busy}>
            启动引擎
          </button>
        )}
        <div className="spacer" />
        <span className="hint">账号数 {status?.accounts ?? 0}</span>
      </header>

      {err && (
        <div className="alert">
          {err}
          <button onClick={() => setErr(null)}>×</button>
        </div>
      )}

      <div className="main">
        <aside className="sidebar">
          <h3>已连接的网盘</h3>
          {mounts.length === 0 && <p className="muted">还没有网盘。添加一个开始。</p>}
          <ul className="mounts">
            {mounts.map((m) => (
              <li key={m.id}>
                <button className="link" onClick={() => browse(m.mount_path)}>
                  <span className="mono">{m.mount_path}</span>
                  <small>{m.driver}</small>
                </button>
                <button className="x" title="移除" onClick={() => onRemoveMount(m.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>

          <h3>添加网盘</h3>
          <label>
            驱动
            <input
              value={driver}
              onChange={(e) => setDriver(e.target.value)}
              list="driverlist"
              placeholder="如 BaiduNetdisk / Aliyundrive / Quark"
            />
            <datalist id="driverlist">
              {drivers.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </label>
          <label>
            挂载路径
            <input value={mountPath} onChange={(e) => setMountPath(e.target.value)} />
          </label>
          <label>
            配置（JSON）
            <textarea
              rows={7}
              value={addition}
              onChange={(e) => setAddition(e.target.value)}
              spellCheck={false}
            />
          </label>
          <button className="btn" onClick={() => void window.panhub.drivers().then((d) => setDrivers(Object.keys(d).sort()))}>
            加载驱动列表
          </button>
          <button className="btn primary" onClick={onAddMount} disabled={busy || !canUse}>
            添加
          </button>
          <p className="muted tiny">
            凭据会加密保存在本机，下次启动无需重新登录。详见 DISCLAIMER.md。
          </p>
        </aside>

        <section className="content">
          <nav className="crumbs">
            {crumbs.map((c) => (
              <button key={c.path} className="link" onClick={() => browse(c.path)}>
                {c.label} /
              </button>
            ))}
          </nav>
          <table className="files">
            <thead>
              <tr>
                <th>名称</th>
                <th className="num">大小</th>
                <th className="num">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    {canUse ? '此目录为空' : '引擎未运行'}
                  </td>
                </tr>
              )}
              {items.map((it) => (
                <tr key={it.name}>
                  <td>
                    {it.is_dir ? (
                      <button className="link" onClick={() => browse(cwd.replace(/\/$/, '') + '/' + it.name)}>
                        📁 {it.name}
                      </button>
                    ) : (
                      <>📄 {it.name}</>
                    )}
                  </td>
                  <td className="num">{it.is_dir ? '—' : fmtSize(it.size)}</td>
                  <td className="num">
                    {!it.is_dir && (
                      <button className="btn tiny" onClick={() => onDownload(it)}>
                        下载
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <footer className="jobs">
        <h3>下载任务</h3>
        {jobs.length === 0 && <p className="muted">暂无任务</p>}
        {jobs.map((j) => (
          <div key={j.id} className={`job ${j.status}`}>
            <div className="jobhead">
              <span className="name">{j.name}</span>
              <span className="muted">
                {j.status === 'running'
                  ? `${j.percent.toFixed(1)}% · ${fmtSpeed(j.speedBps)}`
                  : j.status === 'done'
                    ? '已完成'
                    : j.status === 'failed'
                      ? `失败：${j.error ?? ''}`
                      : j.status}
              </span>
              {j.status === 'running' && (
                <button className="x" onClick={() => void window.panhub.cancel(j.id)}>
                  取消
                </button>
              )}
              {j.status === 'done' && (
                <button className="link tiny" onClick={() => void window.panhub.reveal(j.destPath)}>
                  打开位置
                </button>
              )}
            </div>
            <div className="bar">
              <div style={{ width: `${Math.min(100, j.percent)}%` }} />
            </div>
          </div>
        ))}
      </footer>
    </div>
  );
}
