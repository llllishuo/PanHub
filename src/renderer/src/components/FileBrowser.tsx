import { memo, useMemo, useState } from 'react';
import type { FsItem } from '../types.ts';
import { fileIcon, fmtSize } from '../lib/format.ts';

interface Props {
  path: string;
  items: FsItem[];
  loading: boolean;
  onOpen: (p: string) => void;
  onDownload: (item: FsItem) => void;
  onRefresh: () => void;
  onBack: () => void;
}

type SortKey = 'name' | 'size' | 'modified';

const Row = memo(function Row({
  item,
  onOpen,
  onDownload,
}: {
  item: FsItem;
  onOpen: (p: string) => void;
  onDownload: (item: FsItem) => void;
}) {
  return (
    <div
      className={`row ${item.is_dir ? 'dir' : ''}`}
      onDoubleClick={() => item.is_dir && onOpen(item.name)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (item.is_dir) onOpen(item.name);
          else onDownload(item);
        }
      }}
    >
      <span className="row-icon">{fileIcon(item)}</span>
      <span className="row-name" title={item.name}>
        {item.name}
      </span>
      <span className="row-size">{item.is_dir ? '' : fmtSize(item.size)}</span>
      <span className="row-actions">
        {item.is_dir ? (
          <button className="btn tiny ghost" onClick={() => onOpen(item.name)}>
            打开
          </button>
        ) : (
          <button className="btn tiny" onClick={() => onDownload(item)}>
            下载
          </button>
        )}
      </span>
    </div>
  );
});

export default function FileBrowser({
  path,
  items,
  loading,
  onOpen,
  onDownload,
  onRefresh,
  onBack,
}: Props) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [asc, setAsc] = useState(true);

  const crumbs = useMemo(() => {
    const parts = path.split('/').filter(Boolean);
    const acc: { label: string; path: string }[] = [{ label: '全部', path: '/' }];
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      acc.push({ label: p, path: cur });
    }
    return acc;
  }, [path]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? items.filter((i) => i.name.toLowerCase().includes(needle))
      : items;
    const sorted = [...filtered].sort((a, b) => {
      // 文件夹永远在前
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let r = 0;
      if (sort === 'name') r = a.name.localeCompare(b.name, 'zh-Hans-CN');
      else if (sort === 'size') r = a.size - b.size;
      else r = (a.modified ?? '').localeCompare(b.modified ?? '');
      return asc ? r : -r;
    });
    return sorted;
  }, [items, q, sort, asc]);

  const toggleSort = (k: SortKey) => {
    if (k === sort) setAsc((v) => !v);
    else {
      setSort(k);
      setAsc(true);
    }
  };

  return (
    <section className="browser">
      <div className="browser-bar">
        <button className="icon-btn" onClick={onBack} disabled={path === '/'} title="返回上级">
          ←
        </button>
        <nav className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="crumb-sep">/</span>}
              <button
                className={`crumb ${i === crumbs.length - 1 ? 'current' : ''}`}
                onClick={() => onOpen(c.path)}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="spacer" />
        <div className="filter">
          <input
            id="file-filter"
            placeholder="筛选当前目录…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            spellCheck={false}
          />
          {q && (
            <button className="clear" onClick={() => setQ('')} aria-label="清除">
              ✕
            </button>
          )}
        </div>
        <button className="icon-btn" onClick={onRefresh} title="刷新">
          ↻
        </button>
      </div>

      <div className="table-head">
        <button className="th th-name" onClick={() => toggleSort('name')}>
          名称 {sort === 'name' && (asc ? '↑' : '↓')}
        </button>
        <button className="th th-size" onClick={() => toggleSort('size')}>
          大小 {sort === 'size' && (asc ? '↑' : '↓')}
        </button>
        <span className="th th-actions" />
      </div>

      <div className={`rows ${loading ? 'loading' : ''}`}>
        {loading && (
          <div className="skeleton-list">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton-row" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        )}
        {!loading && shown.length === 0 && (
          <div className="empty-inline">
            {q ? '没有匹配的文件' : '这个目录是空的'}
          </div>
        )}
        {!loading &&
          shown.map((it) => (
            <Row
              key={it.name}
              item={it}
              onOpen={(name) => onOpen(name)}
              onDownload={onDownload}
            />
          ))}
      </div>

      <footer className="browser-foot">
        <span className="muted tiny">
          {shown.length} 项{q && ` （已筛选，共 ${items.length}）`} · 双击文件夹进入
        </span>
      </footer>
    </section>
  );
}
