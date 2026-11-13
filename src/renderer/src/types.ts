/** 渲染层共享类型 */

export interface FsItem {
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
}

export interface Mount {
  id: number;
  mount_path: string;
  driver: string;
  status: string;
  remark?: string;
}

export interface Job {
  id: string;
  name: string;
  destPath: string;
  total: number;
  downloaded: number;
  percent: number;
  speedBps: number;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  error?: string;
}

export interface EngineStatus {
  engineRunning: boolean;
  engineUrl: string | null;
  initialized: boolean;
  accounts: number;
}

/** 驱动配置字段定义（来自引擎 /api/admin/driver/list） */
export interface DriverField {
  name: string;
  type: 'string' | 'text' | 'bool' | 'number' | 'select';
  default: string;
  options: string;
  required: boolean;
  help: string;
}

export interface DriverDef {
  name: string;
  local_sort?: boolean;
  only_proxy?: boolean;
  need_ms?: boolean;
  default_root?: string;
  alert?: string;
  /** 通用字段：mount_path / order / remark */
  common: DriverField[];
  /** 驱动专属字段：cookie / token / root_folder_path … */
  additional: DriverField[];
}

export type DriverCatalog = Record<string, DriverDef>;

/** 常见网盘的中文名与图标，用于提升可读性 */
export const DRIVER_LABELS: Record<string, { label: string; icon: string }> = {
  BaiduNetdisk: { label: '百度网盘', icon: '🐾' },
  Aliyundrive: { label: '阿里云盘', icon: '☁️' },
  AliyundriveOpen: { label: '阿里云盘 Open', icon: '☁️' },
  AliyundriveShare: { label: '阿里云盘分享', icon: '🔗' },
  Quark: { label: '夸克网盘', icon: '⚡' },
  QuarkOpen: { label: '夸克 Open', icon: '⚡' },
  UC: { label: 'UC 网盘', icon: '🅤' },
  '115 Cloud': { label: '115 网盘', icon: '💠' },
  '115 Open': { label: '115 Open', icon: '💠' },
  Thunder: { label: '迅雷云盘', icon: '🌩️' },
  ThunderX: { label: '迅雷 X', icon: '🌩️' },
  Lanzou: { label: '蓝奏云', icon: '📦' },
  ILanZou: { label: '蓝奏云(优享)', icon: '📦' },
  '189Cloud': { label: '天翼云盘', icon: '📡' },
  '189CloudPC': { label: '天翼云盘 PC', icon: '📡' },
  '123Pan': { label: '123 云盘', icon: '🎯' },
  WeiYun: { label: '腾讯微云', icon: '💬' },
  Onedrive: { label: 'OneDrive', icon: '🪟' },
  GoogleDrive: { label: 'Google Drive', icon: '🅶' },
  Dropbox: { label: 'Dropbox', icon: '📘' },
  Mega_nz: { label: 'MEGA', icon: 'Ⓜ️' },
  PikPak: { label: 'PikPak', icon: '📌' },
  Local: { label: '本地目录', icon: '💾' },
  WebDav: { label: 'WebDAV', icon: '🌐' },
  S3: { label: 'S3 对象存储', icon: '🪣' },
  SMB: { label: 'SMB 共享', icon: '🗂️' },
  SFTP: { label: 'SFTP', icon: '🔐' },
  FTP: { label: 'FTP', icon: '📁' },
  Terabox: { label: 'TeraBox', icon: '📦' },
  '139Yun': { label: '移动云盘', icon: '📱' },
};

export function driverLabel(name: string): { label: string; icon: string } {
  return DRIVER_LABELS[name] ?? { label: name, icon: '☁️' };
}
