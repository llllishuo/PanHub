/**
 * 引擎二进制路径解析
 *
 * 纯函数，依赖通过参数注入，因此可以在任意平台上被 headless 测试
 * （模拟 macOS / Linux 的目录结构而不需要真的在那两个系统上跑）。
 *
 * 为什么需要这段逻辑：
 *   Node 的                process.platform → win32 / darwin / linux
 *   Python 的 platform.system()            → windows / darwin / linux
 *   electron-builder 的 ${os}              → win / mac / linux
 *   electron-builder 的 ${arch}            → x64 / arm64
 *   OpenList 发行包的架构名                → amd64 / arm64
 *
 * 四套命名互不一致，任何一处对不上就是「应用启动时找不到引擎」。
 * 与其在构建配置里反复对齐宏，不如运行时按已知别名逐个尝试、
 * 最后再扫一层目录兜底。
 */

export interface EnginePathContext {
  /** process.platform */
  platform: string;
  /** process.arch */
  arch: string;
  /** app.isPackaged */
  isPackaged: boolean;
  /** process.resourcesPath */
  resourcesPath: string;
  /** app.getAppPath() */
  appPath: string;
  exists: (p: string) => boolean;
  /** 列出某个目录下的子目录名；目录不存在时返回 [] */
  listDirs: (p: string) => string[];
}

/** 开发模式下的引擎目录名，例如 windows-amd64 / darwin-arm64 / linux-amd64 */
export function engineDirName(platform: string, arch: string): string {
  const plat = platform === 'win32' ? 'windows' : platform;
  const a = arch === 'x64' ? 'amd64' : arch;
  return `${plat}-${a}`;
}

export function engineBinaryName(platform: string): string {
  return platform === 'win32' ? 'openlist.exe' : 'openlist';
}

/**
 * 按输入路径的风格推导分隔符。
 *
 * 不能硬编码成 '\\'：那样在 macOS/Linux 上拼出来的路径是
 * `/app/resources\sidecar\openlist`，文件根本不存在 —— 表现为引擎永远启动失败。
 * 这里根据已有分隔符判断，Windows 盘符（C:\ 或 C:/）优先判为反斜杠。
 */
function separatorOf(parts: string[]): string {
  const sample = parts.join('');
  const hasBack = sample.includes('\\');
  const hasFwd = sample.includes('/');
  if (hasBack && !hasFwd) return '\\';
  if (hasFwd && !hasBack) return '/';
  if (/^[A-Za-z]:[\\/]/.test(parts[0] ?? '')) return '\\';
  return '/';
}

/** 拼接路径，不依赖 node:path，便于在任意平台上测试 */
function join(...parts: string[]): string {
  const sep = separatorOf(parts);
  return parts
    .filter((p) => p !== '')
    .map((p, i) =>
      i === 0
        ? p.replace(/[\\/]+$/, '')
        : p.replace(new RegExp(`^[\\\\/]+|[\\\\/]+$`, 'g'), ''),
    )
    .join(sep);
}

const PLAT_ALIASES: Record<string, string[]> = {
  win32: ['windows', 'win32', 'win'],
  darwin: ['darwin', 'mac', 'macos'],
  linux: ['linux'],
};

/**
 * 解析引擎二进制路径。
 * 找不到时返回首个候选（调用方据此给出「找不到引擎」的明确报错）。
 */
export function resolveEnginePath(ctx: EnginePathContext): string {
  const name = engineBinaryName(ctx.platform);

  // 开发模式：仓库内的固定布局
  if (!ctx.isPackaged) {
    return join(ctx.appPath, 'resources', 'sidecar', engineDirName(ctx.platform, ctx.arch), name);
  }

  const base = join(ctx.resourcesPath, 'sidecar');
  const archAliases = ctx.arch === 'x64' ? ['amd64', 'x64'] : [ctx.arch];
  const platAliases = PLAT_ALIASES[ctx.platform] ?? [ctx.platform];

  // 1) 摊平布局
  const flat = join(base, name);
  if (ctx.exists(flat)) return flat;

  // 2) 已知的平台-架构组合
  for (const plat of platAliases) {
    for (const arch of archAliases) {
      const candidate = join(base, `${plat}-${arch}`, name);
      if (ctx.exists(candidate)) return candidate;
    }
  }

  // 3) 兜底：扫一层子目录
  for (const dir of ctx.listDirs(base)) {
    const candidate = join(base, dir, name);
    if (ctx.exists(candidate)) return candidate;
  }

  return flat;
}
