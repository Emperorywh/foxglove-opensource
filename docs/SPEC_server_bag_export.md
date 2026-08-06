# SPEC: 服务器 BAG 导出(Server Bag Export)

> 状态:已确认(经 5 轮访谈);2026-08-06 规格评审修订
> 日期:2026-08-06
> 涉及仓库:foxglove-opensource(纯 Web 应用,浏览器环境)

> **修订记录(2026-08-06 规格评审)**
> - 决策 #19 修订:**桥接协议层单元测试**改为必需(原"不写测试要求"收窄至 UI 层)
> - 协议 v1 补充:`cancel` 配对规则、终止消息定序、ack 流控窗口、`sshClosed` 推送、`hello` 版本校验
> - 流程补充:Step A 恒为无连接态(返回即断开)、Step D 四组清单、"导出并打开"失败/重试路径、进度分母动态调整
> - 决策 #16 维持原议:公司内部工具,桥接**不做任何鉴权**(启动令牌方案曾纳入,同日回退删除)

## 1. 背景与目标

在 Foxglove Studio Web 版的"打开数据源"对话框中新增一种入口:**打开服务器**。用户输入服务器
IP、端口、系统用户名、系统密码、BAG 路径,选择本地导出目录,即可浏览服务器目录下的
BAG 文件,多选/全选后批量下载到本地;也可选择下载完成后直接在 Foxglove 中打开可视化。

典型场景:机器人(ROS1,Linux,运行 sshd)按时间滚动录制了一批 rosbag,工程师在笔记本上
用浏览器把需要的 bag 拉下来分析。

## 2. 访谈决策汇总

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 浏览器→服务器连接方式 | **本地 WS→SSH 桥接程序**(浏览器无法直接发起 SSH/TCP) |
| 2 | Web 应用部署环境 | 未定/多种都有 → 桥接绑定 `127.0.0.1` 是**安全措施**;部署兼容性由"HTTPS 页面可连 `ws://127.0.0.1`"(potentially trustworthy,不受混合内容拦截)保证(见 §12) |
| 3 | 数据规模 | 小包为主(单个 <500MB),局域网 |
| 4 | 下载后行为 | **两者都要**:主按钮仅下载,次要按钮"导出并打开" |
| 5 | 压缩策略 | **不压缩**,SFTP 直接拉取原始文件(服务器零负担) |
| 6 | 打包粒度 | **不要 ZIP**,逐文件写入导出目录(第 5、6 项经澄清后确定) |
| 7 | `.bag.active`(录制中)文件 | **显示但禁用勾选**,tooltip 提示"正在录制中,无法导出" |
| 8 | 目录内容 | 只显示 `*.bag` 与禁用的 `*.bag.active`,单层,不进入子目录 |
| 9 | 入口位置 | **Start 页新增第 4 个按钮**,进入独立对话框视图(不塞进"打开连接"页,因为该页所有数据源都必须创建 Player) |
| 10 | 本地目录选择 | **showDirectoryPicker**(File System Access API,Chrome/Edge);不支持的浏览器显示禁用说明 |
| 11 | 进度与取消 | 总进度条 + 当前文件名 + 取消按钮;不做断点续传 |
| 12 | 凭据存储 | IP/端口/用户名/路径存 localStorage;**密码只存内存**,每次重新输入 |
| 13 | 部分失败策略 | 跳过失败项继续,结束后汇总报告 + "重试失败项"按钮(重试范围含取消时未开始的排队项,见 §5 Step D) |
| 14 | 同名文件冲突 | **开始前询问**一次,对全部冲突生效(全部覆盖 / 跳过已存在 / 取消) |
| 15 | 桥接交付形态 | **仓库内 Node 包**(新 workspace 包,团队已有 Node 环境) |
| 16 | 桥接安全(本机恶意网页 CSRF 式风险) | 不做任何鉴权/防护,仅绑定 127.0.0.1(公司内部工具,2026-08-06 评审后维持原议);风险记录在案(§12) |
| 17 | SSH 主机密钥校验 | 不校验(相当于 `StrictHostKeyChecking=no`);风险记录在案(§12) |
| 18 | i18n | 英文 + 简体中文 |
| 19 | 测试要求 | **桥接协议层单元测试必需**(帧状态机、二进制重组、cancel/竞态、路径校验,用仓库现有 jest);UI 层不强制(2026-08-06 评审修订);代码仍须通过 `yarn lint` 与 `yarn build:packages` 类型检查 |

## 3. 总体架构

```
┌─────────────────────────┐   WebSocket    ┌──────────────────────┐   SSH/SFTP   ┌─────────────────┐
│ 浏览器 (Foxglove Web)    │  ws://127.0.0.1 │ 桥接程序 (本机 Node)  │  tcp/22      │ 机器人/服务器     │
│ ServerExport 对话框视图  │ ◄────────────► │ packages/ssh-bridge  │ ◄──────────► │ /data/bags/*.bag │
└─────────────────────────┘   JSON 控制帧    │ ssh2 + ws            │              │ sshd            │
                              + 二进制数据帧  └──────────────────────┘              └─────────────────┘
```

- 桥接程序运行在**用户笔记本**上,与浏览器同机,只监听 `127.0.0.1`(默认端口 8765)。
- 浏览器端所有控制消息为 JSON 文本帧;文件内容用 WebSocket **二进制帧**传输(避免 base64 的 33% 体积与 CPU 开销)。
- 桥接**不持久化**任何凭据:每次连接由网页在 `connect` 消息中携带用户名/密码;SSH 会话存续期间
  凭据仅存在于桥接内存,进程退出即无残留。
- 传输为**顺序单工**:同一时刻只有一个文件在下载,由客户端逐个驱动(决策 #11,小包场景足够跑满局域网)。

**为什么浏览器↔桥接用 WebSocket 而不是 HTTP**(2026-08-06 评审补充的权衡记录):纯 HTTP 方案
(`GET /list`、`GET /download` 流式响应 + `AbortController` 取消)能天然获得拉取式流控,曾是候选;
选择 WS 的原因:单连接承载单会话踢人策略(§4.2)、服务端可主动推送(`sshClosed`,§4.3)、
控制/取消/进度统一在一条通道,无需多端点状态同步。WS 缺失的应用层流控由 §4.3 的 ack 窗口补齐。

## 4. 组件划分

### 4.1 浏览器端(studio-base)

| 位置 | 改动 |
|------|------|
| `packages/studio-base/src/components/DataSourceDialog/DataSourceDialog.tsx` | `DataSourceDialogItems` 增加 `"serverExport"`;`view` switch 增加对应 case |
| `packages/studio-base/src/components/DataSourceDialog/Start.tsx` | `startItems` 增加第 4 个按钮"打开服务器 / 从服务器导出 BAG",`dialogActions.dataSource.open("serverExport")` |
| 新文件 `.../DataSourceDialog/ServerExport.tsx` | 向导式视图:连接信息 → 选择 BAG → 导出中 → 汇总 |
| 新文件 `.../DataSourceDialog/ServerExportBridgeClient.ts` | 桥接 WebSocket 客户端(连接管理、hello 版本校验、请求/响应配对、ack 流控窗口、二进制帧重组、sshClosed 处理、进度回调) |
| `packages/studio-base/src/i18n/en/openDialog.ts` + `i18n/zh/openDialog.ts` | 新增全部文案 key(决策 #18) |
| `packages/studio-base/src/components/PlayerManager.tsx` | 不改动;"导出并打开"复用现有 `selectSource(id, {type:"file", files:[...]})` 路径 |

**为什么不实现 `IDataSourceFactory`**:导出流程不创建 Player,与 `IDataSourceFactory.initialize()`
的契约不符。它只是对话框里的一个独立视图;"导出并打开"在最后一步才走既有的本地文件数据源流程。

### 4.2 桥接包

- 位置:`packages/ssh-bridge`(新 Yarn workspace 包)
- 依赖:`ssh2`(SSH/SFTP)、`ws`(WebSocket 服务端)
- 启动:`yarn bridge:serve`(根 `package.json` 增加 script,映射到
  `tsc --build packages/ssh-bridge/tsconfig.json && node packages/ssh-bridge/dist/index.js`,
  保证首次运行前已构建;开发期可 `yarn workspace @foxglove/ssh-bridge start` 直接跑 tsx)
- 参数:`--port <n>`(默认 8765);**只绑定 127.0.0.1**
- 鉴权:无(决策 #16,公司内部工具);任何能连到 127.0.0.1:8765 的客户端都可使用桥接。
- 行为:单会话策略——同一时刻只允许一个 WebSocket 客户端,新客户端接入时断开旧连接及其 SSH 会话;
  同一 WS 上重复 `connect` → 关闭现有 SSH 会话后按新参数重连(允许更换服务器);
  空闲 10 分钟自动断开 SSH 并推送 `sshClosed`;日志输出连接/传输事件(**绝不打印密码**)

### 4.3 桥接协议(v1)

客户端 → 桥接(JSON 文本帧):

```jsonc
{"type":"hello","version":1}
{"type":"connect","requestId":"1","host":"192.168.1.10","port":22,"username":"nvidia","password":"***"}
{"type":"list","requestId":"2","path":"/data/bags"}
{"type":"download","requestId":"4","path":"/data/bags/2026-08-06-04-54-43.bag"}
{"type":"ack","target":"4","bytes":8388608}
{"type":"cancel","target":"4"}
{"type":"disconnect"}
```

桥接 → 客户端:

```jsonc
{"type":"hello","version":1}
{"type":"connected","requestId":"1"}
{"type":"list","requestId":"2","entries":[
  {"name":"2026-08-06-04-54-43.bag","size":234881024,"mtimeMs":1754457283000,"kind":"bag"},
  {"name":"2026-08-06-11-15-32.bag.active","size":52428800,"mtimeMs":1754457312000,"kind":"active"}
]}
{"type":"fileStart","requestId":"4","name":"2026-08-06-04-54-43.bag","size":234881024}
// …随后是若干二进制帧(每帧 ≤1MB),合计 size 字节,受 ack 窗口约束…
{"type":"fileEnd","requestId":"4","bytes":234881024}
{"type":"canceled","requestId":"4"}
{"type":"error","requestId":"4","code":"IO_ERROR","message":"..."}
{"type":"sshClosed","reason":"idle","message":"..."}                    // 无 requestId 的服务端主动推送
```

协议约束:

- `requestId` 由客户端生成,响应原样带回,用于请求/响应配对。例外:`hello`/`disconnect`
  为连接级消息不参与配对;`cancel`/`ack` 不携带自身 `requestId` 只带 `target`,
  `cancel` 的"响应"即目标下载的终止消息。
- **终止消息恰好一次**:每个 `download` 保证恰好收到 `fileEnd` / `canceled` / `error` 之一;
  之后桥接忽略该 `requestId` 上的迟到消息(含 `cancel`/`ack`)。
- **取消竞态定序**:以桥接发出顺序为准。客户端发出 `cancel` 后若先收到 `fileEnd`,该文件按
  成功处理且**不得删除**;只有收到 `canceled` 才删除部分写入的本地文件。
- 二进制帧只允许出现在 `fileStart` 与终止消息之间,且归属当前 `requestId`。
- **流控(ack 窗口)**:桥接对每个下载维护"已发送字节 − 客户端最近 `ack` 字节 ≤
  `WINDOW_BYTES`(8MB)";超出窗口即暂停 SFTP 读取,收到 `ack`(累计已写盘字节)后继续。
  客户端在每次 `writable.write()` 完成后发送累计 `ack`;`fileStart` 后桥接可立即发送至多一个
  窗口的数据。浏览器内存中最多驻留约一个窗口的未落盘数据。
- `kind` 由桥接按文件名判定,**不区分大小写**:先判 `.bag.active` 结尾 → `"active"`,再判
  `.bag` 结尾 → `"bag"`(`.BAG`/`.BAG.ACTIVE` 同样命中),**其余文件不下发**(决策 #8)。
- `download` 校验:path 必须以最近一次 `list` 的目录为前缀,文件名部分不含路径分隔符、不区分
  大小写地以 `.bag` 结尾且不以 `.bag.active` 结尾(即 `kind == "bag"`);不满足 → `error`/
  `BAD_REQUEST`。桥接不信任客户端自由构造路径。
- `hello` 校验:客户端校验桥接 `hello` 的 `version === 1`,不符则断开并提示版本不兼容;
  5s 内未收到合法 `hello` 视为对端不是桥接(端口被其他程序占用)。
- `sshClosed`:SSH 会话断开(意外或空闲超时)时桥接主动推送,无 requestId;传输中断导致的
  断开,进行中的 `download` 同时以 `error`/`DISCONNECTED` 终止。

**错误码表**(§9 的 UI 映射):

| code | 含义 | 触发场景 |
|------|------|----------|
| `AUTH_FAILED` | SSH 认证失败 | 用户名/密码错误 |
| `HOST_UNREACHABLE` | 主机不可达/拒绝连接 | IP 错、服务器关机、端口错 |
| `TIMEOUT` | 连接或操作超时 | 网络不通(连接超时 10s) |
| `NO_SUCH_PATH` | 路径不存在 | BAG 路径输错、文件下载前被删 |
| `NOT_A_DIRECTORY` | 路径不是目录 | BAG 路径指向文件 |
| `PERMISSION_DENIED` | 权限不足 | 目录不可读/文件不可读 |
| `IO_ERROR` | 传输中 I/O 错误 | 服务器磁盘、SFTP 中断 |
| `DISCONNECTED` | SSH 会话意外断开 | 网络闪断 |
| `BAD_REQUEST` | 协议错误 | 非法消息/顺序、下载路径校验失败 |

## 5. 详细交互流程

### Step A:连接信息表单

字段(全部必填,沿用 `FormField` 校验机制):

| 字段 | 说明 | 校验 |
|------|------|------|
| 服务器 IP | 文本 | 非空 |
| 端口 | 文本,默认 `22` | 整数 1–65535 |
| 系统用户名 | 文本 | 非空 |
| 系统密码 | password 输入框 | 非空;**不持久化**,仅内存 |
| BAG 路径 | 文本,placeholder `/data/bags` | 非空,必须以 `/` 开头;提交前去掉结尾 `/` |

- IP/端口/用户名/BAG 路径在成功连接后写入 localStorage(键见 §11),下次打开自动填充。
- **Step A 恒为无连接态表单**:从 Step B 返回时先断开 SSH 与 WS(内存中的密码保留,
  再次点击 [连接并浏览] 可快速重连);不保留"已连接"的表单形态。
- 点击 **[连接并浏览]**:
  1. 先连桥接 `ws://127.0.0.1:8765` → `hello` 握手(5s 超时);
  2. WS 连接失败 → Alert:**"未检测到桥接程序,请先在本机运行 `yarn bridge:serve`"**(文案含命令。
     实现注记:该命令与交付形态(决策 #15)耦合,形态变化时需同步更新 i18n 文案);
  3. `hello` 非法/超时 → Alert"端口被其他程序占用或桥接异常";版本不符 →
     Alert"桥接版本不兼容,请升级桥接程序";
  4. `connect`(SSH,10s 超时)→ `list` → 成功则保存 localStorage 并进入 Step B;
  5. 任一失败 → 表单上方 Alert 展示错误码对应文案(§9),停留在 Step A。
- 若浏览器不支持 `showDirectoryPicker`:进入视图即显示 Alert"此功能需要 Chrome 或 Edge 浏览器",
  整个表单禁用(沿用现有 `disabledReason` 交互模式;放开"仅浏览"列为后续项,见 §16)。

### Step B:选择 BAG

- 顶部摘要条:`已连接 user@host · /data/bags` + [断开并返回] 链接(断开 SSH 与 WS 后回 Step A;
  内存中密码保留,可快速重连)。
- 文件列表(可滚动区域):
  - 每行:复选框 + 文件名 + 大小(人性化格式)+ 修改时间(本地时区格式化);
  - 表头复选框:**全选 / 全不选**(仅对可勾选的 `.bag` 生效,半选态显示 indeterminate);
  - `*.bag.active` 行:复选框禁用、文件名灰色,行尾图标 tooltip"正在录制中,无法导出";
  - 默认按修改时间**倒序**(最新录制在最上,最符合"拉最近的包"直觉);
  - [刷新] 按钮:重新 `list`(录制中的 bag 转固后会新出现)。
- 空目录 → 空态文案"该目录下没有 .bag 文件"。
- 收到 `sshClosed`(SSH 空闲超时/意外断开)→ 顶部 Alert"与服务器的连接已断开",列表与导出
  按钮禁用,提供 [重新连接]:用内存中的凭据静默重连桥接与 SSH,成功后自动刷新列表;失败则
  回 Step A 并展示错误。
- 导出目标区:[选择本地导出目录] 按钮(`showDirectoryPicker({mode:"readwrite"}`)),
  选定后显示目录名;未选择时导出按钮禁用。
- 底部按钮(返回入口由顶部摘要条的 [断开并返回] 承担,底部不再重复):
  - **[导出 N 个文件]**(N = 勾选数,N=0 或未选导出目录时禁用)
  - **[导出并打开]**:仅在**恰好勾选 1 个 `.bag`** 且已选导出目录时可用(原因见 §8.3);
    勾选多个时禁用 + tooltip"多文件暂不支持直接打开,请先导出后再手动打开"

### Step C:导出中

点击导出前先做**冲突预检**(§10)。之后:

- 总进度条:`已完成字节 / 待下载总字节`。分母动态调整:初始为勾选条目 list 时 size 之和;
  `fileEnd` 实际字节与 list 不符时按实际修正该文件份额;文件失败/跳过/取消时,其未下载字节
  从分母移除——保证进度条可达 100%;
- 当前文件名 + 当前文件进度条;
- **[取消]** 按钮:发送 `cancel` 并停止派发后续下载;按 §4.3 定序规则处理在途文件——收到
  `canceled` 则**删除**当前部分写入的本地文件,`fileEnd` 先到则该文件计成功、不得删除;
  已完成文件保留;跳 Step D:被取消的当前文件计入失败组(原因"已取消"),未开始的排队文件
  计入"未开始"组;
- 单文件失败:记录原因,**跳过继续下一个**(决策 #13)。例外:**连续 2 个文件因本地写入失败**
  (磁盘满、句柄失效等)则中止队列——后续文件大概率同样失败,剩余文件计"未开始"组;
- 桥接 WS 断开或收到 `sshClosed`:当前文件计为失败(原因"连接断开"),中止队列;
  Step D 的 [重试失败项] 会先静默重连桥接+SSH 再重试(密码仍在内存中)。

### Step D:汇总

- 四组清单:**成功**(数量+总字节)、**已跳过(重名)**、**失败**(文件名+原因;被取消时已有
  部分数据并删除的当前文件归入此组,原因"已取消")、**未开始**(取消/中止时队列中尚未启动的
  文件);
- [重试失败项]:对**失败组 + 未开始组**重跑(决策 #13 补充:取消/中止产生的未完成项与失败项
  一并重试);重试前再次冲突预检(部分写入的残留文件已被删除,通常无冲突;若有冲突按 §10
  再次询问);若断连引起,先静默重连桥接+SSH;
- 来自"导出并打开":任一时刻全部勾选项达到成功态(含重试后达成)→ 立即执行 §8.3 并关闭
  对话框(首次即全部成功则跳过本步);存在失败/未开始项则停留在本步,用户可重试(全部成功
  后仍自动打开)或点 [完成] 放弃打开;
- [完成]:断开桥接连接,关闭对话框。

## 6. UI 规格补充

- 视图复用 `DataSourceDialog/View.tsx` 的骨架(Back/Cancel 行为),但主操作按钮文案随步骤变化,
  允许 `View` 增加可选 props 或在本视图内自定义底部栏(以不改坏现有 Connection 视图为前提)。
- 遵循仓库强制约定:MPL 许可头;禁 `null` 用 `undefined`;`#private` 字段;`setTimeout`
  必须显式延迟;lodash 用 `lodash-es` 的 `_`;样式用 `tss-react` `makeStyles`,禁 `sx`/emotion;
  所有用户可见文案走 `useTranslation("openDialog")`。
- 图标:Start 页按钮用 `SvgIcon`(server/download 语义的内联 path,与现有三个按钮同风格)。

## 7. 文件列表规则

| 规则 | 说明 |
|------|------|
| 匹配 | 文件名以 `.bag` 结尾 → 可勾选;以 `.bag.active` 结尾 → 禁用展示;其余一律不显示(由桥接过滤,决策 #8;判定含大小写归一化,规则见 §4.3) |
| 层级 | 只列当前目录,不进入子目录 |
| 排序 | 修改时间倒序(客户端排序) |
| 大小写 | 后缀匹配不区分大小写(`.BAG` 也认) |
| 0 字节文件 | 正常列出与下载 |
| 文件名特殊字符 | 原样透传,不做重命名/转义。注意 File System Access API 限制:名称含 `\` 时 `getFileHandle` 抛 TypeError;Windows 保留名(CON、PRN、AUX、NUL、COM1–9、LPT1–9、尾随点/空格)写入失败——此类文件按"本地写入失败"进入失败组(低概率,ROS bag 命名规整) |

## 8. 本地写入与"导出并打开"

### 8.1 目录句柄

- `showDirectoryPicker({mode:"readwrite"})`;句柄**只保存在内存**(IndexedDB 持久化句柄列为后续项),
  每次会话需重新选择一次;句柄失效(`NotFoundError`/权限被撤)时提示重选。
- 每个文件: `dirHandle.getFileHandle(name, {create:true})` → `createWritable()` →
  边收二进制帧边 `write` → `close`,每次 `write` 完成后向桥接回累计 `ack`。**不在内存中整文件缓冲**:配合 §4.3 的 8MB ack 窗口,未落盘数据最多驻留约一个窗口(尽管 <500MB,也避免无谓内存峰值)。
- 文件失败/取消:尽力 `dirHandle.removeEntry(name)` 清理部分文件。

### 8.2 顺序下载

客户端按勾选顺序逐个 `download`,等终止消息(`fileEnd`/`error`)再发下一个(决策 #11:总进度+取消模型下最简;
并行下载列为后续项)。

### 8.3 导出并打开

- 仅允许勾选 1 个 `.bag`。原因已核实:`Ros1LocalBagDataSourceFactory` 未设 `supportsMultiFile`,
  且 `BagIterableSourceWorker` 只接受单个 `file`;`PlayerManager` 对多文件数组只会取第一个
  (`PlayerManager.tsx:168`)。ROS1 多 bag 合并播放是独立改造项,列入后续路线。
- 下载完成 → `dirHandle.getFileHandle(name)` → `getFile()` →
  `selectSource("ros1-local-bagfile", {type:"file", files:[file]})` → 关闭对话框,
  由 `PlayerManager` 走既有本地文件流程创建 `IterablePlayer`。

## 9. 错误处理

UI 文案映射(i18n key 略):

| 错误码 | 用户文案要点 |
|--------|-------------|
| `AUTH_FAILED` | 用户名或密码错误 |
| `HOST_UNREACHABLE` | 无法连接服务器,请检查 IP/端口与网络 |
| `TIMEOUT` | 连接超时 |
| `NO_SUCH_PATH` | 路径不存在(表单场景)/ 文件已不存在(下载场景) |
| `NOT_A_DIRECTORY` | BAG 路径不是目录 |
| `PERMISSION_DENIED` | 没有读取权限,请检查目录/文件权限 |
| `IO_ERROR` / `DISCONNECTED` | 传输中断 |
| 桥接不可达 | 未检测到桥接程序,请先运行 `yarn bridge:serve` |
| 桥接 `hello` 非法/超时 | 端口被其他程序占用或桥接异常 |
| 桥接版本不兼容 | 桥接版本不兼容,请升级桥接程序 |
| 本地写入失败(磁盘满等) | 写入本地文件失败,请检查磁盘空间与目录权限 |

所有失败项进入 Step D 汇总,附原始 `message` 作为次要信息。

## 10. 同名冲突(开始前询问)

- 时机:点击 [导出]/[导出并打开] 后、任何传输开始前。
- 方式:对所有勾选项并行 `dirHandle.getFileHandle(name)` 探测(不 create,捕获 `NotFoundError`)。
- 无冲突 → 直接开始。有冲突 → 对话框列出冲突数量(不必逐个列名),三选一:
  **[全部覆盖] [跳过已存在] [取消]**,选择对全部冲突生效(决策 #14)。
- "跳过已存在"的条目进入 Step D 的"已跳过"组,不参与"重试失败项"。

## 11. 凭据与持久化

| 数据 | 位置 | 说明 |
|------|------|------|
| host / port / username / bagPath | localStorage:`foxglove.serverExport.{host,port,username,bagPath}` | 成功连接后写入,下次预填 |
| password | 仅 React state(内存) | 每次打开视图重新输入;视图关闭即丢 |
| 目录句柄 | 仅内存 | 每次会话重选 |
| 桥接地址 | 常量 `ws://127.0.0.1:8765` | 桥接 `--port` 改端口时需同步改常量;可配置化列为后续项 |

## 12. 安全模型与已接受风险

防护与已接受风险(决策 #16、#17),规格记录在案:

1. **桥接无鉴权**(决策 #16,公司内部工具,2026-08-06 评审后维持):任何本机进程、以及用户
   浏览器中的任意网页都可以连接 `ws://127.0.0.1:8765` 并借桥接发起 SSH(需要目标服务器凭据
   才能认证成功,但可被用作扫描/爆破跳板);且因单会话踢人策略,任意网页连一下即可把合法
   会话踢掉(DoS)。缓解:仅绑定 127.0.0.1,不暴露局域网。
2. **不校验 SSH 主机密钥**:无法防范 ARP 欺骗/中间人(内网环境接受)。
3. **密码经本机 WebSocket 明文传输**:仅在本机 loopback,风险有限。
4. **HTTPS 部署兼容性**:`ws://127.0.0.1` 属于 potentially trustworthy origin,HTTPS 页面可连接;
   但需关注 Chrome Private Network Access(PNA)演进:若未来被拦截,桥接需在 HTTP 层
   应答 PNA 预检——收到带 `Access-Control-Request-Private-Network: true` 的 OPTIONS
   请求时响应 `Access-Control-Allow-Private-Network: true`(预检发生在 WS 握手**之前**,
   不是 WS 握手响应头),或改用 `wss://`(自签证书,体验差)。当前不做。PNA 一旦强制,
   恶意网页向量将由浏览器层拦截,§12.1 的风险自动降低。

未来加固路线(不在本期):桥接启动 token、Origin 白名单、TOFU host key 校验、wss。

## 13. 边界情况清单(实现时必须覆盖)

1. 桥接未启动(WS 连接失败)/ 端口被其他程序占用(hello 非法或 5s 超时)/ 版本不兼容 → §9 各自文案。
2. SSH 认证失败 / 主机不可达 / 超时(10s)→ 表单 Alert。
3. BAG 路径不存在 / 是文件 / 无读权限 → 表单 Alert。
4. 目录为空 → 空态。
5. 列表全是 `.bag.active` → 导出按钮禁用(N=0)。
6. 导出过程中用户点 [返回]:禁止(导出中隐藏返回入口,只允许取消)。
7. 桥接 WS 中途断开 → §5 Step C。
8. 服务器上文件在下载期间被删/改名 → 该文件 `NO_SUCH_PATH`/`IO_ERROR`,跳过继续。
9. 本地磁盘满 / 句柄失效 → 该文件失败,文案见 §9。
10. 取消 → 按 §4.3 定序规则处理在途文件(收到 `canceled` 才删除部分文件,`fileEnd` 先到计成功);
    已完成保留;当前文件计失败组(原因"已取消"),排队文件计"未开始"组。
11. `list` 的 size 与 `fileEnd` 实际字节不一致 → 以实际为准,进度条微调。
12. 冲突策略为"跳过已存在" → 汇总"已跳过"组。
13. 0 字节 bag → 正常处理。
14. 文件名含空格/中文 → 原样透传;含 `\` 或 Windows 保留名 → 该文件按本地写入失败处理(§7)。
15. 端口输入校验 1–65535;BAG 路径结尾 `/` 规范化;路径必须绝对路径。
16. 多标签页同时连接桥接 → 桥接单会话策略,后连接者踢掉前者(文档说明)。
17. `mtimeMs` 为 epoch 毫秒(与服务器时区无关),客户端按本地时区格式化显示。
18. 对话框直接关闭(X 或 Cancel)→ 断开 WS/SSH,内存中密码与句柄丢弃;导出中关闭
    视为取消(按 §4.3 定序规则处理在途文件)。
19. 取消与 `fileEnd` 竞态 → 以桥接发出顺序为准:`fileEnd` 先到计成功、不得删除,
    `canceled` 先到才删除部分文件(§4.3、§5 Step C)。
20. 连续 2 个文件本地写入失败 → 中止队列,剩余计"未开始"组(§5 Step C)。
21. 浏览期间收到 `sshClosed`(空闲超时/意外断开)→ Step B 提示并禁用操作,可静默重连(§5 Step B)。
22. 同一 WS 上重复 `connect` → 桥接关闭旧 SSH 会话后按新参数重连(§4.2)。

## 14. 与现有架构的集成点

| 集成点 | 说明 |
|--------|------|
| `DataSourceDialogItems`(`DataSourceDialog.tsx:25`) | 增加 `"serverExport"`;Workspace store 的 `dialogs.dataSource.item` 类型自动扩展 |
| `Start.tsx` `startItems` | 第 4 个 `DataSourceOption`,analytics 事件 `DIALOG_SELECT_VIEW` type `"server-export"` |
| `dialogActions.dataSource.open("serverExport")` | 复用现有视图切换机制 |
| `FormField` / `Field.validate` | 复用连接信息表单字段机制(或视图内自管 state,参照 `Connection.tsx`) |
| `selectSource("ros1-local-bagfile", {type:"file", files})` | "导出并打开"复用(§8.3) |
| i18n `openDialog` namespace | en + zh 双语 key(决策 #18);新增 key 不从 zh 遗留英文旧值;ja 不新增(遵循仓库惯例) |
| 根 `package.json` scripts | 增加 `bridge:serve`(先 `tsc --build` 桥接包再启动,保证首次可用) |
| Yarn workspaces | `packages/ssh-bridge` 加入 workspace(根 `package.json` 的 workspaces 若为 `packages/*` 通配则自动生效) |

## 15. 明确不做(Out of Scope,经访谈确认)

- ZIP / 任何形式的压缩(决策 #5、#6)
- 断点续传、并行下载(决策 #3、#11)
- 子目录遍历、搜索过滤、时间段筛选(决策 #8)
- 多 bag 合并播放、多文件"导出并打开"(§8.3,架构限制)
- 桥接 token/Origin 白名单、TLS、SSH host key 校验(决策 #16、#17)
- UI 层测试:不写 Storybook/集成测试要求;**桥接协议层单元测试为必需**(决策 #19 修订);
  代码仍须过 `yarn lint` 与 `yarn build:packages` 类型检查

## 16. 后续扩展路线

| 扩展 | 触发条件 |
|------|----------|
| ROS1 多 bag 连续播放(`BagIterableSource` 支持 files 数组 + factory 加 `supportsMultiFile`) | 需要一次分析整段录制时 |
| 目录句柄 IndexedDB 持久化 | 用户抱怨每次重选目录 |
| 并行下载 / 断点续传 | 出现大包或不稳定网络场景 |
| 子目录浏览、搜索、时间筛选 | 目录结构复杂化 |
| 桥接 token + Origin 白名单 + TOFU host key | 部署面扩大/安全审计要求 |
| 桥接地址可配置 | 端口冲突或远程桥接需求 |
| 不支持 File System Access 的浏览器放开"仅浏览" | 出现 Firefox/Safari 用户需求时 |
