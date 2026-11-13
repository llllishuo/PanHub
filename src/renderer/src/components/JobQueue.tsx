import { useState } from 'react';
import { summarize, useJobs } from '../lib/jobs.ts';
import { fmtEta, fmtSize, fmtSpeed } from '../lib/format.ts';
import { bridge } from '../lib/bridge.ts';

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '下载中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export default function JobQueue() {
  const jobs = useJobs();
  const [open, setOpen] = useState(false);
  const s = summarize(jobs);

  if (jobs.length === 0) return null;

  const active = s.running + s.queued;
  const visible = open ? jobs : jobs.filter((j) => j.status === 'running' || j.status === 'queued');

  return (
    <section className={`jobs ${open ? 'expanded' : ''}`}>
      <button className="jobs-head" onClick={() => setOpen((v) => !v)}>
        <span className="jobs-title">
          {active > 0 ? (
            <>
              <span className="pulse" /> {active} 个任务进行中
            </>
          ) : (
            <>下载任务</>
          )}
        </span>
        <span className="jobs-summary">
          {s.done > 0 && <em className="ok">{s.done} 完成</em>}
          {s.failed > 0 && <em className="err">{s.failed} 失败</em>}
        </span>
        <span className="chev">{open ? '▾' : '▴'}</span>
      </button>

      <div className="jobs-body">
        {visible.map((j) => {
          const remain = Math.max(0, j.total - j.downloaded);
          return (
            <div key={j.id} className={`job ${j.status}`}>
              <div className="job-line">
                <span className="job-name" title={j.destPath}>
                  {j.name}
                </span>
                <span className="job-meta">
                  {j.status === 'running' && (
                    <>
                      {fmtSize(j.downloaded)} / {fmtSize(j.total)} · {fmtSpeed(j.speedBps)}
                      {remain > 0 && j.speedBps > 0 && ` · 剩 ${fmtEta(remain, j.speedBps)}`}
                    </>
                  )}
                  {j.status !== 'running' && STATUS_TEXT[j.status]}
                  {j.status === 'failed' && j.error ? `：${j.error}` : ''}
                </span>
                <span className="job-actions">
                  {(j.status === 'running' || j.status === 'queued') && (
                    <button className="btn tiny ghost" onClick={() => bridge.cancel(j.id)}>
                      取消
                    </button>
                  )}
                  {j.status === 'done' && (
                    <button className="btn tiny ghost" onClick={() => bridge.reveal(j.destPath)}>
                      打开位置
                    </button>
                  )}
                </span>
              </div>
              <div className="progress">
                <div
                  className="progress-fill"
                  style={{ transform: `scaleX(${Math.min(1, j.percent / 100)})` }}
                />
              </div>
            </div>
          );
        })}
        {!open && s.done + s.failed > 0 && (
          <button className="jobs-more" onClick={() => setOpen(true)}>
            查看全部 {jobs.length} 个任务
          </button>
        )}
      </div>
    </section>
  );
}
