# BSide 林离复活项目 — 技术笔记

> 这份文档比 README 更细：实现了什么、根因在哪、踩过哪些坑。
> §7 列了**已排除的假设**，动手前先读，别重复走。

---

## 0. 现状

**游戏内信箱已打通并实机确认**：信箱页正常显示未读数与三封信（含她引用上一封细节的回信正文），
左下角「给林离写信」按钮可用。

- **DSH 侧**：完全打通（写信 → agent 生成回信 → 会话记忆跨信连续）。
- **游戏侧**：`feapp.dat` 共 **9 个补丁**，`tools/verify-patches.ps1` **全项 PASS**。
  关键是 **7**（`N3=!1`→`N3=!0`，解除写信按钮的离线门控）、**8**（补回主页↔信箱导航）、
  **9**（写信按钮不受额度影响）；桥侧 `maxDailyLetters` 已放到 1000000。
- ⚠️ 早期有一版判断是错的（见 §7.7）：信箱页面**根本没有被删**。

---

## 1. 目标

让《BSide: Olivia Lin》离线版客户端恢复「写信 / 收信」，并且**由 DSH 的持久 agent 会话充当林离的大脑**——
她会记得之前每一封信。这是这个方案区别于社区其他实现的核心。

---

## 2. 环境

| 项 | 位置 |
|---|---|
| 游戏本体 | Steam 库下的 `BSide Olivia Lin Test`，版本 `0.0.9.627` |
| 前端包 | `<游戏>\0.0.9.627\resources\feapp.dat`（**标准 ZIP**，27.7 MB） |
| 原版备份 | `<游戏>\0.0.9.627\resources\feapp.dat.orig-backup` |
| 插件 | 本仓库（装进 profile 后是 junction + bundle 条目） |
| 桥日志 | `<DSH_HOME>\olivia-bridge\bridge.log` |
| 信件库 | `<DSH_HOME>\olivia-bridge\letters.json` |
| 客户端日志 | `%LOCALAPPDATA%\Temp\Olivia.log` |
| 她那个会话 | `<DSH_HOME>\sessions\<工作区转义名>\olivia-letterbox\session.v4.jsonl.zstd` |
| profile 备份 | `<DSH_HOME>\profiles\desktop\*.bak-olivia-<时间戳>` |

`<DSH_HOME>` 默认是 `%USERPROFILE%\.dsh`。开发环境为 DSH 桌面端 `0.2.0-rc.2`，profile = `desktop`。

---

## 3. DSH 侧

### 3.1 桥做什么

在 `127.0.0.1:8791` 起独立 HTTP 服务，冒充客户端原本要连的官方后端，实现契约里 33 个端点的关键部分
（`/toy/letter/*`、`/toy/signIn`、`/toy/getUserInfo`、`/toy/getMusicTypeInfo` 等），
把每封来信投进一个持久 DSH agent 会话。

关键代码：

- `lib/index.js` — HTTP 契约层 + 路由
- `lib/agent-bridge.js` — agent 会话桥（建会话、投递、取回复）
- `lib/store.js` — 信件存储（时间戳为**秒**，与客户端一致）
- `lib/persona.js` — 林离人格（preset 未生效时的兜底）

### 3.2 实测结果

用 `node tools/verify.mjs` 发信，两封信均成功。

第一封（20 秒回信）：

> 嗯，这雨从早上就没真正停过，是那种下得很小、却能把整条街泡软的类型。下午有个学生来上课，伞尖一路滴水滴到琴房门口……

第二封（引用她上一封的细节追问「学生踏板踩得像在赌气，好点了吗」）：

> 诶，你记得倒比我清楚。不过得先把话摆平：她一周只来一次课，周二下午……师傅还没约上。这会儿都过了半夜，总不能打电话把人从床上叫起来……

**第二封明确引用了第一封的内容 → 会话记忆有效。**

### 3.3 编程建 agent 会话的七个硬要求（全部踩过，务必照做）

1. **消息必须带 `id`**（`UserMessage.id` 是 readonly 必需字段；官方 `createMessage` 用 `brandString(randomUUID())`）——缺了 inbox 会**静默丢弃**。
2. **`source.kind` 不能是笼统的 `"plugin"`**——v4 会话格式硬拒（见 `dsh-session-format-v3-to-v4` 的 `source()` 校验），合法形状是 `plugin:<插件名>`。`dsh-agent` README 里的 `{kind:'plugin',plugin:'x'}` 是**过时的 v3 写法**。
3. 消息进 inbox 前需 `deepFreeze`（官方是 `deepFreeze(structuredClone(...))`）。
4. **`agentOptions` 必须给 provider/model**，空着时会话建得出来但 turn 立刻空转、会话日志**零事件**。用 `ctx.agentDefaultModel.currentSelection()` 兜底。
5. **`followup()` 之后不能立刻 `whenIdle()`**——它只排队 + 异步唤醒驱动器，紧接着调用会在 agent 还没醒时返回（实测 146~174ms）。要先轮询等 assistant 消息落地。
6. `ctx.agentPresets.resolve()` 按 preset 的 **`config.id`** 索引（行 id 惯例是 `preset-<config.id>`）。
7. **固定 sessionId + `agents.resume()`** 才能跨 DSH 重启保住记忆。

官方范例：`<全局 dsh 安装>\node_modules\@deepseek-ai\dsh-webhook\lib\index.js`。

### 3.4 排错端点（桥自带，非游戏契约）

| 端点 | 作用 |
|---|---|
| `GET /olivia/diag` | preset 是否解析、会话消息数、inbox、phase |
| `POST /olivia/agent-test` | 让 agent 真跑一轮并回报前后快照 |
| `POST /olivia/llm-test` | **直接打一次 LLM，返回底层真实错误 + 整条 cause 链** |
| `POST /olivia/retry` | 重投某封失败的信 |
| `GET /olivia/*`（其他） | 探针上报入口（见第 6 节） |

`/olivia/llm-test` 默认按 **agent 路线**复现：`tools` / `reasoningEffort` / `maxTokens` 取自她那个
会话最近一次 request header（这三样正是 agent 路径与裸调用唯一的差别 —— 实测同一
provider/model 下裸调成功、agent 路径必失败）。body 可带：

```jsonc
{ "text": "ping" }           // 默认：带 tools + reasoningEffort 复现 agent 路线
{ "text": "ping", "plain": true }   // 对照：只发 provider/model（旧行为）
{ "plain": true, "reasoningEffort": "high" }  // 单变量：只加某一样
```

返回里的 `errorChain` 是沿 `cause` 展开的错误链（最多 6 层）——
`TRANSPORT` 这句话的真因永远在第 2 层往后，第一层只有那句误导人的
"DeepSeek Messages transport failed"。

---

## 4. 游戏侧补丁

脚本：`tools/patch-feapp.ps1`
**幂等**：每次运行都先从 `feapp.dat.orig-backup` 还原再重打，反复运行结果一致。

| # | 补丁点 | 目的 | 状态 |
|---|---|---|---|
| 1 | `jl=(e,t)=>{Te.defaults.baseURL=e,...}` → 钉死本地 | axios 工厂设地址 | 保留（双保险） |
| 2 | `N=j(()=>d.value.offlineMode===!0)` → `N=j(()=>!1)` | 关掉离线门禁（否则请求拦截器首行直接 throw） | **有效** |
| 3 | `setClientConfig` 里强制 `offlineMode=false` + `toyApiUrl` + **`appInfo.Channel="demo"`** | 绕过米哈游账号登录 | **关键，有效** |
| 4 | `baseURL:"",timeout:1e4` → `baseURL:"http://127.0.0.1:8791/toy",timeout:1e4` | 实例创建时钉死地址（不依赖原生层下发配置） | **关键，有效** |
| 5 | 往 `index.html` 注入探针 + 请求改写器 | 观测 + 兜底改写 | 有效（**必须插在 `</head>` 之前**，见 §7.6 黑屏教训） |
| 6 | `m` 函数改成主动调 `Z.toggleLetterEntry({new_status:!0})` | 通知原生层显示入口 | **无效**（原生层不认，见 §5.7） |
| 7 | `N3=!1,Ss=!1,wa=({onComplete` → `N3=!0,Ss=!1,wa=({onComplete` | **解除信箱页「写信」按钮的离线门控** | **已实机确认** |
| 8 | App 模板里 `w-0 ... pointer-events-none` 的空锚点 → 两个 36px 可点按钮（调 `window.__oliviaNav`） | 恢复主页 ↔ 信箱双向导航（原来进去出不来） | **已实机确认** |
| 9 | `disabled:a.remainingCount<=0` → `disabled:!1`；额度文案 → 「本地接入 · 不限封数」 | 写信按钮不受额度影响 | **已实机确认** |

---

## 5. 关键逆向发现（都有实测证据）

### 5.1 前端结构

- `feapp.dat` 是标准 ZIP，内含 `index.html` + `assets/*.js`（Vite 构建的 Vue 3 SPA）。
- 主 bundle：`assets/main-<hash>.js`（约 376 KB，压缩过的单行 JS）。
- 客户端是 Qt + CEF，前端跑在 CEF 里。

### 5.2 接口地址的注入链

```js
// 1. axios 实例，baseURL 初始为空
const Te = ml.create({ baseURL: "", timeout: 1e4, withCredentials: true, ... })

// 2. 工厂函数
jl = (e, t) => { Te.defaults.baseURL = e; Object.entries(t).forEach(...) }

// 3. setClientConfig 里设置
$ = J => { d.value = J; d.value.appConf.toyApiUrl && jl(d.value.appConf.toyApiUrl + "/toy", d.value.apiHeaders); ... }
```

**关键**：离线版的 `conf.app.dat` 里**没有 `appConfig` 段**（官方停服时删了在线配置），
所以 `toyApiUrl` 为空 → 第 3 步整段短路 → `jl()` 从不执行。这就是补丁 4 必须存在的原因。

客户端日志证据（`%LOCALAPPDATA%\Temp\Olivia.log`）：

```
[ConfigManager::initialize] Local config data section appConfig[object] not found
[AppConfig.h] Failed to convert json value to [Model.toyApiUrl]: out of range
（region / toyWsUrl / globalGatewayUrl / signSalt / trackingUrl / otelService / webAccountHost / passportUrl 同样报错）
```

### 5.3 离线门禁

```js
// 请求拦截器首行
Te.interceptors.request.use(e => { const t = Ie(); if (t.isOfflineMode) throw new Ol(e); ... })
// isOfflineMode = computed(() => clientConfig.offlineMode === true)
```

为 true 时**所有 HTTP 请求直接抛异常**，且 `mailWidget` / `musicWidget` 被强制置 false。

### 5.4 登录流程（曾导致「登录态校验失败」）

```js
// LoginView setup
((y = d.value?.appInfo)?.Channel) === "steam" && await s.handleMhyLogin()
```

**只有 `Channel === "steam"` 才走米哈游账号 SDK 登录**。离线版 `Channel` 仍是 `steam`，
于是客户端一启动就打已停服的 `passport-api.mihoyo.com`，SDK 抛 `Network Error`，
`onMounted` 中断，连 `getUserInfo` 都发不出去。

补丁 3 把它钉成 `"demo"` 后，客户端**成功进入主界面**，右上角显示 `UID: linli-local`（桥返回的 uid）。

### 5.5 信箱：有组件、有枚举、**没有路由** ⚠️

前端路由枚举里**有**它：

```js
e.MailBox = "mailbox"    // ve 枚举
```

信件 UI 组件**全都在包里**：
`MailBoxHeader`、`MailBoxItem`、`MailBoxList`、`MailBoxFooter`、`MailBoxSidebar`、`MailBoxWriteDialog`

**但实际注册的路由表里没有它**（探针 `/olivia/routes` 实测，共 15 条）：

```
/studio/playsing-list|playsing-list     /studio|studio        /studio|home
/studio/instrumental-list|instrumental-list   /collection|collection
/studio/solo-list|solo-list             /history|history      /share|share
/login|login   /survey|survey   /settings|settings   /feedback|feedback
/mode-select|mode-select   /user-info|user-info   /studio/:pathMatch(.*)*|studio-not-found
```

侧边栏列表里也没有它：

```js
v_ = [ve.Home, ve.Studio, ve.StudioLite, ve.Settings, ve.Collection]
```

**注意**：这里的「没有 mailbox 路由」曾把人带偏过，见 §6.1 与 §7.7——
页面其实是 `/collection`，枚举 `ve.MailBox` 是死代码。

### 5.6 原生层 bridge（`window.ToyPianistClient`）

实测探针确认 `hasToyClient: "object"`、`hasCefQuery: "function"`（bridge 对象存在）。

信件相关事件：

```js
toggleLetterEntry(e)      // 前端 → 原生：切换信件入口显示
letterPageOpen()          // 前端 → 原生：信件页面打开
letterPageExit()          // 前端 → 原生：信件页面关闭
letterSend({letter_content})
letterClear()
letterSendInitResult / letterReplyResult / letterReplyOpen / letterReplyClose / letterReplyVideoError
```

`MailBoxWriteDialog` 里：

```js
_e(() => a.modelValue, (d, h) => { d ? Z.letterPageOpen() : h && Z.letterPageExit() })
```

### 5.7 设置项 `mailWidget`

```js
l = b({ ..., mailWidget: !0, musicWidget: !0, ... })   // 默认值就是 true

const m = () => { e.isOfflineMode && (l.value.mailWidget = !1, l.value.musicWidget = !1) };
_e([() => e.isOfflineMode, () => l.value.mailWidget, () => l.value.musicWidget], m);
_e(l, p => { ... "mailWidget" in d && Z.toggleLetterEntry({new_status: d.mailWidget}) ... }, {deep:!0});
return _e(...), m(), { settingsData: l, ... }    // m() 初始化时被显式调用
```

**注意**：`toggleLetterEntry` **只在值变化时**才被调用；初始值本来就是 `true` 且没人改过 →
原生层**从未收到过通知**。

补丁 6 改成主动调用 `Z.toggleLetterEntry({new_status:!0})` 后，探针确认执行
（`patch6-fired?mw=true&off=false`），**但界面毫无反应 → 原生层不认这个 bridge 事件**。

---

## 6. 根因（已定位，代码级确定）

**信箱页面一直都在，缺的只是「写信」按钮。**

### 6.1 完整因果链（每一环都有字节偏移证据）

1. `appMode` 默认就是 `Se.LITE`：`Ie=st("user",()=>{… no("appMode",Se.LITE) …})`（@72689），
   离线会话 `startOfflineSession` 里还有一句显式 `s.appMode=Se.LITE`（@131171）。
2. `/collection` 路由的组件是 `CollectionDynamicView`：

   ```js
   Ub=le({name:"CollectionDynamicView",setup(){const{appMode:e}=de(Ie());
     return()=>mo(e.value===Se.PRO?Rb:f5)}})   // Rb=CollectionView, f5=MailBoxView
   ```

   → **LITE 下 `/collection` 就是信箱页**（标题「我的信箱」，i18n 变量 `Gs`）。
3. ⚠️ **踩过的坑（别再犯）**：App 模板里的 `#tour-studio` / `#tour-collection`（@167519）
   看着像侧边栏，但父容器是 `w-0 ... pointer-events-none` —— 那是**给新手引导用的、
   宽 0 且不接收鼠标事件**的空锚点，用户根本点不到。当时只凭 tour 配置就推断
   「那就是信箱入口」，实测证明是错的。补丁 8 已把它改造成真的 36px 按钮。
4. 信箱页把写信按钮的可见性交给 `MailBoxSidebar` 的 `hideWrite` prop：

   ```js
   k(V4,{"hide-write":o(p)||!o(N3),…})                    // p = isOfflineMode
   // MailBoxSidebar 内：m.hideWrite ? Y("",!0) : F(U4,{…})  // U4 = MailBoxFooter（含写信按钮）
   ```

5. `p` 已被补丁 2 干掉（探针实测 `off=false`），但 **`N3` 是 `N3=!1,Ss=!1` 这个硬编码常量，
   全文件只出现两次**（定义 + 这一处使用），离线版没有任何代码把它置真
   → `hideWrite = false || !false = true` → **写信按钮根本不渲染**。

**修复 = 一行**：`N3=!1` → `N3=!0`（补丁 7）。

### 6.2 已实机确认：`appMode = lite`

探针 `/olivia/ui-state` 实测 `"mode":"lite"`，所以 `/collection` 渲染的就是 `MailBoxView`。

**Plan B（未打，仅备用）**：把 `CollectionDynamicView` 里的 `e.value===Se.PRO?Rb:f5`
整体替换成 `f5`，让 `/collection` 恒为信箱页 —— 只有将来有人用
`DebugSettingDialog`（@162281）把 appMode 切到 `pro` 时才需要。

### 6.3 社区对照（两个独立实现都指向同一行）

- **Comma0103/Linli-Nocturne** `src/patcher/frontend-archive.js` 的 `OFFLINE_FEATURE_PATCHES`
  第一条：`{id:'mailbox-entry', from:'N3=!1,Ss=!1,wa=({onComplete', to:'N3=!0,…'}` —— 同一个 `N3`。
- **AETAVK/linli-local-mail** `tools/feapp.mjs` 直接替换
  `"hide-write":o(p)||!o(N3)` → `"hide-write":!1`，注释原文：
  「.627 客户端在停止在线服务后把写信入口绑定到恒为 false 的 N3」。
- Nocturne 另外还改了两个**原生 DLL**（`plugins/Studio/NutStudioUI.dll` 的 4 处
  `mail-widget-check`、`plugins/Container/NutContainerPlugin.dll` 的 1 处 `lite-bar-check`，
  见其 `src/patcher/native-feature-patch.js`），那些管的是**桌面浮标 / 音乐 widget**；
  **本次「写信」链路不需要它们**。这 5 处签名在 `0.0.9.627` 的 DLL 上已验证同样唯一命中，留作后用。

### 6.4 桥侧额度

`lib/index.js` 的 `DEFAULTS.maxDailyLetters` 原为 20（= 契约里 `remainingToday` 的来源，
也是 `POST /toy/letter/send` 满额返回 429 的判据），已改为 **1000000**。
`cordis.patch.yml` 没有覆盖这个字段，所以走默认值。
⚠️ 桥是 DSH 插件，**改完必须重启 DSH** 才生效。

### 6.5 响应形状契约（防止「骨架屏转圈」复发）

**症状**：曲库页骨架屏永远转圈，界面卡住不动。

**真因**：前端主脚本有 33 个接口调用点，其中很多直接对 `data` 里的数组调方法。
桥漏字段就抛 TypeError → Promise 被拒 → 调用方的 `loading` 永不复位。
已经炸过三次：

| 端点 | 前端消费点 | 缺什么 |
|---|---|---|
| `/getMusicTypeInfo` | `q.musicStyles[0].type`、`performanceModes.map(...)` | 缺 `musicStyles`；**空数组也炸**（要取 `[0]`） |
| `/getSongStats` | `(await rm()).items.filter(...)` | 缺 `items`（原来混在空列表信封里） |
| `/searchPerformances` | `s.data.list.map(...)` | 不在 `emptyListPaths` 里 → 走兜底 `{}` → 崩 |

**修法**：不再逐个端点打补丁（那正是补丁循环的来源）：

- `/getMusicTypeInfo`、`/getSongStats` 各自专用返回；
- `emptyListPaths` 与**兜底**共用 `emptyEnvelope()`，字段取并集
  （`list / items / results / questions / performanceList / musicStyles /
  performanceModes / total / hasMore / nextCursor`），前端取哪个字段都不会是 `undefined`。

**验收**：`node test/response-shape.test.mjs` —— 12 项断言，覆盖所有前端会做数组
操作的端点 + 兜底信封形状。以后新增接口漏字段，会先在这里变红。

⚠️ **改完必须重启 DSH**：桥是 DSH 插件，源码改了不重启，进程里跑的还是旧代码。
2026-10-07 那次「改了好几轮都没效果」就是这个原因 —— 磁盘源码早已修好，
`/toy/getMusicTypeInfo` 实测仍然只返回 `{"performanceModes":[]}`。

### 6.6 自带曲目为什么出不来（**已查清，不是补丁问题**）

「自带曲目」来自官方的离线曲库 `oe`（offlineCatalog store，@118612）：

```
Xm = () => We({action:"getOfflineSongList", data:{}})   // 原生 CEF 查询，不走 HTTP
Yn = st("offlineCatalog", () => { ... load() 里 await Xm() ... })
```

三条**独立**的堵点，缺一不可：

| 环节 | 实测结果 |
|---|---|
| `getOfflineSongList`（原生给清单） | **不回应** —— `We` 的 Promise 永远 pending（`catalog-loaded` 从未出现） |
| `songlist.dat`（1.16 MB） | **全是密文**，无任何可读字段，前端靠 `ys()` 解密，外部解不开 |
| 曲目媒体文件 | **本地没有** —— 游戏目录只有 `Wallpaper_Ambience` 的 22 个 mp3 + 36 个 mp4 待机视频 |

而且显示逻辑本身还带一层 `.filter(q => f.isDownloaded(q.id))` —— **只显示已下载的**。
官方那 129 首要联网下载，停服后没有下载入口。

**结论：在这个本地环境下「自带曲目」不可能出现**，继续在这上面使劲是白费。
让用户上传自己的 MIDI 才是能走通的路，桥侧已经实现，见 §12。

---

## 7. 已排除的假设（**别重复走**）

1. ~~改 axios baseURL 就能通~~ —— 有效但不是入口问题；且必须落在**实例创建时**（补丁 4），`jl()` 那条路因原生配置缺失而短路。
2. ~~`mailWidget` 被离线门禁关掉了~~ —— 默认值就是 `true`，实测 `patch6-fired?mw=true`。
3. ~~watch 没 immediate 所以没触发~~ —— `m()` 在 store 初始化时被显式调用过，不是这个问题。
4. ~~信箱路由存在，驱动 router 跳过去就行~~ —— **路由表里确实没有名为 mailbox 的路由**，但页面在 `/collection`（见 §7.7）。
5. ~~代理干扰~~ —— `ProxyOverride` 含 `127.*` 与 `<local>`，本地回环不走代理；官方域名请求失败是因为服务器已停服，与代理无关。
6. ~~注入脚本要放在 `<head>` 紧跟之后~~ —— **会导致全黑屏**：`<meta charset>` 只在文档前 1024 字节内有效，注入内容把它推出窗口后浏览器按错误编码解析整页。**必须插在 `</head>` 之前**，且注入内容保持纯 ASCII。
7. ~~信箱路由被官方删掉了，只能靠原生层唤起~~ —— **错的，这是早期最大的误判**。
   `/collection` 在 LITE 下渲染的就是 `MailBoxView`（§6.1），信箱页从未被删。
   当时探针只检查路由表里有没有**名字叫 `mailbox`** 的条目，就把「找不到 mailbox 路由」
   当成了「进不去」。`ve.MailBox="mailbox"` 这个枚举本身确实是死代码（全文只出现 1 次、
   无人引用），正是它把排查方向带偏的。
   **教训：路由名 ≠ 页面可达性，别拿枚举残余下结论。**

---

## 8. 下一步可能的方向

### A. 分析原生层

- `0.0.9.627\NutApp.dll`（1.1 MB）、`Olivia.exe`（576 KB）、`0.0.9.627\CefView\Olivia.exe`（CEF 宿主）
- 找 `toggleLetterEntry` / `mailWidget` / `is_letter_enabled` 等字符串，看原生层怎么决定入口显示
- 注意：oliviaproxy 的文档提到 **NutApp.dll 有完整性校验**（未证实），改 DLL 前先备份

### B. 解 `conf.app.dat`（768 字节，加密）

- 原生层从这里读 `pluginConfig`（日志确认 `pluginConfig[object] found`）
- 如果里面有 `mailWidget` / `isLetterEnabled` 之类的开关，改它可能直接生效
- 未知加密方式，需要逆向 `ConfigManager`

### C. 自己实现写信界面（绕开游戏，成功率最高）

既然桥已经完全可用，可以完全脱离游戏客户端做交互界面：

- 复用 `MailBoxWriteDialog` 的视觉素材（`feapp.dat` 里有全部 webp/mp4 资产）
- 或者干脆在 DSH 里做一个客户端 UI 插件，当作「林离的信箱」
- 信件数据、记忆、人格都已就绪，只是换一个前端壳
- **这条路不依赖任何逆向突破**

---

## 9. 工具清单

| 文件 | 作用 |
|---|---|
| `tools/install-desktop.ps1` | 装/卸 DSH profile 里的插件与 preset |
| `tools/patch-feapp.ps1` | 打补丁（幂等）/ `-Restore` 一键还原 |
| `tools/verify-patches.ps1` | **只读**校验全部锚点的落地状态 + 探针是否注入（全绿才算补丁到位） |
| `tools/inject.js` | 注入到 index.html 的探针（XHR/fetch 记录、JS 错误捕获、路由表上报） |
| `tools/verify.mjs` | 端到端验证：发信 → 等回信 |
| `tools/diagnose.mjs` | 桥的静态诊断 + 让 agent 跑一轮 |
| `tools/dump-session.mjs` | 解压查看她的会话事件（zstd JSONL） |
| `tools/decode-probes.mjs` | 解码 bridge.log 里的探针记录 |
| `test/contract.test.mjs` | 契约层自测（mock ctx 起服务打接口；**用独立 DSH_HOME 临时目录**，不会碰真实信件） |
| `test/response-shape.test.mjs` | **响应形状契约测试**：前端会做数组操作的端点字段是否齐全 + 兜底信封（12 项） |
| `test/midi-flow.test.mjs` | **定制演奏链路端到端测试**：上传 → 生成（首答必须 state=1）→ 轮询 → 我的上传 → WAV/Range |
| `test/validate-profile-yaml.mjs` | 校验 profile YAML 合法性 |

---

## 10. 还原方法

```powershell
# 游戏文件还原原版
.\tools\patch-feapp.ps1 -Restore

# 从 DSH 卸载插件
.\tools\install-desktop.ps1 -Uninstall
# 再按 <DSH_HOME>\profiles\desktop\*.bak-olivia-<时间戳> 恢复
# package.json 与 cordis.patch.yml，然后重启 DSH
```

---

## 11. 观测命令速查

```powershell
$dsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }

# 桥日志（每次请求、每封信耗时、探针上报都在这里）
Get-Content "$dsh\olivia-bridge\bridge.log" -Tail 40

# 只读校验全部前端补丁是否落地（全项 PASS 才算补丁到位）
.\tools\verify-patches.ps1

# 看界面状态探针：route / appMode / 写信按钮数量 / 当前页面文字
Select-String -Path "$dsh\olivia-bridge\bridge.log" -Pattern 'ui-state|xhr' | Select-Object -Last 8

# 解码探针，看前端在请求什么
node .\tools\decode-probes.mjs

# 客户端日志
Get-Content "$env:LOCALAPPDATA\Temp\Olivia.log" -Tail 20

# 确认桥活着
Invoke-RestMethod http://127.0.0.1:8791/toy/letter/unread_count

# 让 agent 跑一轮（验证 DSH 侧是否正常）
Invoke-RestMethod -Method Post http://127.0.0.1:8791/olivia/agent-test
```

**注意**：桥只在 DSH 运行时存在。DSH 没开的话，游戏客户端所有请求都会失败。

---

## 12. 「定制演奏」链路（MIDI 上传 → 生成 → 我的上传）

**状态：桥侧已实现，三组测试全绿；前端一行没改；播放待实机确认。**

### 12.1 契约（全部来自 feapp 主脚本实测，含偏移）

| 端点 | 请求 | 响应 | 关键点 |
|---|---|---|---|
| `POST /toy/genObjectUploadUrl` | `{filename,type}`（`Zt.MIDI=12`） | `{url,key,headers}` | 客户端随后 `xhr.open("PUT", url)` + 逐个 `setRequestHeader(headers)` + `send(File)`（@77742） |
| `PUT /toy/midi/upload/<key>` | 原始 MIDI 字节 | — | 桥新增的地址；`key` 由上一个接口发 |
| `POST /toy/midi/generate` | `{midi_url}` | `{jobId,state:…}` | **首答必须是 `state:1`（排队）**，直接回完成前端不会开始轮询 |
| `GET /toy/midi/getGenerateResult?job_id=` | — | `{jobId,state,info:{audioUrl,videoUrls[]}}` | 前端只在 `state===3 && info.videoUrls.length` 时判完成（@163160） |
| `GET /toy/midi/listJobs` / `batchGetResult` / `cancelGenerate` / `deleteJob` | — | — | batch 的 `job_ids` 是**重复 query key** |
| `GET /toy/searchUserSongs?page_size=&cursor=` | — | `{list:[{userSongId,…}]}` | 列表项必须带 `userSongId`（前端拿它当 `id`） |
| `GET /toy/midi/media/<jobId>.wav` | — | WAV 字节 | 支持单段 Range |

状态枚举（feapp `De`，@4538）：`Pending=1, Running=2, Finished=3, Canceled=4, Failed=5`。
轮询间隔 30 s（`lite` 任务列表也是 30 s）。

### 12.2 实现

- **`lib/midi.js`** —— MIDI 解析 + WAV 合成 + 任务存储，**纯 JS 零依赖**。
  解析与合成移植自 Comma0103/Linli-Nocturne 的 `midi-manifest.js` / `audio-renderer.js`（MIT）。
- **`lib/index.js`** —— 11 个路由接入。**这 3 个端点已从 `emptyListPaths` 移出**：
  `/midi/listJobs`、`/midi/batchGetResult`、`/searchUserSongs`。
- 存储：`<DSH_HOME>\olivia-bridge\midi\`（`jobs.json` + `<key>.mid` + `<jobId>.wav`）。
- 渲染放在 `setImmediate` 里跑，免得一首几分钟的曲子把 HTTP 请求拖住。

### 12.3 两条媒体 URL 各走各的（WAV 试听 / MP4 演奏）

实测结论（2026-10-07 用户实机确认）：

| 用途 | 走哪条 | 结果 |
|---|---|---|
| **试听** | 前端自己的音频组件 `AudioWaveform` ← `info.audioUrl` | **WAV 能直接播，不用 ffmpeg** |
| **演奏** | 原生 WebPlayer（`<video>` 元素）← `info.videoUrls[0]` | **只认视频容器，WAV 播不了** |

所以桥现在同时产出两份：`<jobId>.wav`（试听）+ `<jobId>.mp4`（音频-only，演奏）。
`audioUrl` → WAV，`videoUrl` / `videoByTodView` / `videoUrls[0]` → MP4（没有 MP4 时回落到 WAV）。

**ffmpeg 的发现顺序**（`lib/midi.js` 的 `resolveFfmpeg`，**不硬编码任何路径**）：

1. 配置项 `ffmpegPath`（profile 的 `cordis.patch.yml`）
2. 环境变量 `OLIVIA_FFMPEG`
3. **`<DSH_HOME>\olivia-bridge\ffmpeg\ffmpeg.exe`** ← 本机用的就是这个，零配置
4. `PATH` 里的 `ffmpeg`

**没找到 ffmpeg 时优雅降级**：任务照样完成、试听照常，只是演奏拿到 WAV（不出声），
日志里会写明。刻意**不**在启动时跑一次探测转换（那会拖慢 DSH 启动）。

**踩过的坑**：随手拿现成的 ffmpeg 多半不行 ——

- 有些是**精简构建，脱离原目录就失效**（依赖同目录 DLL，复制到别处连 `-version` 都跑不起来）
- 随别的软件附带的那些常常**没有 AAC 编码器**
- 最后用的是完整静态构建（100.5 MB，gyan.dev essentials，v9.0.2），复制到桥数据目录就能用

**判断一个 ffmpeg 能不能用**：`ffmpeg -encoders` 里有 `aac`、`-muxers` 里有 `mp4`，
**并且真的转一次** —— 光看文件存在不算数（上面那个 462 KB 的精简构建就是反例）。

### 12.4 验证

```powershell
node .\test\midi-flow.test.mjs        # 上传→生成→轮询→列表→媒体（Range/CORS/MP4/歌单）
node .\test\response-shape.test.mjs   # 全部端点的响应形状
```

`midi-flow` 会自动探测本机 ffmpeg：找到就验 MP4 那两条断言，找不到就打 SKIP
（只验 WAV 降级路径）。

⚠️ 桥改了**必须重启 DSH** 才生效（见 §6.5 的教训）。

### 12.5 踩过的坑：CORS 漏了 PUT（**同类问题必查**）

**症状**：游戏里点上传 → 「上传失败」。前端探针记到了 `PUT /toy/midi/upload/<key>`，
**而桥日志里一条 PUT 都没有** —— 请求在离开浏览器之前就被拦下了。

**根因**：`applyCors` 里

```js
res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");   // ← 没有 PUT
```

上传是 `PUT` + `content-type: application/octet-stream`，属于**非简单请求**，
浏览器必须先发预检 `OPTIONS`；允许方法列表里没有 PUT，预检就算失败，实际请求根本不发。
（桥的 `OPTIONS` 处理在 `handle` 开头直接 `return`，**不写日志**，所以从日志看不出来。）

**为什么我最初没发现**：我自己的端到端验证用的是 `Invoke-WebRequest` / node `fetch`，
**两者都不走 CORS**，所以一路绿灯，把这个致命问题完全掩盖了。

**修复与加固**：
- `Allow-Methods` → `GET,POST,PUT,OPTIONS`
- 补 `Access-Control-Expose-Headers: content-range,content-length,accept-ranges`
  （播放器读 Range 分片要用）
- `Allow-Headers` 默认值里加上 `range`
- `MAX_BODY_BYTES` 1MB → 8MB（前端界面写「<1MB」，但请求体还会带边界）
- **`test/midi-flow.test.mjs` 里加了 CORS 预检断言** —— 这条必须留着，
  否则同类问题还会再漏一次

**教训：凡是浏览器要跨域发的方法（PUT/DELETE/PATCH）和自定义头，光在命令行测通不算数，
必须在 `Access-Control-Allow-Methods` / `-Headers` 里声明，并写一条预检断言。**

### 12.6 歌单（「加播单」/「音乐桌面」）

三个端点，`lib/playlist.js` + 本地 `playlist.json`：

```
POST /toy/addToPlaylist   {item_type, item_id} -> 回显完整条目（幂等）
POST /toy/delFromPlaylist {item_type, item_id}
GET  /toy/searchPlaylist  ?cursor=&page_size=  -> {list,total,hasMore,nextCursor}
```

**返回体必须字段齐全**，两个已实机踩到的坑：

1. **`itemType` 决定列表项的 `id`**。前端的映射是
   ```js
   ee = q => q.itemType === pt.PGC_SONG ? q.songId : q.id
   tt = q => ({ id: ee(q), name: q.name, ... })
   ```
   早期这里走空信封（没有 `itemType`/`itemId`）→ `id: undefined` →
   **第二条加进去被判成重复，只能加一个**。
2. **`createdAt` 必须是 Unix 秒**。给毫秒或 ISO 字符串，音乐桌面那条就是 `Invalid Date`。

另外条目要带 `videoUrl`（否则音乐桌面里点演奏没有媒体源）——
加播单时由 `songMetaFor()` 从 `midiStore` 把曲目元数据补齐（名字/媒体/时长）。

**验收**（已写进 `midi-flow.test.mjs` 第 9 步）：加 → 重复加不产生重复项 →
列表项带 `itemType` → 删。其中 `createdAt < 1e12` 这条断言专门盯住「秒 vs 毫秒」。
