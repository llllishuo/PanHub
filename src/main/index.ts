/**
 * Electron 主进程 —— 只做外壳
 *
 * 所有业务逻辑都在 src/main/service.ts（纯 Node），这里只负责：
 *  1. 创建窗口
 *  2. 把 OS 级 safeStorage 注入保险箱
 *  3. 暴露受控的 IPC 通道
 *  4. 退出前释放引擎与密钥
 */
// 主进程以 CJS 输出（见 electron.vite.config.ts 注释），因此可以正常具名导入
import { app, BrowserWindow, dialog, ipcMain, safeStorage, screen, shell } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { PanhubService, EngineApiError, type JobState } from './service.ts';
import { resolveEnginePath } from '../core/engine-path.ts';
import { SafeStorageKeyStore } from './keystore.ts';

let win: BrowserWindow | null = null;
let service: PanhubService | null = null;
let disposing = false;

/**
 * 引擎二进制所在目录名。
 *
 * 注意命名口径：Node 的 process.platform 在 Windows 上是 "win32"，
 * 而 scripts/fetch_engine.py 用 Python 的 platform.system().lower() 得到 "windows"。
 * 两边必须统一成 "windows"，否则永远找不到文件。
 */
function resolveEngineBin(): string {
  // ???????????src/core/engine-path.ts???? headless ?????
  // ?????? Electron / Node ?????? fs ?????
  return resolveEnginePath({
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    exists: existsSync,
    listDirs: (p) => {
      try {
        return readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
  });
}

function requireService(): PanhubService {
  if (!service) throw new Error('服务尚未初始化');
  return service;
}

function broadcast(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow(): void {
  // 按工作区实际尺寸算窗口大小并显式定位。
  // 固定像素在 125%/150% 缩放下会超出屏幕，`center: true` 在混合 DPI 下也不可靠，
  // 因此这里自行计算坐标，并对越界做钳制。
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workArea ?? disp.bounds;
  const width = Math.min(1120, Math.floor(wa.width * 0.9));
  const height = Math.min(740, Math.floor(wa.height * 0.9));
  const x = Math.max(wa.x, wa.x + Math.floor((wa.width - width) / 2));
  const y = Math.max(wa.y, wa.y + Math.floor((wa.height - height) / 2));

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: Math.min(880, width),
    minHeight: Math.min(560, height),
    show: false,
    autoHideMenuBar: true,
    title: 'PanHub',
    backgroundColor: '#0a0c11',
    webPreferences: {
      // 不用 import.meta.dirname（CJS 下不存在），统一从 app 根目录推导
      preload: join(app.getAppPath(), 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    // 记录一次实际几何，便于排查不同 DPI 下的显示问题
    const b = win?.getBounds();
    console.error(
      `[panhub] 窗口 ${b?.width}x${b?.height} @ (${b?.x},${b?.y})` +
        ` 工作区 ${wa.width}x${wa.height} scale=${disp.scaleFactor}`,
    );
    win?.show();
  });

  // 外部链接一律交给系统浏览器，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'));
  }

  win.on('closed', () => {
    win = null;
  });
}

function registerIpc(): void {
  ipcMain.handle('app:status', async () => {
    if (!service) return { engineRunning: false, engineUrl: null, initialized: false, accounts: 0 };
    return await service.status();
  });

  ipcMain.handle('app:startEngine', async () => {
    const { url } = await requireService().startEngine();
    return { url };
  });

  ipcMain.handle('app:stopEngine', async () => {
    await requireService().stopEngine();
    return { ok: true };
  });

  ipcMain.handle('drivers:list', async () => {
    try {
      return await requireService().driverCatalog();
    } catch {
      return {};
    }
  });

  // 引擎尚未就绪时返回空列表，而不是把异常甩给界面
  ipcMain.handle('mounts:list', async () => {
    try {
      return await requireService().listMounts();
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    'mounts:add',
    async (_e, input: { mountPath: string; driver: string; addition: unknown; remark?: string }) => {
      const addition =
        typeof input.addition === 'string'
          ? (JSON.parse(input.addition) as Record<string, unknown>)
          : (input.addition as Record<string, unknown>);
      await requireService().addMount({
        mountPath: input.mountPath,
        driver: input.driver,
        addition,
        remark: input.remark,
      });
      return { ok: true };
    },
  );

  ipcMain.handle('mounts:remove', async (_e, id: number) => {
    await requireService().removeMount(id);
    return { ok: true };
  });

  // 根目录在没有挂载任何网盘时会返回 500（storage not found），
  // 引擎未就绪时会抛「引擎尚未启动」——两者都是正常的临时状态，
  // 一律以空列表回应，不要当成错误弹给用户。
  ipcMain.handle('fs:list', async (_e, path: string) => {
    try {
      return await requireService().browse(path);
    } catch (e) {
      if (e instanceof EngineApiError && e.code === 500) return [];
      if (/引擎尚未启动/.test((e as Error)?.message ?? '')) return [];
      throw e;
    }
  });

  ipcMain.handle('download:start', async (_e, input: { remotePath: string; destDir: string }) => {
    const job = await requireService().enqueueDownload(input.remotePath, input.destDir);
    return job;
  });

  ipcMain.handle('download:cancel', async (_e, id: string) => {
    return { ok: requireService().cancelJob(id) };
  });

  ipcMain.handle('jobs:list', async () => requireService().listJobs());

  ipcMain.handle('dialog:pickFolder', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle('shell:reveal', async (_e, p: string) => {
    shell.showItemInFolder(p);
    return { ok: true };
  });

  ipcMain.handle('app:resetAccounts', async () => {
    await requireService().wipeEngineData();
    return { ok: true };
  });
}

async function bootService(): Promise<void> {
  const bin = resolveEngineBin();
  service = new PanhubService({
    appDataDir: join(app.getPath('userData'), 'data'),
    engineBin: bin,
    keyStore: new SafeStorageKeyStore(join(app.getPath('userData'), 'master.key'), safeStorage),
  });

  service.on('job', (j: JobState) => broadcast('job:update', j));
  service.on('engine', (s: unknown) => broadcast('engine:update', s));
  service.on('warn', (m: string) => {
    // 同时打到 stderr：打包后也能在日志里追到
    console.error(`[panhub] 警告: ${m}`);
    broadcast('engine:warn', m);
  });
}

app.whenReady().then(async () => {
  registerIpc();
  await bootService();
  createWindow();

  // 引擎启动放在窗口之后：让界面先出来，再显示"启动中"
  void (async () => {
    const bin = resolveEngineBin();
    console.error(`[panhub] 引擎路径: ${bin}（存在=${existsSync(bin)}, arch=${process.arch}）`);
    try {
      const { url } = await requireService().startEngine();
      console.error(`[panhub] 引擎已就绪: ${url}`);
      broadcast('engine:update', { running: true, url });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      // 打到 stderr 便于排查（打包后也能在日志里看到）
      console.error(`[panhub] 引擎启动失败: ${msg}`);
      broadcast('engine:error', msg);
    }
  })();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 单实例：多开会争抢引擎数据目录
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

async function shutdown(): Promise<void> {
  if (disposing) return;
  disposing = true;
  try {
    await service?.dispose();
  } catch {
    /* 关闭阶段的错误不再抛出 */
  }
  service = null;
}

/**
 * 优雅退出。
 *
 * 关键：必须 preventDefault 拦下第一次 quit，等加密回盘真正完成后再退。
 * 否则 Electron 会立刻终止进程，正在重试中（引擎刚退出、文件句柄未释放）
 * 的 sealEngineData 会被掐断 —— 表现就是每次退出都静默留下明文 data.db。
 */
let quitting = false;

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    try {
      await shutdown();
    } finally {
      app.quit();
    }
  })();
});

app.on('window-all-closed', () => {
  // macOS 惯例：关窗不退出应用，交由用户 Cmd+Q；此时 before-quit 才封盘
  if (process.platform !== 'darwin') app.quit();
});

// 系统关机/注销时也尽力封盘
app.on('will-quit', () => {
  /* 真正的释放已在 before-quit 完成 */
});
