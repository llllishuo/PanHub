# PanHub

跨平台网盘聚合下载器 —— 一次登录，多网盘统一下载。

> ## ⚠️ 重要声明（请先读）
>
> **本仓库全部代码由人工智能（AI）生成**，未经执业律师审查，也未经专业安全审计。
> 作者不对使用后果承担任何责任。完整条款见 **[DISCLAIMER.md](DISCLAIMER.md)**。
>
> - 本工具**不**破解、不绕过任何付费服务的带宽限制。速度取决于服务端对你账号的实际授权。
> - 自动化访问第三方网盘**可能违反其服务条款**，存在账号受限风险，**由使用者自行承担**。
> - 本项目与任何网盘服务商均无隶属、合作或授权关系。
> - 商业使用或对外分发前，请自行完成代码审计与法律合规评估。

---

## 当前状态

本仓库的核心层、界面层与 Windows 打包链路均已实测通过；macOS / Linux 安装包由
GitHub Actions 矩阵构建。为避免误导，逐项如实标注：

| 模块 | 状态 | 说明 |
|---|---|---|
| 加密保险箱 | ✅ 已验证 | AES-256-GCM，主密钥不落盘 |
| 多线程下载器 | ✅ 已验证 | 分片 / 续传 / 重试 / 进度 |
| 引擎进程管理 | ✅ 已验证 | 生命周期、安全基线、确定性终止 |
| 引擎 API 客户端 | ✅ 已验证 | 实测 93 个存储驱动 |
| 编排层（服务） | ✅ 已验证 | 会话目录隔离、静态加密、作业队列 |
| 端到端闭环 | ✅ 已验证 | 引擎→存储→列表→直链→下载→哈希一致 |
| Electron 主进程 + 界面 | ✅ 已实现 | 启停引擎、添加网盘、浏览、下载队列 |
| 各网盘登录引导 | 🟡 部分 | 按驱动字段定义自动生成表单；OAuth/扫码引导未做 |
| 分享链接解析 | ✅ 已验证 | 13 类网盘识别；5 类可解析（见下） |
| 三平台安装包 | 🟡 部分 | Windows 本机实测全通；macOS / Linux 由 GitHub Actions 矩阵构建（见下） |

### 分享链接：能力边界（如实标注）

解析器只承诺引擎真的具备的能力。OpenList v4.2.9 只有部分网盘提供「分享」驱动：

| 网盘 | 识别 | 可解析 | 说明 |
|---|---|---|---|
| 阿里云盘 | ✅ | ✅ `AliyundriveShare` | 仍需你自己的 `refresh_token` |
| 115 | ✅ | ✅ `115 Share` | 需分享码 + 接收码 |
| 123 云盘 | ✅ | ✅ `123PanShare` | 通常无需登录 |
| PikPak | ✅ | ✅ `PikPakShare` | |
| OneDrive | ✅ | ✅ `Onedrive Sharelink` | 直接接收完整链接 |
| 百度 / 夸克 / UC / 迅雷 / 蓝奏 / 天翼 / 微云 / TeraBox | ✅ | ❌ | 引擎没有对应分享驱动，界面会明确说明并给出替代做法 |

不支持的那 8 类**不会假装能解析**——解析结果里 `supported=false` 并附带原因，
这是刻意的：把事情说清楚，比让用户以为能用然后失败要好。

**测试证据**：65 个测试全部通过，连续 4 次运行稳定，结束后系统层面无残留子进程。

```bash
pnpm install
pnpm test        # 65 tests / 65 pass
```

> 测试分五组：保险箱安全属性（13）、下载器真实 HTTP 分片（10）、引擎进程管理（6）、
> 端到端集成（5）、编排层（4）。其中端到端组会真实拉起引擎、真实建存储、真实发
> HTTP Range 请求，并用 SHA-256 逐字节校验下载结果。

## 设计要点

### 分层：核心零框架依赖

```
src/
├── core/          ← 零 Electron 依赖，纯 Node ESM，可被 node --test 直接覆盖
│   ├── vault.ts       加密保险箱（AES-256-GCM + AAD 绑定）
│   ├── downloader.ts  多线程分片下载（Range / 续传 / 重试）
│   ├── sidecar.ts     引擎子进程管理 + 安全基线
│   └── client.ts      引擎 HTTP 客户端
└── main/
    └── service.ts     编排层（也是纯 Node，可测试）
```

Electron 外壳尚未编写。刻意让核心层不依赖 Electron，换来的是：**核心逻辑全部可 headless 验证**，且更换 GUI 框架（Electron / Tauri / Wails）只需重写外壳。

### 界面与交互

- **添加网盘不写 JSON**：引擎为每个驱动返回字段定义（`common` + `additional`，含
  `type` / `options` / `required` / `help`），界面据此**自动生成表单**——必填项前置、
  高级项折叠、敏感字段（cookie / token）默认遮蔽可切换显示。93 种存储后端通吃。
- **键盘操作**：`Ctrl/Cmd+F` 或 `/` 聚焦筛选框，`Backspace` 返回上级，`Esc` 关闭对话框，
  文件行 `Enter` 打开/下载。
- **性能**：进度事件先攒批、最多每 150ms 合并提交，并用 `useSyncExternalStore` 让只有
  任务列表重渲染；文件行用 `content-visibility: auto` 让浏览器跳过屏幕外行的渲染。
- 支持 `prefers-reduced-motion`，尊重系统的减少动效设置。

### 安全基线（非可选项）

- 引擎**只绑 `127.0.0.1`**。引擎默认 `0.0.0.0`，那等于把你已登录的全部网盘连同管理接口暴露给整个局域网。
- 每次安装生成独立 `jwt_secret`，不用引擎默认值。
- `ftp` / `sftp` / `s3` / `mcp` 全部关闭，只留 HTTP。
- 管理密码随机生成，存入保险箱，不落明文。
- **明文只存在于一次性临时会话目录**：每次启动在系统临时目录新建工作目录，退出时把引擎数据
  （`config.json` / `data.db`）加密进保险箱再清理该目录。永久数据目录里**从不出现明文**。
  这样绕开了「Windows 上文件被别的句柄占住删不掉」的困境。
- 清扫历史会话目录时按 **pid 判断归属**，绝不误删仍在运行实例的工作目录。

### 关于「不限速」的诚实说明

本项目**不做也不承诺不限速**，原因不是技术保守，而是两条硬事实：

1. **技术上无效**：主流网盘对非会员的限速是**账号级、服务端**执行的，直链本身携带带宽配额。客户端无论如何修改都突破不了服务端给的量。
2. **法律上踩线**：历史上靠服务端漏洞"提速"的方案在国内已被刑事追责，且服务商对异常流量直接封号——用户得到的不是"不限速"，而是"账号被封"。

本项目实际提供的是：**不做客户端限速 + 多线程分片并发**，尽量用满服务端授予的带宽。对限客户端不限 API 的网盘效果接近满速；对严格限速的网盘，就是"给多少用多少"。

## 引擎依赖

网盘协议适配由 [OpenList](https://github.com/OpenListTeam/OpenList) 提供（Go 单文件，实测 93 个驱动）。二进制**不入库**（解压后 111 MB），请自行获取：

```bash
python scripts/fetch_engine.py
```

产物路径：`resources/sidecar/<platform>-<arch>/openlist[.exe]`

## 打包

配置见 [electron-builder.yml](electron-builder.yml)。引擎二进制走 `extraResources`
（不进 asar），因此打包后仍位于 `resources/sidecar/<platform>-<arch>/`，
主进程在打包模式下从 `process.resourcesPath` 解析，与开发模式一致。

```bash
pnpm build                # 先产出 out/
npx electron-builder --win   # 再打包
```

> **国内网络注意**：electron-builder 会从 GitHub 下载 NSIS / 7zip / fpm 等工具，
> 直连常被 `ECONNRESET` 打断。设置镜像即可：
>
> ```bash
> ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> ```

**关于 `electronDist`**：配置里**故意不设**它。一旦指向 `node_modules/electron/dist`，
就只能打宿主架构的包——CI 需要在一个 macOS runner 上同时产出 x64 与 arm64，
那样会直接失败。

本地想省掉 200+ MB 下载时，在命令行覆盖即可（`pnpm dist:win` 等脚本已内置）：

```bash
npx electron-builder --win --config.electronDist=node_modules/electron/dist
```

| 脚本 | 用途 |
|---|---|
| `pnpm dist:win` / `dist:mac` / `dist:linux` | 本地打包，复用本地 Electron |
| `pnpm dist:ci` | CI 用，让 electron-builder 自行下载对应架构 |

### 构建实测（Windows 10 / x64）

| 环节 | 结果 |
|---|---|
| `electron-builder --win --dir` | ✅ `release/win-unpacked`，asar 仅 8.6 MB（引擎未混入） |
| 免安装版启动 | ✅ 引擎从 `resources/sidecar/...` 正常拉起 |
| `electron-builder --win` | ✅ `PanHub-0.1.0-win-x64.exe`，143 MB |
| 静默安装 `/S /D=...` | ✅ 退出码 0，落盘 477 MB，引擎随包 |
| 启动已安装版本 | ✅ 引擎就绪 |
| 静默卸载 `/S` | ✅ 退出码 0，目录清空 |

**未验证的部分**：
- 未配置代码签名证书，安装包会触发 SmartScreen / Gatekeeper 提示
- 未设置应用图标，当前使用 Electron 默认图标
- macOS 产物未做公证（需要 Apple 开发者账号）

### 持续集成：三平台构建

[`.github/workflows/build.yml`](.github/workflows/build.yml) 分两个阶段：

1. **test** —— ubuntu / windows / macos 三平台各跑一遍全部测试。
   这是必要的：测试里有大量路径与文件锁逻辑（Windows 的 EBUSY、会话目录清理、
   路径分隔符），只在 Linux 上跑会漏掉真实平台差异。
2. **package** —— 三个 runner 各出安装包：
   `windows-latest`(x64) / `macos-latest`(x64 + arm64) / `ubuntu-latest`(x64)，
   产物作为 artifact 上传。

**为什么 macOS 只用一个 runner**：原先用 `macos-13`(Intel) + `macos-14`(arm64)
两个 runner，实测 `macos-13` 排队 30 分钟以上仍未分配，直接把整个 run 卡在
`queued`（各 job 早已跑完，run 状态却不结束）。现在改为在 `macos-latest` 上
一次性跨架构打出两个 dmg —— 这也是必须移除 `electronDist` 的原因。

**稳定性措施**：引擎与 electron-builder 的工具链都做 `actions/cache`，
下载步骤与打包步骤各有 3 次重试。CI 上偶发的 `ECONNRESET` 不该把构建判红。

macOS 分两个 runner，是因为配置里 `electronDist` 指向本地解压的 Electron，
只能打宿主架构的包——写死 `arch: [x64, arm64]` 会去做跨架构打包然后失败。

引擎二进制不入库，CI 里每台机器都先跑 `scripts/fetch_engine.py` 自己拉。

#### 为什么引擎路径解析值得单独写测试

Node 的 `process.platform`、Python 的 `platform.system()`、electron-builder 的
`${os}` / `${arch}`、OpenList 发行包的架构名，**四套命名互不一致**
（`win32`/`windows`/`win`、`x64`/`amd64`）。任何一处对不上，表现都是
「应用启动后引擎永远找不到」。

因此解析逻辑被抽成纯函数 [`src/core/engine-path.ts`](src/core/engine-path.ts)，
依赖通过参数注入，11 个用例在 Windows 上就能验证 macOS / Linux 的目录布局。
写测试时它立刻抓到一个真 bug：拼接路径时硬编码了 `\`，在 macOS/Linux 上会拼出
`/app/resources\sidecar\openlist` 这种不存在的路径——引擎必然起不来。

### 实测记录：引擎 v4.2.9 的两个行为陷阱

这两条是逆向验证得出的，已写成回归测试：

1. **首次启动不创建 admin 用户**（只建 `guest`）。此时 `openlist admin set <pw>` 会**退出码 0 但什么都不做**——若代码信任退出码，就会出现「设置成功却登不上」。正路是先 `POST /api/public/init/setup`。
2. **Local 驱动在 Windows 上会对小文件虚报大小**（实测 12 字节文件在 `Content-Range` 里报成 8192）。下载器因此以磁盘实际字节为准，不盲信服务端声称的总长度。

## 许可证

[MIT](LICENSE) + [DISCLAIMER.md](DISCLAIMER.md)。再分发时必须保留 AI 生成声明与免责声明。
