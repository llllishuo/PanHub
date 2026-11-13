import type { EngineStatus } from '../types.ts';

interface Props {
  status: EngineStatus | null;
  onAdd: () => void;
  onRefresh: () => void;
  onStartEngine: () => void;
  busy: boolean;
}

export default function TitleBar({ status, onAdd, onRefresh, onStartEngine, busy }: Props) {
  const running = status?.engineRunning ?? false;
  return (
    <header className="titlebar">
      <div className="brand">
        <span className="logo">◈</span>
        <span className="brand-name">PanHub</span>
      </div>

      <div className={`engine-pill ${running ? 'on' : 'off'}`} title={status?.engineUrl ?? ''}>
        <span className="dot" />
        {running ? '引擎就绪' : '引擎未启动'}
      </div>

      <div className="spacer" />

      {!running && (
        <button className="btn primary sm" onClick={onStartEngine} disabled={busy}>
          {busy ? '启动中…' : '启动引擎'}
        </button>
      )}
      <button className="btn ghost sm" onClick={onRefresh} disabled={!running}>
        刷新
      </button>
      <button className="btn sm" onClick={onAdd} disabled={!running}>
        ＋ 添加网盘
      </button>
    </header>
  );
}
