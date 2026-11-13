import type { Mount } from '../types.ts';
import { driverLabel } from '../types.ts';

interface Props {
  mounts: Mount[];
  activePath: string;
  onOpen: (path: string) => void;
  onAdd: () => void;
  onRemove: (id: number) => void;
}

export default function Sidebar({ mounts, activePath, onOpen, onAdd, onRemove }: Props) {
  return (
    <aside className="sidebar">
      <div className="side-head">
        <span>我的网盘</span>
        <button className="icon-btn accent" onClick={onAdd} title="添加网盘">
          ＋
        </button>
      </div>

      <div className="mount-list">
        <button
          className={`mount ${activePath === '/' ? 'active' : ''}`}
          onClick={() => onOpen('/')}
        >
          <span className="mount-icon">🏠</span>
          <span className="mount-main">
            <span className="mount-name">全部文件</span>
            <span className="mount-sub">所有已连接的网盘</span>
          </span>
        </button>

        {mounts.map((m) => {
          const { label, icon } = driverLabel(m.driver);
          const active = activePath === m.mount_path || activePath.startsWith(m.mount_path + '/');
          return (
            <div key={m.id} className={`mount ${active ? 'active' : ''}`}>
              <button className="mount-body" onClick={() => onOpen(m.mount_path)}>
                <span className="mount-icon">{icon}</span>
                <span className="mount-main">
                  <span className="mount-name">{m.remark?.trim() || label}</span>
                  <span className="mount-sub">
                    {m.mount_path}
                    {m.status !== 'work' && <em className="warn-tag"> 已禁用</em>}
                  </span>
                </span>
              </button>
              <button
                className="mount-del"
                title="移除这个网盘"
                onClick={() => onRemove(m.id)}
              >
                ✕
              </button>
            </div>
          );
        })}

        {mounts.length === 0 && (
          <div className="side-empty">
            <p>还没有连接任何网盘</p>
            <button className="btn primary block" onClick={onAdd}>
              添加第一个网盘
            </button>
          </div>
        )}
      </div>

      <div className="side-foot">
        <p className="tiny muted">
          凭据以 AES-256-GCM 加密存放于本机，主密钥由系统凭据库保管。
          本工具不突破服务端带宽限制。
        </p>
      </div>
    </aside>
  );
}
