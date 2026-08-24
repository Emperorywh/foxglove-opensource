# desktop

Electron 壳：把 `web` 构建产物打包成 Windows 桌面应用（exe）。

## 原理

- `build.mjs` 用 esbuild 把 `src/main.ts`（含内嵌的 `@foxglove/ssh-bridge` 及
  ws/ssh2 依赖）打包成单文件 `dist/main.js`，因此安装包内不需要 node_modules。
- 主进程启动两个只监听 `127.0.0.1` 的服务：
  1. 静态文件服务器（随机端口），托管 `web-dist/`（即 `yarn web:build:prod` 的产物）。
     用 http 而非 file:// 加载，web worker / wasm / 代码分割的行为与浏览器一致。
  2. SSH 桥接服务：优先监听 `ws://127.0.0.1:8765`，端口被占用时自动改用随机空闲端口，
     并通过 preload 把实际地址注入渲染进程（`globalThis.sshBridgeUrl`，由
     `ServerExportBridgeClient.defaultBridgeUrl()` 读取）。因此 8765 被任何程序占用
     都不影响 SSH 导出功能；桥接进程总是随应用启停，版本也始终与应用一致。
- `electron-builder` 把 `dist/` + `web-dist/` 打成 NSIS 安装包。

## 命令

```sh
yarn desktop:dist        # 完整流程：web 生产构建 + NSIS 安装包（输出 desktop/out/）
yarn desktop:dist:dir    # 同上，但只输出免安装目录（打包更快，用于验证）
yarn desktop:dist:portable  # 单文件免安装 exe（out/Foxglove Studio-<版本>-portable.exe，直接发给别人双击）
yarn desktop:start       # 用现有 web/.webpack 直接启动 Electron（一次性构建后启动）

# 开发调试（推荐）：渲染进程热更新 + 主进程/preload 改动自动重启 Electron
yarn web:serve           # 终端 1（先启动）
yarn desktop:dev         # 终端 2
```

`desktop:dev`（dev.mjs）启动时自动探测 `http://localhost:8080` 的 webpack-dev-server：
在则窗口加载它（渲染进程改动走 HMR，无需重启）；不在则回退到 `web-dist/`（最近一次
`web:build:prod` 的产物）并打印提示。同时 esbuild watch 监听 `src/main.ts` /
`src/preload.ts`，保存后约 100ms 重新打包并自动重启 Electron。
注意顺序：先 `yarn web:serve`，再 `yarn desktop:dev`（探测只在启动时做一次）。
要显式指定其他 dev server 地址，PowerShell 下用
`$env:FOXGLOVE_DEV_SERVER_URL="http://localhost:8080"; yarn desktop:dev`。

国内环境如 Electron 二进制下载缓慢：

```sh
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" yarn install
```

## 备注

- `desktop/package.json` 顶层的 `productName` 决定 Electron 运行时的 userData 与单实例
  锁：打包版（portable/安装版）使用 `%APPDATA%\Foxglove Studio`，portable 与安装版
  因此共用同一份配置、同时只能开一个（第二个会静默退出）；开发实例由 `main.ts`
  隔离到 `%APPDATA%\Foxglove Studio (dev)`，可与打包版同时运行。缺失顶层
  `productName` 时 Electron 会退回 `name`（"desktop"），曾导致打包 exe 在有 dev
  实例运行的机器上秒退（exit 0、无任何日志）。
- 未注入官方的 `desktopBridge` 全局对象，因此 UI 与 web 版完全一致（设置页仍会显示
  “下载桌面版”链接）。`isDesktopApp()` 为 true 时启用的 package:// 拉取、自动更新等
  功能依赖闭源桥接实现，故未启用。
- 自定义图标：把 `icon.ico`（含 256x256 帧）放到 `desktop/resources/` 下，electron-builder
  会自动使用（NSIS 安装/卸载程序图标对应 `installerIcon.ico` / `uninstallerIcon.ico`）。
  也可以直接从 PNG 生成多尺寸 ico：`yarn workspace desktop icon [source.png]`，默认源为
  `packages/studio-web/public/apple-touch-icon.png`（与 favicon 相同的 logo，但是方形
  180x180；`public/favicon.ico` 本身只有 74x51 且实为改了扩展名的 PNG，不能直接用）。
- 渲染进程沙箱开启（contextIsolation + sandbox，无 nodeIntegration），外部链接在
  系统浏览器中打开。

## 单文件 portable 版的运行时机制（修复"找不到 ffmpeg.dll"）

electron-builder 原版 portable 模板每次启动都把整个应用解压到 `%TEMP%\<构建期固定
ksuid>` 目录、退出即删。同一 exe 的多次启动因此共用并互删同一个目录：应用持有单实例
锁，第二次启动会立刻退出并把目录删掉——正在运行的第一个实例随后再拉起任何子进程
（GPU/renderer 重启、crashpad 等）就找不到 `ffmpeg.dll`；杀软与"存储感知"也偏爱清理
`%TEMP%` 里新写入的未签名 exe/dll（`ffmpeg.dll` 又是最常被恶意软件冒名的文件名）。
两者都表现为偶发报错"由于找不到 ffmpeg.dll，无法继续执行代码"。

修复方式：`patches/app-builder-lib.patch` 重写了 `templates/nsis/portable.nsi`
（经根 package.json 的 `resolutions` 接线，`yarn install` 时自动应用）：

- 运行时按版本解压到持久目录 `%LOCALAPPDATA%\Foxglove StudioPortable\app-<版本>`，
  退出不删除；下次启动校验 exe 与 `ffmpeg.dll` 存在后直接运行（冷启动 ~7s 解压，
  热启动 <1s——原版每次启动都要全量解压）。
- 校验失败（杀软隔离、上次解压中断）自动重新解压自愈；新运行时先解压到私有
  `stage-<tick>` 目录再 rename 发布，正在运行的实例的文件永不被触碰。
- 退出时顺手清理其他版本的旧运行时目录与残留 stage 目录（被占用文件留待下次）。

升级给新版本 exe 后首次运行会解压新的 `app-<新版本>` 目录并在退出时清掉旧版本目录，
无需手动清理。

## 自动更新（GitHub Releases）

应用启动时（及之后每 4 小时）会向 `Emperorywh/foxglove-opensource` 的 Releases 查询
`latest.yml`；发现新版本后后台下载，完成后弹窗提示重启更新。仅在安装版中生效
（`yarn desktop:start` 的开发实例不检查更新）。

发布新版本的流程：

```sh
# 1. 修改 desktop/package.json 里的 version（如 1.86.0 -> 1.87.0）

# 2. 构建并上传到 GitHub（需要 repo 权限的 Personal Access Token）
GH_TOKEN=<your-token> yarn desktop:release

# 3. 到 GitHub Releases 页面把 electron-builder 创建的草稿发布出去
#    发布后，旧版本客户端下次启动即会检测到更新
```

`--publish always` 会上传 `latest.yml`、安装包和 blockmap。未签名的应用可正常
自动更新，但 Windows SmartScreen 仍会对下载的安装包给出提示（与首次安装相同）。

## 已知问题：winCodeSign 解压失败

在未开启开发者模式且非管理员的 Windows 上，electron-builder 解压 winCodeSign-2.6.0.7z
时会因为其中的 macOS 符号链接报 `Cannot create symbolic link : 客户端没有所需的特权`
而失败（我们不签名，根本不需要这些文件）。任选一种解决：

1. 开启 Windows「开发者模式」（设置 → 系统 → 开发者选项），或用管理员终端构建；
2. 手动预置缓存（本项目首次构建时已这样做）：用 7-Zip 将
   `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<某随机名>.7z`
   解压到 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`
   （解压报符号链接警告可忽略），之后 electron-builder 会命中缓存跳过下载解压。
