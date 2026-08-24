# SPEC: 机器人数据导出包与导入播放(Robot Export Package & Playback)

> 状态:已确认(经 6 轮访谈,24 项决策 + 补充设计);2026-08-20 复核修订
> 日期:2026-08-20
> 前置文档:[SPEC_server_bag_export.md](SPEC_server_bag_export.md)(桥接消息流基石)、[SPEC_server_file_export_zip.md](SPEC_server_file_export_zip.md)、[SPEC_server_file_browser.md](SPEC_server_file_browser.md)、[SPEC_playback_alarm_lane.md](SPEC_playback_alarm_lane.md)
>
> **取代声明**:本文档**取代** SPEC_server_file_export_zip 与 SPEC_server_file_browser 的 **UI 层**(连接后浏览/勾选/过滤/单文件冲突三选一/「导出并打开」),服务器导出功能重构为"任务式表单 → 预览 → 导出 → 汇总"的单一路径。**桥接消息流**(connect/list/download/ack/cancel/fileStart/fileEnd/sshClosed/取消定序/ack 窗口流控)**沿用不变**,仅新增 `serverTime` 消息(§4),协议 bump v4。SPEC_playback_alarm_lane 的**在线查询路径不受影响**,本文档为其新增"导出包"数据路径(§12),并修订其 §10 联动注记(告警端口纳入联动,§3)。
>
> **复核修订(2026-08-20)**:时区回退取负 `tzOffsetMinutes = -getTimezoneOffset()`(§5/决策 #27,原表述符号相反会致告警窗口偏 2×tz);worker 接线改为新建独立 `MergedBagIterableSourceWorker.worker.ts`,`WorkerIterableSourceWorker.ts` 零改动(§11.4/§21);泳道取数通道补 `selectedParams` 并解除 `type === "file"` 限制,桌面闭环 remote 形态可达(§11.5/§12.1);logs 写完后主动断开桥接,规避 `IDLE_TIMEOUT_MS` 与告警查询超时的竞态(§9.3/§14);未连接守卫错误码改 `DISCONNECTED`(§4.1);manifest 示例时间戳订正(§7.3);决策 #32 连接 ID 机制按 MessageEvent 无 connectionId 的现状改写(§11.3);MergedBag 测试改注入式 stub + 真 bag 冒烟(§16);zip writer 接口表述、数据描述符签名、`Filelike.read` 方法名等表述订正(§8/§11.2)。
>
> **评审修订(2026-08-20,第 2 轮)**:`serverTime` 整体失败时 end 钳制/时钟偏差检查按"浏览器时钟假定"口径补全,偏差检查跳过(§5/§9.2);0-bag 导出包不出「立即导入播放」,汇总页明示仅归档(§9.4/边界 32);`fetchRobotStatus` 订正为双输出签名 `{ rawText, records }` 并补入改动清单与测试(§10/§16/§21);§12.1 资格判定措辞订正(只看 `selectedSource.id`,type 不参与);manifest `stopUnixMs` 键名加注对齐接口请求体(§7.3);导入侧 bags/ 未识别文件名与日志递归深度上限的触发行为补定义(§4.3/§11.3/边界 33);zip64 extra 字段按本地头/中央目录分别摆放的细则(§8.1);桌面闭环 url 不写"最近数据源"(§11.5);displayName 硬编码表述与 i18n 引用订正(§20/§21);两份被取代旧规格头部加取代注记。

## 1. 背景与目标

现有"服务器文件导出"是通用文件浏览器:用户连 SSH、逐目录浏览、手动勾选文件、打 zip。实际使用场景高度固化——**导出某时间段内的机器人数据用于事后回放分析**。本次重构为任务式流程:

用户在**一个表单**中输入:IP、SSH 端口、告警端口、系统用户名、系统密码、bag 路径(默认 `/home/rxx/bkbagfiles`)、日志路径(默认 `/var/log/robot`)、开始时间、结束时间、本地导出目录;连接预览确认后开始导出,产出**一个 zip 导出包**:

- **bags/**:起止时间内的全部 bag 分片(命名规则 `2026-08-20-09-27-32_1.bag`,时间=录制开始时刻,后缀=轮转序号),外加区间起点之前最近的一个相邻分片(决策 #2);
- **logs/**:日志目录**递归全量**(决策 #3),保留相对路径;
- **alarms.json**:告警接口(`POST /rbrainrobot/data/get_robot_status_list`)按起止时间查询的**原始响应**;
- **manifest.json**:导出包身份与元数据(最后写入)。

导出包可**直接导入播放**(决策 #6):多个 bag 分片在**播放层按时间归并**为一个连续数据源(决策 #5,不改写任何 bag 字节),告警泳道改读包内 `alarms.json`(决策 #7,离线可用)。

**核心难点及其解法**:多 bag 续接播放不依赖"下载时合并为单 bag"——现有 `@foxglove/rosbag` 0.4.0 只读、无 JS 写入器,自研写入器风险最高;经访谈决策改为播放层归并(§11.3),原始分片原样保留,零格式风险。

## 2. 访谈决策汇总

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | bag 文件名语义 | 时间戳=**该分片开始录制时刻**(机器人本地时间),后缀=**轮转序号**(达到大小/时长上限切新文件);分片内容时间 ≈ [本文件名时间, 下一分片文件名时间) |
| 2 | 时间筛选口径 | **文件名时间在区间内 + 前一个相邻分片**:按文件名时间排序,导出全部文件名时间 ∈ [start,end] 的 bag,再带上 start 之前最近的一个,保证不丢区间开头;代价是导出内容略多于请求范围 |
| 3 | 日志范围 | 日志路径下**含子目录递归全部导出**(mtime 不过滤);桥接 v3 已下发 `dir` 条目,递归由客户端遍历实现(§4.3) |
| 4 | 文件名时区 | **机器人本地时区**:文件名由机器人系统时钟生成,用户输入按机器人时区解释,界面标注"机器人时区" |
| 5 | 多 bag 续接播放 | **播放层多 bag 归并**:zip 保留原始分片;新增 MergedBagIterableSource 把多个 bag 当一个连续 IIterableSource;框架已有 `supportsMultiFile`/`files[]` 先例(ROS2 db3)。推翻"下载时合并为单 bag"(无 JS bag 写入器)与"机器人 SSH 远程合并"(桥接无 exec、占机器人资源) |
| 6 | 导入形态 | **导入 zip 直接播放**:新数据源入口选 zip → 解出 bags+alarms.json → 连续播放并联动告警泳道;同时保留拖拽打开 |
| 7 | 泳道数据源(导入播放时) | **用 zip 内 alarms.json**,不再请求在线接口;离线/跨机器回放也能看到告警区间 |
| 8 | 播放时间范围与重叠 | **播放完整分片内容**:时间轴=所有分片实际消息范围(可略超出导出区间);相邻分片若有时间重叠,**消息不去重**,忠实原始数据 |
| 9 | 与浏览式导出的关系 | **取代**:导出对话框重构为单一任务表单,浏览/勾选/过滤 UI 与「导出并打开」链路移除(§3) |
| 10 | 字段持久化 | **全部字段持久化**(AppConfiguration,新 key 见 §9.1),下次预填;**密码一并记住**(应用户要求,`robotExport.password`,输入框支持明文/密文切换);例外:「包含日志」不持久化,每次默认勾选(决策 #17);旧浏览式 UI 的 localStorage key(`foxglove.serverExport.port/username/showHidden`)弃用——不再读写,不强制清理 |
| 11 | 导出前预检 | **先预览清单再确认导出**:连接后自动执行 serverTime+列目录+告警接口试连,展示匹配 bag N 个/日志 M 个/总大小/告警可达性/机器人时钟,确认后开始下载 |
| 12 | 告警失败容错(导出中) | **仅警告,继续导出**:bags+日志照常打包,zip 内无 alarms.json,manifest 记 `alarms.status="failed"`,汇总页标警告;不触发整包作废 |
| 13 | >4GB 限制 | **升级 ZIP64,解除 4GB 限制**(重写 zip writer,§8);原规格的"前置禁用 + 写入时硬护栏"随之移除 |
| 14 | 时区偏移来源 | **桥接返回机器人时间**:协议新增 `serverTime`(桥接执行**固定** `date '+%s %z'` 命令,非任意 exec),得 Unix 时间与 tz 偏移;失败回退浏览器时区并在 manifest 记 `tzSource`(§5) |
| 15 | 主要运行形态 | **桌面 Electron 为主**;Web 开发环境(web:serve,经 dev server 代理)可用;生产 Web 部署沿用告警泳道规格 §12 的已知限制,不做兜底 |
| 16 | 时间范围 0 bag | **警告但允许仅导出日志+告警**:预览页明确警告,用户可选「仍导出」或「返回修改」 |
| 17 | 日志角色与开关 | **仅归档携带**(应用内不做日志查看器);表单提供「包含日志」勾选,**默认勾选**且不持久化(每次打开恢复勾选),体积太大时可取消 |
| 18 | zip 结构与身份 | **manifest.json + bags/ + logs/ + alarms.json** 四类内容;导入靠 manifest 识别导出包并做版本演进 |
| 19 | 时间输入 UI | **datetime-local 精确到秒**(step=1),另加快捷范围(最近 1 小时/最近 24 小时/今天)快速填充;标注"机器人时区" |
| 20 | 下载失败/取消语义 | **沿用整包作废 + 整包重跑**:删除部分 zip,已完成项计失败组;断点续传/增量补包继续不做 |
| 21 | 导入读取方式 | **zip 内随机访问**:Store 条目即原始字节,解析中央目录后每个 bag 条目包装为区间视图按需读取,零额外磁盘占用;新增 `zipArchiveReader` 纯逻辑模块(可单测)(§11.1) |
| 22 | 导入校验强度 | **manifest 严格,内容宽容**:manifest.json 必须存在且 format/formatVersion 受支持,否则拒绝导入;bags/ 为空拒绝(无可播放数据);alarms.json/logs 缺失容忍(泳道不显示并给出提示) |
| 23 | 录制中分片与未来 end | **跳过 active + end 钳制**:`.bag.active` 自动跳过,预览标注"N 个录制中分片已跳过";end 晚于机器人当前时间时按机器人当前时间钳制(筛选与告警查询),预览披露 |
| 24 | 导入入口与闭环 | **新入口 + 导出后立即播放**:数据源对话框新增「机器人导出包」入口;导出汇总页提供「立即导入播放」直接加载刚生成的 zip(替代被移除的「导出并打开」) |

补充设计(实现细节,未单列访谈):

| # | 决策点 | 结论 |
|---|--------|------|
| 25 | 桌面端闭环读取 | 桌面汇总页「立即导入播放」**不**走 `readFile`(整文件过 IPC 入内存,GB 级不可行);桌面主进程静态服务器新增**带随机 token 的 Range 路由**暴露本次导出目录,导入走 `CachedFilelike` 远程路径(§13);Web 用 `FileSystemFileHandle.getFile()`(懒加载,安全) |
| 26 | 导入入口补充 | 数据源工厂声明 `supportedFileTypes: [".zip"]`,**拖拽 zip 到窗口**同样触发导入(复用 Workspace openFiles 既有匹配) |
| 27 | 时区回退 | `serverTime` 失败(exec 被拒/受限 shell/解析失败)→ 按**浏览器时区**换算(`tzOffsetMinutes = -new Date().getTimezoneOffset()`,符号见 §5)并在 manifest 记 `tzSource: "browser-assumed"`,预览页提示 |
| 28 | 告警查询并发 | 导出开始时**立即并发发起**告警查询(复用 fetchRobotStatus,10 分钟超时),与 SFTP 下载并行;写完 logs 后等待查询结果再写 alarms.json 与 manifest,**通常**不增加整体墙钟时间(小导出时墙钟由告警查询决定,至迟 10 分钟超时) |
| 29 | manifest 写入时机 | **最后写入**:需记录告警终态与最终文件清单;取消/失败时 manifest 随整包一起删除 |
| 30 | 快捷范围时钟 | 快捷范围按钮按**浏览器当前时间**填充输入框(连接前可用);连接后预览页显示机器人当前时间与换算后 Unix 区间,时钟偏差 >5 分钟时警告 |
| 31 | 泳道取数通道 | `PlayerSelection` 新增 `selectedFiles?: File[]`(文件型数据源)与 `selectedParams?: Record<string, string \| undefined>`(连接型数据源,携带 url),PlayerManager 在成功构建 player 时按形态写入、切换/关闭时清空,供告警泳道从导入包 File(或桌面闭环 URL)中提取 alarms.json;这是播放层与 UI 层之间的最小侵入通道(§12.1) |
| 32 | 分片连接 ID | 分片各自持有 Bag/MessageReader 独立解码,datatypes/reader 天然隔离、无需全局表;`MessageEvent` 本无 connectionId 字段,需全局化的仅 **problem 型结果的 connectionId**(用于问题归因),按 bagIndex 段映射为全局唯一(§11.3) |

## 3. 对既有规格的修订对照

| 既有位置 | 原结论 | 新结论 |
|----------|--------|--------|
| SPEC_server_file_export_zip §1/§6(ServerExport UI) | 连接 → 浏览(单层列表/过滤/勾选) → 导出 → 汇总;≥2 文件自动打 zip | **推翻 UI 层**:单一任务表单(§9);不再有逐文件勾选、过滤框、bag 徽标、表头全选、跨目录选择 |
| SPEC_server_file_browser 全文(UI) | 面包屑/前进后退/子目录导航 | **移除**(浏览 UI 下线);其 v3 协议产物(`dir` 条目、realpath 规范化、symlink statFollow)保留并服务于日志递归(§4.3) |
| SPEC_server_file_export_zip 决策 Z15/§5.6 | 不支持 ZIP64,≥4GiB−64MiB 前置禁用 + 写入时硬护栏 | **推翻**:重写 zip writer 支持 ZIP64(决策 #13,§8);`MAX_ZIP_BYTES` 前置禁用与硬护栏移除 |
| SPEC_server_file_export_zip 决策 Z10/§5.4(zip 命名) | `export-YYYYMMDD-HHmmss.zip` | **修订**:`robot-export-<host>-<startLocal>-<endLocal>.zip`(host 为服务器 IP;机器人时区起止),重名自动 ` (1)` 沿用(§7.1) |
| SPEC_server_file_export_zip §6.1/原规格 §8.3(导出并打开) | 恰好勾选 1 个 .bag → 裸导出后 `selectSource("ros1-local-bagfile")` | **移除**;由汇总页「立即导入播放」导出包闭环替代(决策 #24,§9.4) |
| SPEC_server_file_export_zip 决策 Z17(不兼容立场)+ SPEC_server_file_browser §4(现行版本号出处) | PROTOCOL_VERSION = 3(现行代码) | **修订**:bump 到 **4**,新增 `serverTime` 消息;不做兼容,双向不匹配报"版本不兼容"(§4.1) |
| SPEC_server_bag_export §15 / SPEC_server_file_export_zip §10(明确不做:多 bag 合并播放) | 不做 | **移除该条**:本规格实现播放层归并(§11.3);其余"不做"项继续不做(§17) |
| SPEC_playback_alarm_lane §10(联动注记) | host 联动,**端口不联动** | **修订**:导出表单的告警端口与 `robotAlarm.port` **双向联动**(同一服务);host 联动沿用(§9.1) |
| SPEC_playback_alarm_lane 决策 #7(生效范围) | 仅 `ros1-local-bagfile` | **扩展**:新增 `robot-export-package` 数据源,数据路径为包内 alarms.json(决策 #7/#31,§12) |

桥接 download/list/ack/cancel 消息流、`kindForName`、`validateDownloadPath`(`.bag.active` 拒下、须已 list 目录内)、错误码表、sshClosed/取消定序——**全部沿用**,零改动。

## 4. 桥接协议变更(v4)

### 4.1 版本与新增消息

`packages/ssh-bridge/src/protocol.ts`:`PROTOCOL_VERSION = 4`;hello 严格相等校验沿用,双向不匹配报"版本不兼容"(沿用决策 Z17 立场)。新增一对消息:

```ts
// ClientMessage 新增
| { type: "serverTime"; requestId: string }
// ServerMessage 新增
| { type: "serverTime"; requestId: string; unixMs: number; tzOffsetMinutes: number }
```

- 仅在 `connected` 之后可用;桥接对未连接会话的 `serverTime` 回 `DISCONNECTED`("not connected",沿用 list/download 的既有守卫模式)。
- 失败(执行被拒/超时/输出不可解析)→ 既有 `{ type: "error", requestId, code, message }`(`IO_ERROR` 或 `TIMEOUT`,**不新增错误码**);客户端按决策 #27 回退。

### 4.2 桥接实现(`SshSession.getServerTime`)

- `SshSession` 接口新增 `getServerTime(): Promise<{ unixMs: number; tzOffsetMinutes: number }>`;
- ssh2Connector 实现:`client.exec("date '+%s %z'")` ——**命令串为常量,协议不暴露任何任意命令执行面**(安全边界与"不做任意 exec"立场一致,§17);收集 stdout,按 `/^(\d+)\s+([+-])(\d{2})(\d{2})/` 解析,偏移折分钟;5 秒超时;
- 校验 `unixMs` 合理(有限数且 > 2001-01-01);不合理即失败;
- mock connector(测试用)返回固定值。

### 4.3 日志递归遍历(客户端,无协议改动)

v3 的 `list` 已满足递归所需:`dir` 条目(含 statFollow 后的 symlink→dir)、响应携带 **realpath 规范化后的 canonical path**、socket/fifo/设备不下发、symlink→file 带目标 size/mtime。因此:

- 客户端从 `logPath` 起深度优先遍历:对每个 `dir` 条目递归 `list`;
- **去环**:以响应的 canonical path 建 visited 集合,已访问目录跳过;另加**深度上限 16** 防御——触及上限的子树跳过并计数,预览附注/汇总页警告组披露("N 个深层目录因深度上限未包含"),不静默截断;
- 所有非 `dir` 非 `active` 条目计入日志清单;`kind === "active"` 条目(日志目录里理论上不该有 `.bag.active`)跳过并计数;
- 任一层 `list` 失败(权限/目录被删)→ 预览失败,按 §14 处理。

### 4.4 不变项

connect/list/download/ack/cancel/fileStart/fileEnd/二进制帧/sshClosed/错误码表/取消竞态定序/ack 窗口(`WINDOW_BYTES`)——消息流全部沿用 SPEC_server_bag_export §4.3;其中 `list` 的**载荷**(`dir` 条目、canonical path、statFollow 语义)为 v3 扩展,按 SPEC_server_file_browser §4 的现行定义。

## 5. 时间语义与时区处理

- **bag 文件名时间** = 机器人本地墙钟(naive,无时区,决策 #1/#4);**用户输入**按机器人本地时间解释(界面标注"机器人时区",决策 #19);二者的比较**全程在 naive 本地时间域内进行**——先归一为同一串格式再比较(文件名 `YYYY-MM-DD-HH-mm-ss` 与 `datetime-local` 输出 `YYYY-MM-DDTHH:mm:ss` 分隔符不同,统一为 `YYYYMMDD-HHmmss` 或 ISO 秒级串后字符串即可比较,无需任何偏移)。
- **告警接口**需要 Unix ms:`startUnixMs = naiveStart − tzOffset`、`endUnixMs = naiveEnd − tzOffset`;`tzOffsetMinutes` 语义为**本地时间超前 UTC 的分钟数**,取自 `serverTime`(`date '+%z'` 折分钟,UTC+8 → **+480**,决策 #14);**失败回退浏览器时区时须取负**:`tzOffsetMinutes = -new Date().getTimezoneOffset()`——该 API 符号相反(UTC+8 返回 **−480**),不取负将使告警窗口偏 2×tz——并在 manifest 记 `tzSource: "browser-assumed"`(决策 #27)。
- **end 钳制**(决策 #23):`endNaive > robotNowNaive` 时,筛选与告警查询按机器人当前时间钳制(`robotNowNaive = (unixMs + tzOffset)` 折本地),预览披露"结束时间已钳制到机器人当前时间 HH:mm:ss"。**`serverTime` 整体失败(决策 #27 回退)时 `unixMs` 不可得——`robotNowNaive` 以浏览器本地当前时刻假定**(接受机器人时钟不同步时的钳制误差:后果仅限边缘分片取舍与告警窗口端点,预览已披露"本地假定")。
- **时钟偏差**:`|robotUnixMs − Date.now()| > 5 min` 时预览警告"机器人时钟与本地相差 X"(决策 #30);不阻断——bag 消息时间与告警采样同为机器人时钟,内部自洽。**回退模式下无 `robotUnixMs`,偏差检查跳过**,预览时间标注"(本地假定,机器人时钟未知)"。
- 文件名解析:`/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})_(\d+)\.bag$/i`,逐字段范围校验(月 1–12 等),非法即"未识别"。

## 6. bag 筛选算法(纯函数,可单测)

输入:bag 目录 `list` 条目、naive 区间 `[startNaive, endNaive]`(已钳制)。输出:`{ selected: BagCandidate[], skippedActive: number, skippedUnrecognized: number }`,`BagCandidate = { name, size, naiveTime, seq, role: "in-range" | "predecessor" }`。

1. `kind === "active"` 或 `.bag.active` 名 → 跳过计数;
2. 不能按 §5 正则解析的 `.bag` → 跳过计数(预览次要信息"N 个文件名未识别,已忽略");
3. 其余按 `(naiveTime, seq)` 升序;
4. `role = "in-range"`:`startNaive <= naiveTime <= endNaive`(闭区间);
5. **前一个相邻分片**(决策 #2):**非 active 且解析成功**的 bag(即步骤 3 排序后的集合)中 `naiveTime < startNaive` 的最大者(按同排序),若存在且不在 in-range 中,以 `role = "predecessor"` 追加到队首;不存在则无前片;
6. 下载顺序 = 排序后顺序(predecessor 在最前)。

注意:predecessor 的选取**只看 bag 目录**,不读消息内容;in-range 为 0 时仍可选出 predecessor——此时按决策 #16 口径,预览的"0 bag"判断**计入** predecessor(即 predecessor 存在 ⇒ 非 0 bag)。

## 7. zip 包结构

### 7.1 命名

`robot-export-<host>-<startLocal:YYYYMMDD-HHmmss>-<endLocal:YYYYMMDD-HHmmss>.zip`(host 为表单服务器 IP,区分来源机器人;时间取用户输入的机器人时区 naive 时间,钳制后的 end);重名探测自动 ` (1)`(沿用原逻辑,`resolveZipNameConflict` 保留);同一会话重试沿用同一 zip 名(沿用决策 Z14)。

### 7.2 内部布局(决策 #18)

```
robot-export-192.168.1.100-20260820-090000-20260820-100000.zip
├── bags/2026-08-20-08-57-32_0.bag      ← predecessor(若选出)
├── bags/2026-08-20-09-07-32_1.bag
├── bags/…
├── logs/robot.log
├── logs/archive/robot.log.1.gz          ← 保留 logPath 下的相对路径
├── alarms.json                          ← 告警接口原始响应体;失败时缺失(决策 #12)
└── manifest.json                        ← 最后写入(决策 #29)
```

- 条目写入顺序:bags(按 §6 顺序)→ logs(遍历顺序)→ alarms.json → manifest.json;
- zip 内路径一律 `/` 分隔;日志条目名 = `logs/` + 相对路径(遍历时装配,禁 `..`);
- bag/日志条目名原样保留服务器文件名(沿用决策 Z16 的不净化立场);
- 条目 mtime 取 `list` 的 `mtimeMs`,DOS 范围钳制沿用(1980-01-01 ~ 2099-12-31)。

### 7.3 manifest.json(formatVersion 1)

```jsonc
{
  "format": "robot-export-package",
  "formatVersion": 1,
  "createdAtUnixMs": 1787191264652,
  "generator": { "app": "foxglove-studio", "version": "1.86.0-dev" },
  "source": { "host": "10.11.2.208", "bagPath": "/home/rxx/bkbagfiles", "logPath": "/var/log/robot" },
  "range": {
    "startLocal": "2026-08-20 09:00:00",   // 机器人时区 naive,空格分隔单行格式
    "endLocal": "2026-08-20 10:00:00",     // 已按 §5 钳制
    "tzOffsetMinutes": 480,
    "tzSource": "server",                  // "server" | "browser-assumed"
    "startUnixMs": 1787187600000,
    "endUnixMs": 1787191200000
  },
  "bags": [
    { "name": "2026-08-20-08-57-32_0.bag", "size": 524288000, "timeLocal": "2026-08-20 08:57:32", "seq": 0, "role": "predecessor" },
    { "name": "2026-08-20-09-07-32_1.bag", "size": 524288000, "timeLocal": "2026-08-20 09:07:32", "seq": 1, "role": "in-range" }
  ],
  "logs": { "included": true, "count": 42, "bytes": 314572800 },
  "alarms": {
    "status": "ok",                        // "ok" | "empty" | "failed"
    "query": { "startUnixMs": 1787187600000, "stopUnixMs": 1787191200000 },  // 键名对齐接口请求体 start_time/stop_time;数值 = 钳制后的 range.endUnixMs
    "error": "connect timeout"             // 仅 failed 时存在,其余状态省略该字段
  }
}
```

## 8. ZIP64 流式写出(重写 `serverExportZip.ts`)

决策 #13:解除 4GB 限制。Store 模式(不压缩,沿用决策 Z2)不变;fflate 流式写路径已核实无 ZIP64(原规格 §5.6),因此**自写 zip 容器层**——Store 下 zip 只是"本地头 + 原始字节 + 中央目录"的薄格式,自写成本可控且可精确单测。

### 8.1 编码规则

- **条目头**:固定 30 字节本地头;`bit 3`(data descriptor)置位,本地头 size 字段写 0/哨兵;**数据后写数据描述符**——带签名 `0x08074b50`,经典条目 16 字节(签名 4 + CRC 4 + 双 size 各 4)、zip64 条目 24 字节(双 size 各 8 字节),与 fflate 现状产物格式一致——原因是 SFTP 对增长/缩水文件的实际字节数只有在 `fileEnd` 才确定,预先写死 size 会在失配时产出损坏包;描述符路径容忍体积变化;
- **ZIP64 判定按值惰性升级**:任何 32 位字段(条目 compressed/uncompressed size、本地头偏移、条目计数、中央目录大小/偏移)装不下时,该字段写 `0xFFFFFFFF`/`0xFFFF` 哨兵,真实值写入 **zip64 extra field(0x0001)**——extra 按头部分别摆放:条目任一 size 越界 → **本地头** extra 写双 size(8+8 字节,Store 下两值相等),该条目即为 zip64 条目;**中央目录** extra 按需写(条目 size 越界或该条目本地头偏移越界,含哪些字段写哪些;两头均不越界的条目不写 extra);数据描述符在 zip64 条目后用 8 字节 size 字段;
- **收尾**:任一值越界即写 **ZIP64 EOCD record + ZIP64 EOCD locator**,再写经典 EOCD(装不下的字段写哨兵);全部装得下时只写经典 EOCD——小导出包保持最朴素的经典格式,旧工具全兼容;
- 非 ASCII 名置 UTF-8 标志位(bit 11);压缩方法恒 0(Store);版本需求字段:zip64 条目 45,其余 20;
- 进度与 ack **仍按条目文件字节计**(容器开销不入进度,沿用原规格 §5.3 语义);`fileStart` 真实 size 与 list 不符时立即修正份额、`fileEnd` 兜底修正——沿用。

### 8.2 模块接口(纯逻辑,不依赖 React)

在既有 `createZipWriter` 形态上重写,**接口除 `endEntry` 外不变**:`beginEntry(name, mtimeMs)` / `pushEntryChunk(chunk)` / `endEntry(actualSize)` / `finalize()` / `abort()`;容器字节经**串行 promise 链**按序写入 `ServerExportWritable`(沿用);`abort()` 语义沿用原 §5.2(no-op 化、不写中央目录、`writable.abort()`、尽力 `removeEntry`)。

- `endEntry` 增加 `actualSize` 形参(来自 `fileEnd.bytes`),写入数据描述符;
- 单测用**注入式阈值**(`__testMaxFieldValue`)把 32 位边界压到 KB 级,无需 4GB 夹具即可覆盖 zip64 分支。

### 8.3 移除项

`MAX_ZIP_BYTES` 常量、导出按钮的 4GB 前置禁用、写入时硬护栏——全部移除(决策 #13)。磁盘空间不足仍表现为本地写失败 → 整包作废(§14)。

## 9. 导出流程与 UI(`ServerExport.tsx` 重写)

### 9.1 Step A:任务表单

| 字段 | 默认/持久化 | 校验 |
|------|-------------|------|
| IP | `robotAlarm.host`(沿用双向联动) | 非空 |
| SSH 端口 | 新 key `robotExport.sshPort`,默认 `22` | 1–65535 整数 |
| 告警端口 | `robotAlarm.port`(**改为双向联动**,§3) | 1–65535 整数 |
| 用户名 | 新 key `robotExport.username` | 非空 |
| 密码 | 新 key `robotExport.password`(连接成功写回,默认记住);输入框支持**明文/密文切换** | 非空 |
| bag 路径 | 新 key `robotExport.bagPath`,默认 `/home/rxx/bkbagfiles` | 以 `/` 开头 |
| 日志路径 | 新 key `robotExport.logPath`,默认 `/var/log/robot` | 以 `/` 开头 |
| 开始/结束时间 | 不持久化;datetime-local,**step=1(精确到秒)**,标注"机器人时区";**秒段可省略**——下拉面板选择/粘贴值常为分钟精度,归一化按 `:00` 解析;快捷按钮[最近 1 小时][最近 24 小时][今天](按浏览器时钟填充,决策 #30) | start < end |
| 本地导出目录 | 不持久化;[选择目录] 按钮 + 已选显示(`pickExportTarget` 沿用:桌面原生对话框显全路径,Web `showDirectoryPicker` 显目录名) | 必选 |
| ☐ 包含日志 | **不持久化**,每次打开默认勾选(决策 #17) | — |

连接/导出参数(host/SSH 端口/告警端口/用户名/密码/两路径)在**连接成功**时写回持久化(决策 #10)。

### 9.2 Step B:预览(决策 #11)

[连接并预览] → 串行:桥接 connect → `serverTime`(失败按决策 #27 继续)→ `list` bag 路径 → §6 筛选 →(勾选日志时)§4.3 递归列举日志 → 告警试连(`fetchRobotStatus`,`[endUnixMs−60s, endUnixMs]` 小窗口,结果丢弃,**非致命**)。

预览页展示:匹配 bag N 个(含"含区间前相邻分片 1 个"/"录制中分片 K 个已跳过"/"未识别文件名 J 个已忽略"附注)、日志 M 个文件、**总大小**、机器人当前时间与时钟偏差警告(决策 #30;`serverTime` 失败的回退模式下显示本地假定时刻并跳过偏差检查,§5)、end 钳制披露(若发生)、告警接口可达/不可达(不可达=警告,不阻断,决策 #12)、`tzSource` 回退提示(若发生)。

按钮:[开始导出] [返回]。**0 bag**(含 predecessor 后仍为 0,决策 #16)时替换为警告条 + [仍导出日志与告警] [返回修改]。logPath 列举失败且勾选日志 → 预览错误,取消勾选后可继续(§14)。

### 9.3 Step C:导出中

- 开始即**并发发起正式告警查询**(决策 #28,窗口=§5 换算的 `[startUnixMs, endUnixMs]`);
- 顺序下载 bags → logs,逐条目写入 zip(§8);**logs 写完后主动断开桥接**——余下阶段仅需本地写盘,且规避桥接闲置超时(`IDLE_TIMEOUT_MS` 10min)在"等待告警查询"阶段触发 `sshClosed{reason:"idle"}` 误杀已完成下载(§14);随后写 alarms.json(查询成功;`data` 为空也写原始响应,`status:"empty"`)与 manifest;
- UI:**单条总进度条**(Σ 勾选 size,`fileStart` 修正沿用;条目内进度并入总量,不再单独展示)+ 统计行("已完成 / 总量 · 速率 · 剩余时间";速率=10s 滑动窗口内累计字节差 ÷ 墙钟差,逐秒结算,停传时自然衰减,仅下载阶段展示)+ 阶段标签("下载 bag i/N"、"下载日志 j/M"、"等待告警查询"、"写入清单")+ 当前下载文件名(下载结束后不再展示);
- [取消] → 整包作废(决策 #20,清理路径沿用原 §7:停发 download、在途 cancel、abort zip、删除部分包;**并发中的告警 fetch 一并 abort**);
- 触发整包作废的情形沿用原 §7 表(任一条目失败/本地写失败/**下载阶段**的 WS 断开/sshClosed/取消);**告警查询失败不在其中**(决策 #12);**主动断开桥接之后的 WS 断开/sshClosed 亦不在其中**。

### 9.4 Step D:汇总

- 成功组标题注明产物 zip 名;**警告组**新增:告警失败原因、active 跳过数、未识别名跳过数、`browser-assumed` 回退;失败组/未开始组沿用;
- [重试失败项] = 整包重跑(决策 #20,沿用同一 zip 名);
- [立即导入播放](决策 #24,无失败组**且导出包含 bag**时出现——告警失败仅入警告组,**不影响**该按钮出现;0-bag 导出(决策 #16「仍导出」)的包不可播放——§11.3 空 bags 拒绝导入——汇总页明示"此包仅归档,不可导入播放"且**不出**该按钮):Web → `target.readFile(zipName)`(懒加载 File);桌面 → `target.readFileUrl(zipName)`(§13);随后 `selectSource("robot-export-package", { type: "file", files: [file] })` 或 `{ type: "connection", params: { url } }` 形态(§11.4),关闭对话框;
- WS 断开导致的失败:重试先静默重连桥接+SSH(密码在内存)沿用。

## 10. 告警数据获取(导出侧)

- 复用 `packages/studio-base/src/components/PlaybackControls/alarms/fetchRobotStatus.ts`(development 代理路径改写、10 分钟超时、§4.3 校验均在既有实现内),host/端口取**表单值**;**签名改为双输出**:`Promise<{ rawText: string; records: RobotStatusRecord[] }>`——先 `res.text()` 再内部 `JSON.parse`,校验/超时/中止语义不变;既有调用点(泳道 `useRobotAlarms`)改取 `.records`,行为零变化;
- 成功:响应**原始 body 文本**(`rawText`)写入 `alarms.json`;`records.length === 0`(覆盖 `data: null` 与 `[]` 两种空态)→ manifest `alarms.status = "empty"`,仍写文件;
- 失败/超时:manifest `alarms.status = "failed"` + `error` 文案,**无 alarms.json 条目**,导出继续(决策 #12),汇总页警告组列原因。

## 11. 导入播放架构

### 11.1 zip 随机访问(`zipArchiveReader.ts`,纯逻辑,worker 可用)

```ts
interface RandomAccessReader {           // 统一的随机读抽象
  size(): number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
// 两个实现:
//  - BlobRandomAccessReader:Blob.slice().arrayBuffer()(Web 输入文件/懒加载 File,worker 内可用)
//  - CachedFilelikeRandomAccessReader:包装既有 CachedFilelike(桌面闭环 URL,§13)
```

- `openZipArchive(reader)`:定位 EOCD(尾部 64KiB+22 扫描)→ 若哨兵/计数溢出则经 **ZIP64 locator → ZIP64 EOCD** → 解析中央目录 → `entries: Array<{ name, size, dataOffset, mtimeMs }>`;`dataOffset` 由条目本地头现算(跳过本地 name/extra,**不依赖中央目录的相对偏移之外的任何假设**);
- 拒绝并给出明确错误:压缩方法 ≠ 0(非 Store)、多分卷、加密标志、中央目录越界/截断;
- `openEntryReader(entry)`:区间视图 `{ size, read }`(offset 平移),供 bag Filelike 适配器使用;
- 小条目便捷方法 `readEntryText(entry)`(manifest/alarms.json);
- 与 §8 writer **格式对称**:经典 + zip64 + 数据描述符(描述符不进随机访问路径——一切以中央目录为准)。

### 11.2 bag Filelike 适配

`@foxglove/rosbag` 的 `Bag` 接受任意 `Filelike`(`CachedFilelike` 即先例)。新增 `RangedFilelike` 实现 `Filelike` 接口(`read(offset, length)` + `size()`,与 §11.1 `RandomAccessReader` 同形,薄适配),每个 bag 条目一个实例,运行形态与 `BagIterableSource` 完全一致(decompress 配置复用)。

### 11.3 多 bag 归并(`MergedBagIterableSource.ts`,worker 侧,决策 #5)

实现 `IIterableSource`:

- **构造**:`{ type: "file"; file: File } | { type: "remote"; url: string }`(镜像 `BagIterableSource` 的两种形态);分片的打开与迭代走**注入式工厂**(默认实现按 §11.2 打开 `Bag`),单测可用内存 stub 替代(§16);
- **initialize()**:开 zip 归档(§11.1)→ 读 manifest(**严格**,决策 #22:`format`/`formatVersion` 不支持 → 抛带用户可读文案的 Error)→ `bags/` 条目按 §6 排序规则排序——文件名不可按 §5 正则解析的条目(手工改造包)跳过并记 problem("N 个 bag 条目名未识别,已跳过");可解析条目为 0 → 抛错"导出包不含 bag"→ 逐条打开 `Bag`(失败分片记 `PlayerProblem` 并跳过,全失败 → 抛错)→ 合并 `Initalization`:
  - `start = min(各分片 start)`,`end = max(各分片 end)`(决策 #8:完整分片内容);
  - `topics`/`publishersByTopic` 并集;`datatypes` 并集——同名 topic datatype 冲突:先到先得 + problem 披露;
  - `topicStats` 按 topic 合并(numMessages 求和,首末时间取极值);`problems` 串接;`name` 取 zip 文件名;
- **messageIterator(args)**:对每个分片以相同 args 建迭代器,**k 路按 receiveTime 归并**(每分片缓冲 1 条,取最小者发出);`stamp` 取各分片最小 stamp 发出;`problem` 透传;**重复消息不去重**(决策 #8);分片耗尽即出堆,天然支持"顺序分片"与"重叠分片"两种形态;
- **连接 ID 处理**(决策 #32):分片各自持有 `Bag`/`MessageReader` 独立解码,datatypes/reader 天然隔离、无需全局表;`MessageEvent` 本身无 `connectionId` 字段,需全局化的仅 **problem 型 `IteratorResult` 的 `connectionId`**(用于问题归因):分片 i 的 connectionId 映射为全局 id(如 `i * 2**20 + connId`,分片内按 bag 实际 id)后透传,避免跨分片归因串号;
- **getBackfillMessages**:各分片分别取 backfill,按 topic 取 receiveTime 最大者合并;
- 播放链路其余部分(IterablePlayer/MessagePipeline)**零改动**——归并源就是一个普通 IIterableSource。

### 11.4 数据源工厂与入口

- 新增 `RobotExportPackageDataSourceFactory`:`id = "robot-export-package"`,`displayName = "机器人导出包"`,`supportedFileTypes: [".zip"]`(决策 #26:拖拽 zip 直接打开),`iconName` 沿用文件类;
- `initialize(args)`:`args.file` → `{type:"file", file}`;`args.params.url` → `{type:"remote", url}`(桌面闭环,§13);构造 `WorkerIterableSource` + `IterablePlayer`,file 接线镜像 `Ros1LocalBagDataSourceFactory.ts`、url 分支形态参考 `RemoteDataSourceFactory.tsx:84-106`;worker 为**新建** `MergedBagIterableSourceWorker.worker.ts`(自带 `initialize()` 按 file/url 分发 + `Comlink.expose`,镜像 `BagIterableSourceWorker.worker.ts:13-23`;通用包装 `WorkerIterableSourceWorker.ts` **零改动**——仓库无集中式 switch 分发);
- 数据源注册列表(studio-web 的 availableSources 装配处)登记;
- 入口(决策 #24):数据源对话框新增「机器人导出包」项(文件选择用 `<input type="file" accept=".zip">`——Electron 下即原生对话框,返回懒加载 File,两端统一,无需桌面 IPC);拖拽 `.zip`;导出汇总页「立即导入播放」(§9.4)。

### 11.5 `PlayerSelection.selectedFiles` / `selectedParams`(决策 #31)

`PlayerSelectionContext` 接口新增 `selectedFiles?: File[]`(文件型数据源)与 `selectedParams?: Record<string, string | undefined>`(连接型数据源,携带 url);`PlayerManager` 在成功构建 player 时按形态写入其一,切换/关闭数据源时两者清空。`useRobotAlarms` 经此取导入包 File 或桌面闭环 URL(§12)。connection 分支对带 url 的选择会自动写入"最近数据源"(`addRecent`)——闭环 URL 含会话 token,重启后必失效,故 `robot-export-package` 的该路径**不写 recent**(按 sourceId 跳过,随本节 PlayerManager 改动一并处理;文件形态本就不入 recent,§21)。

## 12. 告警泳道扩展(导入包路径)

### 12.1 资格与取数

`useRobotAlarms.tsx:79` 的 `eligible` 扩展为两路(现状为 `selectedSource?.type === "file" && id === "ros1-local-bagfile"`):

```
ros1-local-bagfile   → 现状不变(在线 fetch,host/port 门控沿用,仍要求 type === "file")
robot-export-package → 包内路径:不查网络、不受 host/port 配置门控;
                       资格判定只看 selectedSource.id,type 不参与——该工厂 type 恒为 "file",
                       桌面闭环的 "connection" 指选择参数形态(§9.4),取数通道按
                       selectedFiles/selectedParams 的存在性区分(见下两形态)
```

包内取数两形态:

- **file 形态**(Web 闭环/文件选择/拖拽):从 `usePlayerSelection().selectedFiles?.[0]`(须为 zip)经 `zipArchiveReader` 读取 `alarms.json`;
- **remote 形态**(桌面闭环,File 不可得):从 `selectedParams?.url`(§11.5)经 `CachedFilelike` 包装为 `CachedFilelikeRandomAccessReader`(§11.1)读取包内 `alarms.json` 条目。

两形态随后统一:按 SPEC_playback_alarm_lane §4.3 校验(status_code/data)→ 记录喂入 `mergeAlarmIntervals`(复用,裁剪到 bag 起止的逻辑不变——bag 起止现为归并后的完整分片范围,决策 #8)。

### 12.2 状态机调整

- `queryKey` 现状已含 `sourceId` 维度(useRobotAlarms.tsx:103-113),无需扩展;包内路径的 key 不含 host/port;
- 包内路径的"请求"= 异步 zip 读,沿用同一状态机骨架(idle→loading→success/error)、同一 AbortController/inFlightRef 身份比较竞态纪律、`attemptedKeysRef` 去重;
- **alarms.json 缺失**(导出时告警失败,决策 #12):按成功空数据处理,泳道隐藏,并按查询键弹**一次 info 级提示**"导出包不含告警数据"(本规格决策 #22 的"给出提示";非 error,不带重试);
- alarms.json 存在但损坏(非 JSON/校验失败):error toast + 重试按钮(重试=重读 zip),泳道隐藏,**播放不受影响**。

## 13. 桌面端支撑(闭环 URL,决策 #25)

- `desktop/src/main.ts` 内嵌静态服务器新增路由 `/exported-file/<token>/<name>`:仅当 `<name>` 通过**复用 serverExport IPC 的既有裸文件名校验**(`exportFilePath`,main.ts:141-156)且父目录等于**本次会话最近一次选择的导出目录**时,以 **Range 支持**流式返回文件(该服务器现状为 catch-all 静态处理器、无 Range,本路由为首个 Range 路径);`token` 为主进程生成的随机会话密钥,经 preload 注入渲染进程(`globalThis.serverExportFs` 扩展 `readFileUrl(dir, name)` 拼装);校验失败一律 404;
- 安全:沿用 loopback 绑定 + 随机 token + 目录白名单,不暴露任意路径读;
- `DesktopExportTarget` 新增 `readFileUrl(name)`;`FileSystemAccessTarget`(Web)不实现该方法(闭环走 `readFile` 懒加载 File)。

## 14. 异常与状态语义

整包作废(决策 #20)统一清理路径沿用原 §7 五步(停发/在途 cancel/abort zip/删部分包/条目归组),触发情形:用户取消、任一 bag/日志下载失败、任一本地写入失败、**下载阶段**的桥接 WS 断开/sshClosed(logs 写完后客户端主动断开桥接,此后的断开不触发作废,§9.3)。**新增/修订**:

| 情形 | 语义 |
|------|------|
| 告警试连失败(预览) | 非致命,预览警告(决策 #12) |
| 正式告警查询失败/超时 | 非致命,警告组 + manifest `failed`,无 alarms.json(决策 #12) |
| `serverTime` 失败 | 回退浏览器时区,预览披露,manifest 记 `browser-assumed`(决策 #27) |
| 0 bag(含 predecessor) | 预览警告,用户二选一(决策 #16) |
| logPath 列举失败(勾选日志) | 预览错误,[开始导出] 禁用;取消「包含日志」后可继续 |
| bagPath 列举失败 | 预览错误,必须返回修改(不可跳过) |
| 下载中文件体积变化 | 数据描述符容忍(§8.1);进度修正沿用;不触发作废 |
| sshClosed(下载中) | 整包作废;重试先静默重连(密码内存)沿用 |
| sshClosed/WS 断开(下载完成后) | 不影响导出(logs 写完后已主动断开桥接,§9.3) |

## 15. 边界情况清单

1. bag 目录全是 `.bag.active` → skippedActive 计数 + 0 bag 警告路径(决策 #16/#23)。
2. end ≤ start → 表单校验禁用[连接并预览]。
3. end 晚于机器人当前时间 → §5 钳制 + 预览披露。
4. predecessor 不存在(区间起点早于全部 bag)→ 无前片,正常导出 in-range 部分。
5. 文件名未识别(缺 `_seq`、字段越界、扩展名大小写之外的变体)→ 跳过计数,预览附注,不参与筛选。
6. 同 `(naiveTime)` 多 seq → 按 seq 升序;seq 重复按名称排序兜底。
7. 日志递归遇 symlink→dir 成环 → canonical path visited 集合 + 深度上限 16(§4.3)。
8. 日志 symlink→file → v3 statFollow 已给目标 size/mtime,按目标字节下载;断链(v3 降级为 file 按链接自身)→ 下载 IO_ERROR → 整包作废(§14)。
9. 日志目录含 socket/fifo/设备 → 桥接不下发,UI 无感知。
10. 日志相对路径含非 ASCII/空格 → 条目名原样,UTF-8 标志位(沿用)。
11. `date` 命令输出异常(非 GNU/BusyBox 环境)→ 解析失败 → 决策 #27 回退。
12. 机器人时钟与本地偏差 >5 min → 预览警告(决策 #30),不阻断。
13. 告警查询窗口极大(多天)→ 沿用 10 分钟超时;与下载并发(决策 #28)不阻塞导出主体;超时按失败(警告)处理。
14. 取消时告警查询在途 → 一并 abort(§9.3)。
15. zip 名重名 → 自动 ` (1)`;重试沿用同名(§7.1)。
16. 磁盘空间不足 → 本地写失败 → 整包作废;空间无法可靠预检(§18 风险)。
17. 导入非导出包 zip(无 manifest/格式不识)→ 拒绝并提示"不是机器人导出包"。
18. 导入 `formatVersion > 1` → 拒绝并提示升级应用。
19. 导入仅日志+告警的包(bags/ 为空)→ 拒绝播放,提示导出包不含 bag(决策 #22)。
20. 导入时某分片损坏 → problem 披露并跳过;全部损坏 → 初始化失败。
21. 导入包 alarms.json 缺失 → 泳道隐藏 + 一次 info 提示(§12.2);损坏 → error toast + 重试(重读 zip)。
22. 分片间消息时间重叠 → 归并交错发出,不去重(决策 #8);Plot 等面板按时间轴渲染,重复点可见(§18 风险记录)。
23. 分片间同名 topic datatype 冲突 → first-wins + problem(§11.3);实践中轮转录制不会发生。
24. `selectedFiles`/`selectedParams` 缺失(如 player 经非文件路径重建)→ 泳道无数据隐藏,不报错。
25. 桌面闭环 URL 的 token 失配/目录不符 → 404,导入报"无法读取导出文件"(§13)。
26. 导入的 zip >4GB(ZIP64)→ 读取路径原生支持(§11.1);旧解压工具(不支持 ZIP64)手动解压可能失败(§18 风险)。
27. mtime 超 DOS 范围(脏文件)→ 钳制沿用,不报错。
28. 起止区间极长(数十小时,数百 GB)→ 不限制;预览总大小即风险提示(§18)。
29. 用户连续切换数据源 → 归并源 terminate 沿用 IterablePlayer 既有清理;泳道 queryKey 变化 abort 在途 zip 读。
30. bag 文件名时间相同但录制实际重叠(seq 并行场景,决策 #1 已排除)→ 规格假设单线轮转;若现场出现并行通道,归并依然正确(按时间交错),仅 manifest 的 role 标注可能失真——记录为已知边界。
31. 「等待告警查询」阶段桥接闲置超时(`IDLE_TIMEOUT_MS` 10min,与告警查询超时同长)→ logs 写完后已主动断开桥接(§9.3),竞态不存在;主动断开失败时,该阶段的 sshClosed 亦按非作废处理(§14)。
32. 0-bag 导出(决策 #16「仍导出」)的汇总页 → 不出现[立即导入播放],明示"此包仅归档,不可导入播放"(§9.4;§11.3 空 bags 拒绝导入)。
33. 导入包 bags/ 内含不可按 §5 正则解析文件名的条目(手工改造包)→ 跳过该分片并记 problem("N 个 bag 条目名未识别,已跳过");可解析条目为 0 → 按"导出包不含 bag"拒绝(§11.3)。

## 16. 测试要求

沿用仓库惯例(纯函数必测、桥接协议层必测、UI 层不强制),并须通过 `yarn lint:ci` 与 `yarn build:packages`:

**桥接(`packages/ssh-bridge/src/*.test.ts` 扩展)**
- `parseClientMessage`:`serverTime` 合法/非法帧;
- `getServerTime`:mock exec 输出 `%s %z` 正负偏移解析、5s 超时、异常输出拒绝、固定命令串断言(不得出现参数化命令);
- 版本:hello v3 拒绝、v4 通过。

**bag 筛选(新 `selectBagsForExport` 纯函数)**
- §6 全路径:区间内闭区间边界、predecessor 选出/不存在/predecessor 即 active、active 跳过计数、未识别名跳过计数、同刻多 seq 排序、0 bag 判定(计入 predecessor)。

**时间换算(§5,纯函数)**
- naive⇄Unix ms:正偏移(UTC+8,+480)与负偏移(UTC−5,−300)各一例;浏览器回退 `tzOffsetMinutes = -new Date().getTimezoneOffset()` 的**符号断言**(防 2×tz 偏差回归);end 钳制与 `robotNowNaive` 折算;文件名 naive 串与 `datetime-local` 输入的归一化比较。

**ZIP64 writer(重写 `serverExportZip` 测试)**
- 经典路径 round-trip(fflate `unzipSync` 校验字节、条目序、mtime 钳制、UTF-8 名、数据描述符带签名 `0x08074b50`);
- **注入式阈值**下的 zip64 路径:单条目 size 越界(本地头哨兵 + extra + 8 字节描述符)、累计 offset 越界(中央目录哨兵 + zip64 EOCD + locator)、条目数越界;用 §11.1 reader 读回校验;
- 数据描述符:`endEntry(actualSize)` 与 fileStart 不符时以 actualSize 落盘;
- `abort()`:不写中央目录、abort 后 push 为 no-op、`removeEntry` 调用(沿用原断言集)。

**zipArchiveReader**
- EOCD 定位(含尾部注释干扰)、zip64 locator/EOCD、中央目录解析、`dataOffset` 现算正确性;
- 拒绝路径:deflate 条目、加密标志、多分卷、截断文件;
- 区间视图 read 平移正确;`readEntryText`。

**MergedBagIterableSource**
- 分片经 §11.3 注入式工厂以**内存 stub** 构造(两个/三个分片)验证:initialize 合并(start/end/topics/datatypes/problem)、k 路归并顺序(含重叠时间、重复保留)、stamp 语义、backfill 按 topic 取最新、problem connectionId 全局映射不串号、损坏分片跳过与全失败;
- 一条真 bag 端到端冒烟:复用仓库既有夹具(`studio-base/src/test/fixtures/example.bag` 等,当前无引用、本特性激活)或测试内最小 bag 字节构造器——后者仅限测试代码,不构成决策 #5 排除的生产 bag 写入器;
- manifest 严格校验:缺 format/版本不符/空 bags。

**告警泳道扩展**
- `fetchRobotStatus` 双输出:`rawText` 为响应原始 body、`records` 解析结果不变、`data: null` → `[]`;既有超时/校验/中止路径回归;泳道调用点改取 `.records` 后行为不变(§10)。
- `robot-export-package` 有资格(不区分选择形态,见 §12.1)且不发网络请求;从 zip File 读 alarms.json 成功出区间;remote 形态(`selectedParams.url`)经 CachedFilelike 读 alarms.json 成功出区间;缺失 → info 提示一次 + 隐藏;损坏 → error toast + 重试重读;`selectedFiles`/`selectedParams` 缺失 → 隐藏不报错;在线路径回归(ros1-local-bagfile 行为不变)。

**PlayerSelection**:selectedFiles/selectedParams 写入/清空。

## 17. 明确不做(Out of Scope)

- 下载时合并为单个 bag / 转码 MCAP / 自研 bag 写入器(决策 #5,播放层归并替代)
- 桥接任意 shell exec(仅固定 `date` 命令,§4.2)、在机器人上执行合并脚本
- 断点续传、增量补包、部分包保留、单文件失败跳过(决策 #20)
- bag 消息级时间裁剪(决策 #2/#8:导出与播放均按分片整体)
- 应用内日志查看器(决策 #17:仅归档携带)
- deflate 压缩(沿用决策 Z2)
- 浏览式文件导出 UI(决策 #9:移除;通用文件导出需求由 zip 内日志全量+运维场景自行 SCP 覆盖)
- 生产 Web 部署的 CORS/混合内容兜底(决策 #15,沿用告警泳道规格 §12 风险 #1)
- 非 Chromium 浏览器、ZIP64 之外的压缩/加密 zip、zip 密码保护
- 告警在线刷新(导入包场景,决策 #7:包内数据为唯一来源)

## 18. 风险与已知限制

1. **ZIP64 兼容性**:现代解压工具(Windows 资源管理器/macOS/7-Zip/Info-ZIP)均支持 ZIP64;古旧工具手动解压 >4GB 包可能失败。导入播放不受影响(自研 reader 原生支持)。
2. **时钟假设链**:bag 文件名时区=机器人系统时区(决策 #4),`serverTime` 失败回退浏览器时区可能查错告警窗口——manifest 记 `tzSource` 供排查;机器人时钟漂移不影响 bag 与告警的内部自洽(同为机器人时钟),仅影响"现在"的直觉判断,预览 >5min 偏差警告覆盖。
3. **磁盘空间不可预检**:导出处空间不足表现为写失败 → 整包作废 + 重跑(决策 #20 的已知代价);预览展示总大小供人工判断。
4. **symlink 逃逸**:沿用原规格 §12 立场(凭据即用户本人,无权限放大);递归遍历的环由 canonical visited + 深度上限防护(§4.3)。
5. **重叠分片不去重**:Plot/统计面板对重叠时段可能双计(决策 #8 忠实原始数据的代价);轮转录制实践中重叠罕见。
6. **桌面闭环 URL**:loopback + 随机 token + 目录白名单,威胁面与既有静态服务器一致;token 不落盘。
7. **大导出包的归并初始化开销**:initialize 需打开全部分片的 Bag(读各自索引);分片数百个时初始化耗时与内存上升——典型几十分钟~几小时导出(几个~几十个分片)无虞,极端场景记录。
8. **重试重传**:整包作废 + 重跑在大时段导出下代价高(决策 #20 已确认接受);后续扩展路线可评增量补包。
9. **生产 Web 部署**:告警接口 CORS 与混合内容限制沿用既有立场(决策 #15)。

## 19. 后续扩展路线

| 扩展 | 触发条件 |
|------|----------|
| 增量补包/断点续传 | 不稳定网络下大导出重传代价不可接受 |
| 应用内日志查看面板 | 支持团队要求包内直接看日志 |
| 导出包分享校验(sha256 清单入 manifest) | 跨团队传递导出包 |
| 下载时可选合并单 bag(若上游出现可靠 JS bag 写入器) | 外部 ROS 工具消费场景增多 |
| formatVersion 2(如增加码表、事件数据) | 告警服务接口演进 |

## 20. i18n

英文 + 简体中文(沿用仓库惯例;ja 不新增,删除 zh 失效 key):

- `openDialog` namespace:表单字段标签/校验文案、预览页清单与警告、阶段标签、汇总页警告组、[开始导出][仍导出日志与告警][立即导入播放] 等;**移除**浏览式导出的失效 key(过滤框/徽标/全选/导出并打开等);
- `robotAlarms` namespace:`packageNoAlarms`(导出包不含告警数据,info)、包内读取失败文案;
- 数据源 `displayName` 按现有工厂惯例为**硬编码字符串**(不走 i18n 框架,如 `Ros1LocalBagDataSourceFactory` 的 "ROS 1 Bag"),取 `"Robot Export Package"`;表单/预览/汇总等对话框内文案仍走上述 namespace。

## 21. 改动清单(文件级)

| 位置 | 改动 |
|------|------|
| `packages/ssh-bridge/src/protocol.ts` | v4;`serverTime` 消息对 + 解析(§4.1) |
| `.../ssh-bridge/src/SshSession.ts`、`ssh2Connector.ts`(+mock) | `getServerTime`(固定 `date` 命令 exec,§4.2) |
| `.../ssh-bridge/src/SshBridge.ts` | `serverTime` 分发与错误映射 |
| `.../ssh-bridge/src/*.test.ts` | §16 桥接测试 |
| `.../studio-base/src/components/DataSourceDialog/ServerExport.tsx` | **重写**为任务表单四步流(§9);浏览 UI 删除 |
| `.../DataSourceDialog/ServerExportBridgeClient.ts` | 版本 4 + `requestServerTime()` |
| `.../DataSourceDialog/serverExportZip.ts` | **重写** ZIP64 writer(§8) |
| 新 `.../DataSourceDialog/selectBagsForExport.ts` | §6 纯函数 + 文件名解析 |
| 新 `.../DataSourceDialog/exportManifest.ts` | §7.3 构建/序列化 |
| `.../DataSourceDialog/serverExportTarget.ts` | 桌面 `readFileUrl`;删除仅"导出并打开"使用的调用点(readFile 保留供 Web 闭环) |
| `.../DataSourceDialog/serverExportBrowser.ts` | **删除**(决策 #9) |
| 新 `.../players/IterablePlayer/zipArchiveReader.ts` | §11.1(+ `RangedFilelike`) |
| 新 `.../players/IterablePlayer/MergedBagIterableSource.ts` | §11.3 |
| 新 `.../players/IterablePlayer/MergedBagIterableSourceWorker.worker.ts` | worker 入口:`initialize()` 按 file/url 分发 + `Comlink.expose`(§11.4);`WorkerIterableSourceWorker.ts` 零改动 |
| 新 `.../dataSources/RobotExportPackageDataSourceFactory.ts` + 注册处 | §11.4 |
| `.../context/PlayerSelectionContext.ts`、`.../components/PlayerManager.tsx` | `selectedFiles` / `selectedParams`(§11.5) |
| `.../PlaybackControls/alarms/fetchRobotStatus.ts` | 双输出签名 `{ rawText, records }`(§10) |
| `.../PlaybackControls/alarms/useRobotAlarms.tsx` | 包内数据路径(§12);调用点改取 `.records`(§10) |
| `.../AppSetting.ts` | `ROBOT_EXPORT_SSH_PORT`/`ROBOT_EXPORT_USERNAME`/`ROBOT_EXPORT_BAG_PATH`/`ROBOT_EXPORT_LOG_PATH`/`ROBOT_EXPORT_INCLUDE_LOGS` |
| `desktop/src/main.ts`、`desktop/src/preload.ts` | 闭环 Range 路由 + token + `readFileUrl`(§13) |
| `.../i18n/en/` + `i18n/zh/`(`openDialog`、`robotAlarms`) | §20 |
| 测试:§16 全部新文件对应 `*.test.ts(x)` | 必需项见 §16 |

依赖:**不新增 npm 包**(ZIP64 自写;读取自写;bag 解析/mcap 无关包复用现有)。

新增、修改的关键代码按项目要求添加多行简体中文注释;遵守仓库规范:MPL 头、禁 `null`、`#private`、`setTimeout` 显式 delay、`console` 仅 warn/error/debug、禁 todo/fixme 注释;不主动格式化无关代码。
