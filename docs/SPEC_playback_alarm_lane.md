# SPEC: 播放进度条告警泳道(Playback Alarm Lane)

> 状态:已确认(经 4 轮访谈,并完成代码链路审查修订)
> 日期:2026-08-12
> 涉及仓库:foxglove-opensource(Web 与桌面版共用 studio-base)

## 1. 背景与目标

打开本地 ROS1 `.bag` 文件 / 服务器导出 ROS1 `.bag` 播放时,在**播放进度条(Scrubber)下方**新增一条与时间轴对齐的
**告警泳道**:机器人告警服务返回的状态采样中,`alarm_message` 非空的时间段渲染为**红色区间**;
鼠标悬停红色区间弹出 tooltip,展示**鼠标所指时刻最近一条采样记录的全部字段**;点击红色区间
将播放头 seek 到该告警区间的起始时刻。

告警数据来源(机器人上的 HTTP 服务,无鉴权):

```
POST http://{host}:{port}/rbrainrobot/data/get_robot_status_list
Content-Type: application/json

{"data": {"start_time": 1785719891098, "stop_time": 1785719904652}}
```

查询范围 = 当前 bag 的起止时间(`PlayerState.activeData.startTime/endTime` 转 ms)。
host/port 在 App 设置页可配置,默认 `10.11.2.208:50004`。

## 2. 访谈决策汇总

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 展示形式 | **告警泳道**:进度条正下方一条与时间轴对齐的细轨道,有告警的时段渲染红色区间,悬停弹详情 tooltip |
| 2 | 数据语义 | 接口返回约 1Hz 周期状态采样,`alarm_message` 为该时刻激活的告警码集合(空串=无告警);**相邻告警采样合并为连续红色区间**(§5) |
| 3 | 告警码展示 | **直接显示原始码**(如 `261; 262`),不内置码表、不引入额外表接口 |
| 4 | hover 详情内容 | **全部字段表格**(接口记录的所有字段) |
| 5 | 详情取数 | **随鼠标位置取最近采样**:鼠标在区间内移动时,tooltip 实时切换为所指时刻最近的一条采样 |
| 6 | 查询时机 | **每个查询键自动查询一次**:合格数据源首次进入 `PRESENT` 且起止时间可用后触发;同一键后续短暂 `BUFFERING` 不 abort、不重查(§8) |
| 7 | 生效范围 | **首版仅 ROS1 本地 bag 数据源**(`selectedSource.type === "file" && selectedSource.id === "ros1-local-bagfile"`);服务器"导出并打开"最终也进入该数据源。MCAP/ROS2 bag/ULog/远程文件/示例/实时连接暂不触发,待分别确认时间语义后再扩展 |
| 8 | 网络限制 | **前端直接 fetch**;跨域 JSON POST 会触发 `OPTIONS` 预检。**实施修订(2026-08-13)**:服务端确认不支持 CORS 且不可修改,改为客户端规避——development 构建(web:serve)经 dev server 同源代理转发,桌面端 Electron 关闭 `webSecurity`;仅生产 Web 部署仍要求服务端实现 §4.1 的 CORS 契约或加反向代理(§12 风险记录在案) |
| 9 | 配置入口 | **App 设置页通用页**新增"告警服务"设置,host + port 两个字段,AppConfiguration 持久化,默认 `10.11.2.208` / `50004` |
| 10 | 点击行为 | **点击红色区间 seek 到该区间起始时刻** |
| 11 | 查询失败 | **全局 toast 报错**(notistack `enqueueSnackbar`,variant error),泳道不渲染 |
| 12 | 时间语义 | **确认 ROS1 bag 内消息时间为 Unix 墙钟**,与接口 ms 时间戳同源,直接换算;不得把此结论外推到 ULog 等其他格式 |
| 13 | 无告警时 | **泳道完全隐藏**(查询成功但无告警、加载中、未加载数据源时均不渲染) |
| 14 | 接口细节 | **POST + JSON body,无鉴权**;路径固定 `/rbrainrobot/data/get_robot_status_list` |
| 15 | 字段标签 | 表格字段名显示**英文原字段名**(`action_info`、`power` …),不做中文映射 |
| 16 | 数据量级 | 典型 bag 几十分钟(几千条采样),接口一次返回;**不做分页/降采样**,前端合并区间后渲染量天然很小 |

补充设计(实现细节,未单列访谈):

| # | 决策点 | 结论 |
|---|--------|------|
| 17 | 功能开关 | host 或 port 配置为**空字符串即禁用**整个功能(不查询、不渲染、不 toast)——不额外加开关 UI;空串必须作为有效配置持久化,重新挂载/重启后仍保持禁用 |
| 18 | 请求超时 | 10 分钟,超时按查询失败处理(toast) |
| 19 | toast 去重 | 同一查询键(数据源 + 地址 + 时间段)只 toast 一次,避免重复打扰 |
| 20 | i18n | 英文 + 简体中文(沿用仓库惯例) |
| 21 | 失败重试(2026-08-13 追加) | 失败 toast 附**"重试"按钮**:点击后从 attempted/toasted 记录中移除当前 key,按**同一查询键**重新查询一次;重试请求在途期间忽略重复点击,不并发重发 |
| 22 | 无告警成功提示(2026-08-13 追加) | `status_code === 200` 但 `data` 为 `null`/缺失时视为**成功的空数据**(服务端无告警时不返回数组),不再按"非数组"报错;查询成功但**无任何告警**(data 为 null、空数组或全部无告警采样)时弹**绿色成功 toast**"没有告警";泳道仍隐藏(决策 #13) |

## 3. 总体架构

```
┌─────────────────────────────── PlaybackControls ───────────────────────────────┐
│  <Scrubber/>                        ← 现有播放进度条(不改动内部)              │
│  <AlarmLane onSeek={seek}/>         ← 新增:告警泳道(无告警时不渲染)           │
│  [播放控制行: 时间显示 / 播放按钮 / 倍速 …]   ← 现有                            │
└────────────────────────────────────────────────────────────────────────────────┘

AlarmLane
   └─ useRobotAlarms()                ← 新增 hook:数据获取 + 状态机 + 竞态
        ├─ useMessagePipeline: presence / playerState.playerId / startTime / endTime
        ├─ usePlayerSelection: selectedSource.type / selectedSource.id
        ├─ useRobotAlarmConfiguration:保留空串的 host / port 配置
        └─ fetchRobotStatus()         ← 新增:fetch 封装(POST/超时/中止/响应校验)
              → mergeAlarmIntervals() ← 新增纯函数:采样 → 告警区间(可单测)
```

**为什么不走 Player/数据源层**:告警数据不属于消息流,面板不订阅它;它只是播放条上的
一个只读注解层。挂在 PlaybackControls 下、从 MessagePipeline 读起止时间是最小侵入方案——
Web 与桌面版零分叉。是否允许查询必须显式结合 `PlayerSelection.selectedSource` 判断,不能仅凭
`activeData.startTime/endTime` 推断数据源是本地文件(决策 #7)。

## 4. 接口契约

### 4.1 请求

```
POST http://{host}:{port}/rbrainrobot/data/get_robot_status_list
Content-Type: application/json
```

```jsonc
{
  "data": {
    "start_time": 1785719891098, // toMillis(startTime, false),向下取整
    "stop_time": 1785719904652   // toMillis(endTime, true),向上取整
  }
}
```

无鉴权头。超时 10 分钟(决策 #18——服务端大数据量查询可能很慢,放宽等待)。

Web 跨域调用的服务端最低 CORS 契约:

- 正确响应浏览器发起的 `OPTIONS` 预检请求;
- `Access-Control-Allow-Origin` 允许实际部署页面的来源;
- `Access-Control-Allow-Methods` 包含 `POST`;
- `Access-Control-Allow-Headers` 包含 `Content-Type`。

仅配置 `Access-Control-Allow-Origin` 不足以放行 `Content-Type: application/json` 的跨域 POST。

> 实施注记(2026-08-13):服务端未实现上述契约,已改由客户端规避——`yarn web:serve`
> 开发环境将请求改写为同源路径 `/robot-alarm-proxy/{host}/{port}/...`,由 dev server
> 动态代理到真实服务(见 `packages/studio-web/src/webpackConfigs.ts`);桌面端 Electron
> `webPreferences.webSecurity: false` 直接放行跨域(见 `desktop/src/main.ts`)。因此
> 以下契约仅对"生产 Web 部署到浏览器"场景仍然有效。

### 4.2 响应

```jsonc
{
  "status_code": 200,
  "message": "成功",
  "data": [
    {
      "id": 1331713,
      "time": 1785719898002,        // ms 时间戳,采样时刻
      "alarm_message": "261;262;",  // 分号分隔告警码,可空串;注意末尾有多余分号
      "action_info": "退出暂停状态",
      "task_id": "-",
      "power": 100,
      "linear_speed": 0,
      "angle_speed": 0,
      "steer": 0,
      "work_model": 1,
      "agv_model": 0,
      "charge_model": 0,
      "fork_model": 0,
      "load_model": 0,
      "release_model": false,
      "reset_button": 0
    }
    // …约 1Hz 周期采样
  ]
}
```

### 4.3 响应校验

满足以下全部条件才视为成功,否则按查询失败处理(toast,决策 #11):

1. HTTP `res.ok`;
2. `body.status_code === 200`;
3. `Array.isArray(body.data)`;**例外(2026-08-13,决策 #22)**:`status_code === 200` 且
   `data` 为 `null`/缺失时视为成功的空数据(服务端在无告警时不返回数组),不报错。

`data` 为空数组是**成功**(无数据 → 泳道隐藏),不是失败。查询成功且无任何告警区间时
弹绿色成功 toast"没有告警"(决策 #22)。

### 4.4 记录解析

- 仅接收 `typeof time === "number" && Number.isFinite(time)` 的记录,其余记录丢弃。
- 仅保留 `time` 位于闭区间 `[startMs, stopMs]` 内的记录;接口越界返回不参与区间生成或 tooltip。
- 防御性按 `time` 升序稳定排序(不假设服务端有序);输入记录不得原地排序/修改。
- 告警码解析:`alarm_message.split(";")` → 逐段 `trim` → 滤空 → `string[]`。
  `"261;262;"` → `["261", "262"]`;`""` / `undefined` / 仅含分号空格 → `[]`(无告警)。
- 记录字段宽松读取:除 `time`(必需,非数值则丢弃该条)与 `alarm_message` 外,其余字段
  原样透传用于展示,不做类型假设。
- 若 `startMs` / `stopMs` 非有限数值或 `stopMs <= startMs`,直接返回空区间且不发接口请求。

## 5. 区间合并算法(`mergeAlarmIntervals`)

纯函数,输入采样记录数组与 bag 起止 ms,输出告警区间数组:

```ts
type RobotStatusRecord = {
  time: number;                    // ms
  alarm_message?: string;          // 原始串
  [key: string]: unknown;          // 其余字段原样透传
};

type AlarmSample = RobotStatusRecord & {
  alarmCodes: string[];            // mergeAlarmIntervals 解析后的码(§4.4)
};

type AlarmInterval = {
  startMs: number;                 // 区间内首个告警采样的 time
  endMs: number;                   // 区间内最末告警采样的 time + 采样间隔,封顶 stopMs
  samples: AlarmSample[];          // 区间内的告警采样(升序)
};
```

算法:

1. 按 §4.4 解析、范围过滤并排序**全部有效采样**,不能先丢弃无告警采样。
2. 从全部有效采样的相邻时间差中取严格大于 0 的值,其中位数作为 `intervalMs`;
   不存在正差时回退 1000ms。重复时间产生的 0 差值不参与周期估计。
3. `gapThresholdMs = max(2 × intervalMs, 2000ms)`。
4. 顺序扫描全部采样:
   - 当前记录有告警且尚无活动区间:以该记录开启新区间;
   - 当前记录有告警且与上一条有效记录的间隔 `<= gapThresholdMs`:追加到活动区间;
   - 当前记录有告警但间隔 `> gapThresholdMs`:先按“末告警采样 + `intervalMs`”关闭旧区间,
     再以当前记录开启新区间;
   - 当前记录明确无告警:立即关闭活动区间。若它与末告警采样的间隔
     `<= gapThresholdMs`,`endMs` 取该无告警记录的 `time`;否则说明中间存在大空洞,
     `endMs` 取末告警采样 `time + intervalMs`。
5. 扫描结束仍有活动区间时,`endMs = 末告警采样 time + intervalMs`。
6. 所有输出区间最终执行双端裁剪:
   `startMs = max(startMs, bagStartMs)`,`endMs = min(endMs, bagStopMs)`;
   保证不会渲染或 seek 到 bag 时间范围之外。裁剪后 `endMs <= startMs` 的零/负长度区间丢弃。

因此 `告警@0s → 空串@1s → 告警@2s` 必须生成两个区间,不能因两个告警采样相距 2 秒而误合并。
容忍规则只用于**没有采样**的偶发空洞;明确的空 `alarm_message` 永远表示告警已恢复。

渲染量:区间数 ≪ 采样数(决策 #16),直接每区间一个 DOM 节点,不做虚拟化。

## 6. UI 设计

### 6.1 布局

`PlaybackControls/index.tsx` 根节点为纵向 flex:在现有 `scrubberWrapper` 与播放控制行
**之间**插入 `<AlarmLane onSeek={seek} />`。泳道与进度条等宽、左右对齐。

泳道(渲染时):

```
┌──────────────────────────────────────────────────────────┐
│ ──────────────────────────────────────────────────────── │  Scrubber(现有)
│ ░░░░░░░░░░████████░░░░░░░░░░░░████████░░░░░░░░░░░░░░░░░░ │  AlarmLane:高 8px 轨道
│ [◀◀][▶] 12:03:21 / 01:00:00                    [1x][🔁]  │  控制行(现有)
└──────────────────────────────────────────────────────────┘
```

- 轨道:高 8px,全宽,`position: relative`,`overflow: hidden`,背景透明(不占视觉重量);
  上下各留 2px 间距。
- 红色区间:`position: absolute`;先将起止时间裁剪到 `[bagStartMs, bagStopMs]`,再把
  `left/width` 按 `(ms - bagStartMs) / (bagStopMs - bagStartMs)` 换算为百分比。仅在
  `bagStopMs > bagStartMs` 时计算布局;颜色 `theme.palette.error.main`,默认透明度约 0.8;
  **最小显示宽度 2px**。靠近右边界的短区间须调整 `left` 或由轨道裁剪,不得撑宽布局。
- hover 区间:透明度升至 1 并加 1px `error.main` 边框(与 EventsOverlay 的 hover 语言一致)。

### 6.2 显隐(决策 #13)

仅当 `status === "success"` 且 `intervals.length > 0` 时渲染;**加载中、无告警、查询失败、
无数据源时一律不渲染**,页面上完全无占位。接受的代价:查询是异步的,有告警时泳道会在
bag 加载后"晚一拍"出现,控制行下移约 12px——一次性跳动,可接受(访谈已确认隐藏优先)。

### 6.3 hover 详情 tooltip(决策 #4/#5/#15)

- 每个红色区间是一个可 hover 元素;`onMouseMove` 使用 `event.clientX` 与**整条泳道**的
  `getBoundingClientRect()` 反推当前 bag 时刻,并裁剪到当前区间范围。不得使用区间元素的
  `offsetX`,否则 2px 最小宽度、边框和嵌套节点会使时间映射失真。
- 在 `interval.samples` 中**二分查找最近采样**,写入组件 state;tooltip 内容随鼠标移动实时刷新。
- 用 MUI `Tooltip` + `followCursor`,或复用 Scrubber 的 Popper 锚点模式;二者择一,实现时
  以简单可靠为准。
- tooltip 内容 = 两列表格(`<table>` 或等效 grid):
  - 左列**英文原字段名**,右列值;`time` 行按 App 时区/时间格式设置格式化
    (`useAppTimeFormat`)。字符串、数字、布尔值用 `String(value)`;数组和对象使用
    `JSON.stringify(value)`,序列化失败时再回退 `String(value)`,避免显示为 `[object Object]`。
  - 字段顺序固定为接口示例顺序:`id, time, alarm_message, action_info, task_id, power,
    linear_speed, angle_speed, steer, work_model, agv_model, charge_model, fork_model,
    load_model, release_model, reset_button`;记录中多出的未知字段追加在末尾(防御)。
  - `alarm_message` 显示解析后的码,顿号/逗号连接:`261, 262`。
- tooltip 非交互(`disableInteractive`),鼠标移出区间即关。

### 6.4 点击 seek(决策 #10)

点击红色区间 → `onSeek(fromMillis(interval.startMs))`(复用 PlaybackControls 传入的
`seek`)。点击后是否继续播放由现有播放器行为决定,不做额外 pause/play 处理。

### 6.5 设置页(决策 #9/#17)

`AppSettingsDialog` 通用页新增"告警服务"区块:

- **host** 文本框,默认 `10.11.2.208`;**port** 文本框,默认 `50004`。
- 新建 `useRobotAlarmConfiguration` 并直接基于 `useAppConfiguration()` 读写
  `AppSetting.ROBOT_ALARM_HOST` / `AppSetting.ROBOT_ALARM_PORT`:底层值为 `undefined` 时才
  回退默认值,已持久化的空字符串必须原样返回。不能直接使用会把空字符串归一成
  `undefined` 的 `useAppConfigurationValue<string>`,否则“清空即禁用”在重挂载/重启后失效。
- 两个输入框均使用本地 draft,失焦后提交。host 去除首尾空白后入库;port 允许空串,非空时
  必须是 1–65535 的十进制整数。非法值不入库并显示校验错误。
- **任一字段清空 = 禁用功能**(决策 #17):不发请求、不渲染泳道、不 toast。设置项下方
  放一行说明文案告知此行为;空字符串必须跨组件重挂载和应用重启保持。
- 合法配置提交后对**当前已加载**的数据源立即生效(配置是查询依赖键的一部分,§8)。

## 7. 组件划分与改动清单

| 位置 | 改动 |
|------|------|
| `packages/studio-base/src/AppSetting.ts` | 枚举新增 `ROBOT_ALARM_HOST = "robotAlarm.host"`、`ROBOT_ALARM_PORT = "robotAlarm.port"` |
| `.../components/AppSettingsDialog/settings.tsx` | 新增并导出"告警服务"设置组件(§6.5) |
| `.../components/AppSettingsDialog/AppSettingsDialog.tsx` | 在通用页挂载"告警服务"设置组件 |
| 新文件 `.../components/PlaybackControls/alarms/robotAlarmTypes.ts` | `RobotStatusRecord`、`AlarmSample`、`AlarmInterval`、响应类型(§4/§5) |
| 新文件 `.../alarms/fetchRobotStatus.ts` | fetch 封装:POST、JSON、10 分钟超时(`AbortController` + 显式 delay 的 `setTimeout`)、§4.3 校验;抛带用户可读 message 的 Error;development 构建改写为同源代理路径(§4.1 实施注记) |
| 新文件 `.../alarms/mergeAlarmIntervals.ts` | §5 纯函数(含 `alarm_message` 解析) |
| 新文件 `packages/studio-base/src/hooks/useRobotAlarmConfiguration.ts` | 直接使用 `useAppConfiguration()`,区分“未设置”与“已保存空串”,提供默认值和持久化 setter(§6.5) |
| 新文件 `.../alarms/useRobotAlarms.tsx` | hook:订阅 MessagePipeline、PlayerSelection 与配置,驱动状态机,返回 `{status, intervals}`;失败时 toast 并附"重试"按钮(§8、决策 #21) |
| 新文件 `.../PlaybackControls/AlarmLane.tsx` | 泳道渲染、hover tooltip、点击 seek(§6) |
| `.../components/PlaybackControls/index.tsx` | 在 scrubberWrapper 与播放控制行之间挂载 `<AlarmLane onSeek={seek} />` |
| `.../i18n/en/appSettings.ts` + `i18n/zh/appSettings.ts` | 设置页文案 |
| `.../i18n/en/` + `i18n/zh/` 新增 `robotAlarms.ts`(并在 i18n index 注册 namespace) | 泳道/toast 文案 |
| `.../components/PlaybackControls/index.stories.tsx` | 为新增依赖补齐 PlayerSelection/AppConfiguration mock,至少覆盖“无告警不占位”和“有告警泳道” |
| 新文件 `.../alarms/mergeAlarmIntervals.test.ts` | §5 单测(仓库惯例:纯函数必测,参照 `serverExportBrowser.test.ts`) |
| 新文件 `.../hooks/useRobotAlarmConfiguration.test.tsx` | 验证未设置时使用默认值、保存空串后跨重挂载仍禁用 |
| 新文件 `.../alarms/fetchRobotStatus.test.ts`、`useRobotAlarms.test.tsx` | §13 的请求封装与状态机测试 |
| `packages/studio-web/src/webpackConfigs.ts`(2026-08-13 追加) | dev server 新增 `/robot-alarm-proxy/{host}/{port}/*` 动态代理,规避浏览器 CORS(§4.1 实施注记) |
| `desktop/src/main.ts`(2026-08-13 追加) | `webPreferences.webSecurity: false`,自用工具放行渲染进程跨域(§4.1 实施注记) |

依赖:不新增任何 npm 包(fetch、notistack、MUI 均现成)。

## 8. 时序、状态机与竞态

### 8.1 触发条件(决策 #6/#7)

`useRobotAlarms` 内部状态机:

```
输入: presence, playerState.playerId, activeData.startTime/endTime,
      selectedSource.type/id, host, port
派生: eligible = selectedSource.type === "file" &&
                   selectedSource.id === "ros1-local-bagfile"
      enabled  = host.trim() !== "" && port 是 1–65535 整数
      ready    = eligible && presence === PRESENT && 起止时间存在且 stopMs > startMs
      queryKey = {playerId, sourceType, sourceId, startMs, stopMs, normalizedHost, port}

idle ──ready && enabled──▶ loading ──成功──▶ success(records → intervals)
                          │
                          └──失败──▶ error(toast 一次;泳道不渲染)
queryKey 任一字段变化 / 禁用 / 组件卸载 → abort 在途请求,清空旧区间并重置;
新 key 准备好后只查询一次
```

- `startMs = toMillis(startTime, false)`(向下取整),`stopMs = toMillis(endTime, true)`(向上取整),
  形成覆盖完整 bag 边界的毫秒闭区间(决策 #12:墙钟同源);不得经 `toSec() * 1000` 做
  不必要的往返换算。
- `playerState.playerId` 是播放器实例的稳定标识;`activeData` 中不存在 `playerId`。切换/关闭
  数据源会更换 player 或取消资格;再配合 source type/id,旧数据不会串到新 bag。
- `eligible` 是硬门槛。不能只用 `startTime/endTime` 或 presence 推断文件类型,因为实时播放器
  同样可能持续提供这两个边界。
- 同一 `queryKey` 仅在首次满足 `ready && enabled` 时发一次请求。请求开始后,同一 player/key
  因正常读包或 seek 短暂进入 `BUFFERING` 时保持当前 loading/success 状态,不 abort、不重查。
- hook 在当前挂载生命周期内维护 `attemptedQueryKeys`;请求一经发起即登记。presence 波动或错误
  状态重置不得移除该 key,从而保证同一 key 不会被 effect 再次触发。
- 不对 `endTime` 做量化。首版仅支持边界固定的本地 ROS1 bag;若 source、player 或精确边界
  真正改变,必须形成新 key 并重新查询。

### 8.2 竞态与清理

- 每次发起查询新建 `AbortController`;queryKey 变化、功能禁用、组件卸载时 `abort()` 在途请求。
  presence 在同一 key 下从 `PRESENT` 短暂切到 `BUFFERING` 不属于清理条件。
- 首次到达 `PRESENT` 前的 `INITIALIZING` 只等待;已发起查询后若进入 `NOT_PRESENT` 或 `ERROR`,
  则 abort 在途请求并清空泳道,但不移除已登记的 attempted key。
- key 变化时同步清空旧 intervals;响应处理同时校验 controller 和本轮 generation/key。旧请求即使
  在 abort 竞态中返回,也不得 setState 或 toast。
- `fetchRobotStatus` 创建超时定时器后,必须在成功、失败、主动 abort 的 `finally` 中
  `clearTimeout`;用显式 `timedOut` 标记区分超时和主动中止。
- 用户切换/禁用/卸载导致的 abort **静默**;超时、网络错误、HTTP/业务校验失败才 toast。
- toast 去重(决策 #19):在 hook 生命周期内以规范化后的 `queryKey` 字符串记录已报错 key,
  同一 key 不重复 toast;切到新 key 可再次报告。正常播放器 `BUFFERING` 不得使去重记录失效。

### 8.3 失败文案(toast)

`告警查询失败:{原因}`,原因取 Error.message(如 `Failed to fetch` / `timeout` /
`HTTP 500` / `status_code 400`)。i18n key 放 `robotAlarms` namespace。

> 实施注记(2026-08-19):HTTP 非 2xx 时,错误信息附带截断至 200 字符的响应体;
> development 代理在目标不可达(ECONNREFUSED/ENOTFOUND 等)时返回 502 + 明文原因 body
> (`robot-alarm-proxy: cannot reach http://{host}:{port} ({错误码})`,见
> `webpackConfigs.ts` 的 `onError`),toast 直接可见 `HTTP 502: robot-alarm-proxy: cannot reach ...`,
> 便于排查配置错误与服务不可达。

toast 附"重试"按钮(决策 #21):点击后移除当前 key 的 attempted/toasted 登记并触发
effect 重跑,按同一查询键重新走一遍 loading → success/error;再次失败会再次 toast
(去重记录已被重试清除)。重试请求在途期间忽略按钮的重复点击,避免并发重发。

## 9. 边界情况清单

| 场景 | 行为 |
|------|------|
| 未配置/清空 host 或 port | 功能禁用:不请求、不渲染、不提示(决策 #17) |
| port 非法或持久化数据损坏 | 视为禁用;设置页显示校验错误,不请求、不 toast |
| 无数据源 / 首次进入 `PRESENT` 前 | 不渲染,不请求 |
| 非 `ros1-local-bagfile` 的文件、示例或实时连接 | 即使存在 start/endTime 也不请求(决策 #7) |
| 查询开始后同一 player/key 短暂 `BUFFERING` | 保持在途请求或已有结果,不 abort、不重查 |
| 合格数据源的起止时间缺失、非有限值或 `stopMs <= startMs` | 不请求、不渲染 |
| 查询中(loading) | 不渲染泳道(决策 #13) |
| 成功但 `data: []` / `data: null` 或全部无告警 | 不渲染泳道(决策 #13),弹绿色"没有告警"成功 toast(决策 #22) |
| 网络错误 / 超时 / HTTP 非 2xx / `status_code ≠ 200` / `data` 非数组(`null` 除外,决策 #22) | toast 报错一次(附"重试"按钮,决策 #21),泳道不渲染(决策 #11/#19) |
| 失败后点击 toast 的"重试" | 按同一查询键重新查询;再次失败再次 toast;在途期间重复点击被忽略(决策 #21) |
| 响应记录乱序 | 按 `time` 排序后处理(§4.4) |
| `alarm_message` 为空串 / 仅分号 / 缺失 | 视为无告警采样(§4.4) |
| 告警之间出现明确无告警采样 | 立即断开为两个区间,不应用缺采样容差(§5) |
| 某条 `time` 非数值、`NaN` 或无穷值 | 丢弃该条,继续处理其余 |
| 接口返回查询范围外的记录 | 丢弃,不得渲染或参与 tooltip(§4.4) |
| 多条记录时间相同 | 保持原相对顺序;0 差值不参与采样周期估计 |
| 采样中途丢数据(间隔 > `gapThresholdMs`) | 断开为两个区间(§5) |
| 告警持续到 bag 末尾 | 末区间 `endMs` 封顶 `stopMs`(§5) |
| 区间极短(<1 像素) | 最小宽度 2px 渲染(§6.1) |
| 快速连续打开多个 bag | 旧请求 abort;迟到响应由 generation/key 校验丢弃(§8.2) |
| 设置页修改地址 | 当前数据源立即按新地址重查(§6.5) |
| CORS 未配置 / HTTPS 混合内容被拦 | 仅生产 Web 部署仍可能发生(§4.1 实施注记):fetch 抛错 → toast;dev 环境与桌面端已由客户端规避 |

## 10. 配置项

| AppSetting key | 类型 | 默认 | 说明 |
|----------------|------|------|------|
| `robotAlarm.host` | string | `10.11.2.208` | 告警服务地址;空串 = 禁用 |
| `robotAlarm.port` | string | `50004` | 告警服务端口(1–65535);空串 = 禁用 |

默认值只用于底层 key 为 `undefined` 的情况;已持久化的空字符串不得回退到默认值。
路径 `/rbrainrobot/data/get_robot_status_list` 为常量,不开放配置(决策 #14)。

> 联动注记(2026-08-13 追加):`robotAlarm.host` 与「从服务器导出」(SSH) 连接表单的
> 主机共用同一份配置——SSH 连接成功后写回该 key,设置页修改后 SSH 表单预填跟随;
> **端口不联动**(SSH 默认 22,告警服务默认 50004,是机器人上两个不同的服务)。

## 11. i18n

- 英文 + 简体中文(决策 #20);英文为必需,zh 同步新增。
- `appSettings` namespace:`robotAlarmServer`(区块标题)、`robotAlarmHost`、
  `robotAlarmPort`、`robotAlarmServerDescription`(含"清空即禁用"说明)、
  `robotAlarmPortInvalid`。
- 新 `robotAlarms` namespace:`alarmQueryFailed`(带 `{reason}` 插值)、`retry`(重试按钮)、
  `noAlarms`(无告警成功 toast,决策 #22)。
- tooltip 字段表无文案(字段名英文原文,决策 #15);泳道无静态文案(决策 #13 无占位行)。

## 12. 风险与权衡(记录在案)

1. **CORS / 混合内容**:JSON POST 会触发预检,而服务端确认不支持 CORS 且不可修改
   (2026-08-13)。客户端规避已落地:(a) development 构建(`yarn web:serve`)把请求改写为
   同源路径 `/robot-alarm-proxy/{host}/{port}/...`,由 dev server 动态代理到真实服务;
   (b) 桌面端 Electron `webPreferences.webSecurity: false`(自用内网工具可接受,代价是
   窗口内跨域限制全部失效,不得加载不可信页面);(c) **生产 Web 部署到浏览器**仍需服务端
   实现 §4.1 契约或部署侧加反向代理,本仓库不做。HTTPS 页面 + HTTP 服务的混合内容拦截
   同理仅存在于生产 Web 部署,由部署侧规避,不应把生产页面降级为 HTTP。
2. **时钟同源假设**(决策 #12):bag 时间戳与告警服务同为 Unix 墙钟。机器人时钟漂移会导致
   告警区间整体偏移;访谈确认同源,不做偏移校正。若日后发现漂移,可在设置页加 ms 偏移项。
3. **泳道晚出现导致的一次性布局跳动**:异步查询使然,已被"无告警完全隐藏"的决策覆盖(§6.2)。
4. **服务端单次返回量级**:按几十分钟 bag 设计(决策 #16);若实际打开多小时 bag 导致响应
   过大/超时,后续再加请求分段,当前不做。
5. **告警码无码表**(决策 #3):用户需自行知晓码含义;日后若提供码表接口,仅需改 tooltip
   渲染层,数据层不受影响。

## 13. 测试要求

- **必需——区间纯函数**:`mergeAlarmIntervals` 覆盖空输入、全无告警、单条、相邻合并、
  超阈值断开、`告警 → 明确无告警 → 告警` 必须断开、乱序与重复时间、越界/非有限 time、
  输入不被修改、起止双端裁剪、裁剪后零长度丢弃、末区间封顶 `stopMs`,以及 `alarm_message` 的尾分号/空串/
  仅分号/缺失字段解析。
- **必需——请求封装**:`fetchRobotStatus` 用 mock fetch 覆盖请求 URL/body、HTTP 非 2xx、
  `status_code ≠ 200`、`data` 非数组、`data` 为 `null`(成功空数据,决策 #22)、成功空数组、
  外部 abort 透传、超时错误,并验证每条路径都清理 timeout;主动 abort 不 toast 由 hook 状态机测试覆盖。
- **必需——配置语义**:`useRobotAlarmConfiguration` 覆盖底层 `undefined` 使用默认值、保存合法值、
  保存空字符串后重挂载仍返回空串,以及外部 change listener 更新。
- **必需——状态机**:`useRobotAlarms` 覆盖仅 `ros1-local-bagfile` 有资格、首次 `PRESENT` 查询一次、
  同 key 的 `BUFFERING → PRESENT` 不 abort/不重查、queryKey 切换清空旧结果并 abort、迟到响应
  不写入新 player、禁用时无请求/无 toast、同 key 错误 toast 去重、失败 toast 的"重试"按钮
  按同一 key 重查(在途期间重复点击忽略、再次失败可再次 toast,决策 #21)、查询成功但无告警时
  弹绿色成功 toast 且有告警时不弹 toast(决策 #22)。
- **UI/Storybook**:更新 `PlaybackControls/index.stories.tsx` 所需 provider mock;至少保留一个无告警
  场景验证不占位,以及一个有告警场景验证红色区间、tooltip 最近采样和点击 seek。
- 代码须通过相关测试、`yarn lint:ci` 与 `yarn build:packages`。不要用会自动改写文件的
  `yarn lint`;同时遵守仓库规范:MPL 头、禁 `null`、`#private`、`setTimeout` 显式 delay、
  `console` 仅 warn/error/debug、禁 todo/fixme 注释。新增、修改的关键代码按项目要求添加
  多行简体中文注释,且不主动格式化无关代码。
