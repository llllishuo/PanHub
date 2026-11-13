/** 格式化工具 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${UNITS[i]}`;
}

export function fmtSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '';
  return `${fmtSize(bps)}/s`;
}

export function fmtEta(remainBytes: number, bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0 || remainBytes <= 0) return '';
  const s = Math.round(remainBytes / bps);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分`;
  return `${(s / 3600).toFixed(1)} 小时`;
}

const EXT_ICON: Record<string, string> = {
  mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', flv: '🎬', webm: '🎬',
  mp3: '🎵', flac: '🎵', wav: '🎵', m4a: '🎵', aac: '🎵',
  jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', bmp: '🖼️',
  zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
  pdf: '📕', doc: '📄', docx: '📄', txt: '📝', md: '📝',
  xls: '📊', xlsx: '📊', csv: '📊', ppt: '📽️', pptx: '📽️',
  exe: '⚙️', msi: '⚙️', dmg: '⚙️', apk: '📱', iso: '💿',
  ts: '💻', js: '💻', py: '💻', go: '💻', json: '🧾', yaml: '🧾', yml: '🧾',
};

export function fileIcon(item: { name: string; is_dir: boolean }): string {
  if (item.is_dir) return '📁';
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_ICON[ext] ?? '📄';
}

/** 拼接远端路径，避免出现双斜杠 */
export function joinPath(base: string, name: string): string {
  const b = base === '/' ? '' : base.replace(/\/+$/, '');
  return `${b}/${name}`;
}

export function parentPath(p: string): string {
  const clean = p.replace(/\/+$/, '');
  if (!clean || clean === '/') return '/';
  const idx = clean.lastIndexOf('/');
  return idx <= 0 ? '/' : clean.slice(0, idx);
}
