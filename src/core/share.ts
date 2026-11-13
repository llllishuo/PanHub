/**
 * 分享链接解析
 *
 * 纯函数、零依赖，可被 headless 测试完整覆盖。
 *
 * 设计原则（重要）：只承诺引擎真的具备的能力。
 * OpenList v4.2.9 里只有部分网盘提供「分享」驱动：
 *   AliyundriveShare / 115 Share / 123PanShare / 123PanLink /
 *   PikPakShare / Onedrive Sharelink / DoubaoShare / OpenListShare
 * 百度、夸克、UC、迅雷、蓝奏、天翼、微云、TeraBox **没有**分享驱动，
 * 因此这些链接只做识别与说明，不假装能解析。
 */

export interface ShareProvider {
  key: string;
  label: string;
  /** 匹配主机名 */
  hosts: RegExp;
  /** 从路径里提取分享 ID */
  idPattern: RegExp;
  /** 引擎里的分享驱动名；null 表示引擎不支持 */
  driver: string | null;
  /** 分享 ID 对应驱动的哪个字段 */
  idField?: string;
  /** 提取码对应驱动的哪个字段 */
  pwdField?: string;
  /** 该驱动还需要用户自己提供的必填字段 */
  extraRequired?: string[];
  /** 需要完整 URL 而不是 ID */
  wantsFullUrl?: boolean;
  note?: string;
}

export interface ShareParseResult {
  provider: string;
  providerLabel: string;
  shareId: string;
  password: string;
  url: string;
  driver: string | null;
  /** 可直接预填到驱动 addition 的字段 */
  addition: Record<string, string>;
  /** 仍需用户补充的字段 */
  missing: string[];
  supported: boolean;
  note: string;
}

export class ShareParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareParseError';
  }
}

/** 提取码常见写法：?pwd=、提取码:、密码：、code= */
const PWD_PATTERNS: RegExp[] = [
  /[?&#](?:pwd|password|passcode|code)=([A-Za-z0-9]{2,12})/i,
  /(?:提取码|访问码|密码|提取密码)\s*[:：]?\s*([A-Za-z0-9]{2,12})/,
  /(?:pwd|password)\s*[:：]\s*([A-Za-z0-9]{2,12})/i,
];

const URL_RE = /https?:\/\/[^\s"'<>，。、）)]+/i;

export const SHARE_PROVIDERS: ShareProvider[] = [
  {
    key: 'baidu',
    label: '百度网盘',
    hosts: /(?:^|\.)(?:pan|yun)\.baidu\.com$/i,
    idPattern: /\/s\/([A-Za-z0-9_-]+)/,
    driver: null,
    note:
      'OpenList 没有百度网盘的「分享」驱动，无法直接解析该链接。' +
      '可以改用「百度网盘」驱动登录自己的账号，或先转存到自己的网盘再下载。',
  },
  {
    key: 'aliyun',
    label: '阿里云盘',
    hosts: /(?:^|\.)(?:alipan|aliyundrive)\.com$/i,
    idPattern: /\/(?:s|share)\/([A-Za-z0-9]+)/,
    driver: 'AliyundriveShare',
    idField: 'share_id',
    pwdField: 'share_pwd',
    extraRequired: ['refresh_token'],
    note: '分享驱动需要你自己的阿里云盘 refresh_token 才能读取内容。',
  },
  {
    key: 'quark',
    label: '夸克网盘',
    hosts: /(?:^|\.)pan\.quark\.cn$/i,
    idPattern: /\/s\/([A-Za-z0-9]+)/,
    driver: null,
    note: 'OpenList 没有夸克的分享驱动；夸克驱动只能登录自己的账号后浏览。',
  },
  {
    key: 'uc',
    label: 'UC 网盘',
    hosts: /(?:^|\.)drive\.uc\.cn$/i,
    idPattern: /\/s\/([A-Za-z0-9]+)/,
    driver: null,
    note: 'OpenList 没有 UC 的分享驱动。',
  },
  {
    key: '115',
    label: '115 网盘',
    hosts: /(?:^|\.)115(?:cdn)?\.com$/i,
    idPattern: /\/s\/([A-Za-z0-9]+)/,
    driver: '115 Share',
    idField: 'share_code',
    pwdField: 'receive_code',
    note: '115 分享驱动要求同时填写分享码与接收码。',
  },
  {
    key: 'xunlei',
    label: '迅雷云盘',
    hosts: /(?:^|\.)pan\.xunlei\.com$/i,
    idPattern: /\/s\/([A-Za-z0-9_-]+)/,
    driver: null,
    note: 'OpenList 没有迅雷的分享驱动。',
  },
  {
    key: '123pan',
    label: '123 云盘',
    hosts: /(?:^|\.)123(?:pan|684|865|912)\.(?:com|cn)$/i,
    idPattern: /\/s\/([A-Za-z0-9-]+)/,
    driver: '123PanShare',
    idField: 'sharekey',
    pwdField: 'sharepassword',
    note: '123 分享驱动通常无需登录即可读取。',
  },
  {
    key: 'lanzou',
    label: '蓝奏云',
    hosts: /(?:^|\.)(?:lanzou[a-z]*|lanzn|lanzt)\.(?:com|cn)$/i,
    idPattern: /\/([A-Za-z0-9]{4,})/,
    driver: null,
    note: 'OpenList 的蓝奏驱动用于登录账号，不支持解析分享链接。',
  },
  {
    key: '189',
    label: '天翼云盘',
    hosts: /(?:^|\.)cloud\.189\.cn$/i,
    idPattern: /\/t\/([A-Za-z0-9]+)/,
    driver: null,
    note: 'OpenList 没有天翼云盘的分享驱动。',
  },
  {
    key: 'weiyun',
    label: '腾讯微云',
    hosts: /(?:^|\.)share\.weiyun\.com$/i,
    idPattern: /\/([A-Za-z0-9]{8,})/,
    driver: null,
    note: 'OpenList 没有微云的分享驱动。',
  },
  {
    key: 'pikpak',
    label: 'PikPak',
    hosts: /(?:^|\.)mypikpak\.com$/i,
    idPattern: /\/s\/([A-Za-z0-9]+)/,
    driver: 'PikPakShare',
    idField: 'share_id',
    pwdField: 'share_pwd',
    note: 'PikPak 分享驱动可直接读取。',
  },
  {
    key: 'terabox',
    label: 'TeraBox',
    hosts: /(?:^|\.)(?:terabox|1024tera|4funbox)\.com$/i,
    idPattern: /\/s\/([A-Za-z0-9_-]+)/,
    driver: null,
    note: 'OpenList 没有 TeraBox 的分享驱动。',
  },
  {
    key: 'onedrive',
    label: 'OneDrive',
    hosts: /(?:^|\.)(?:1drv\.ms|onedrive\.live\.com|sharepoint\.com)$/i,
    idPattern: /\/[a-z]\/([A-Za-z0-9]+)/,
    driver: 'Onedrive Sharelink',
    idField: 'url',
    pwdField: 'password',
    wantsFullUrl: true,
    note: 'OneDrive 分享驱动直接接收完整链接。',
  },
];

/** 提取第一个 URL；没有则返回 null */
export function extractUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  return m[0].replace(/[.,;:]+$/, '');
}

/** 从整段文本里提取提取码 */
export function extractPassword(text: string): string {
  for (const re of PWD_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new ShareParseError(`不是合法的链接：${url}`);
  }
}

/**
 * 解析分享链接或分享口令文本（百度 App 那种「复制这段内容…提取码:xxxx」也能识别）
 */
export function parseShareLink(input: string): ShareParseResult {
  const text = (input ?? '').trim();
  if (!text) throw new ShareParseError('请输入分享链接');

  const url = extractUrl(text);
  if (!url) {
    throw new ShareParseError('这段文本里没有找到链接，请粘贴完整的分享链接');
  }

  const host = hostOf(url);
  const provider = SHARE_PROVIDERS.find((p) => p.hosts.test(host));
  if (!provider) {
    throw new ShareParseError(
      `暂不支持该站点：${host}。目前可识别：` +
        SHARE_PROVIDERS.map((p) => p.label).join('、'),
    );
  }

  const path = (() => {
    try {
      return new URL(url).pathname + new URL(url).search;
    } catch {
      return url;
    }
  })();

  let shareId = '';
  if (provider.wantsFullUrl) {
    shareId = url;
  } else {
    const m = provider.idPattern.exec(path) ?? provider.idPattern.exec(url);
    shareId = m?.[1] ?? '';
  }

  if (!shareId) {
    throw new ShareParseError(`识别到「${provider.label}」分享，但无法从链接里提取分享 ID`);
  }

  const password = extractPassword(text);

  const addition: Record<string, string> = {};
  const missing: string[] = [];
  if (provider.driver && provider.idField) {
    addition[provider.idField] = shareId;
    if (provider.pwdField && password) addition[provider.pwdField] = password;
    for (const f of provider.extraRequired ?? []) {
      if (!addition[f]) missing.push(f);
    }
  }

  return {
    provider: provider.key,
    providerLabel: provider.label,
    shareId,
    password,
    url,
    driver: provider.driver,
    addition,
    missing,
    supported: provider.driver !== null,
    note: provider.note ?? '',
  };
}
