# dsh-olivia-bridge

把《BSide: Olivia Lin》（米哈游「林离」）的客户端接到 DSH 上——游戏里写的信，由 DSH 的一个 agent 会话来回。

## 它做什么

官方服务器 2026-08-31 关停后，客户端只剩本地演奏和壁纸。这个插件在回环地址上起一个 HTTP 服务，冒充客户端原本要连的后端，然后把每封来信投进一个持久的 DSH agent 会话；她的回信写回本地信件库，客户端照常显示。

```
Olivia.exe 0.0.9.627
   │  POST /toy/letter/send · GET /toy/letter/list|detail|unread_count
   ▼
dsh-olivia-bridge   127.0.0.1:8791
   │  信件存储 <DSH_HOME>\olivia-bridge\letters.json
   ▼
DSH agent 会话（preset: 林离）
   │  ctx.agents.create → followup → whenIdle
   ▼
会话历史即她的记忆：每封信都进同一个 session，不需要额外的记忆库
```

会话 id 固定为 `olivia-letterbox`，插件启动时 `agents.resume()` 接回同一个会话，所以 DSH 重启后她仍然记得之前每一封信——这是这个方案区别于其他本地实现的地方。

## 安装

需要 DSH 桌面端 0.2.x（Windows）与 `0.0.9.627` 版游戏客户端。

```powershell
# 1. 把插件挂进 desktop profile（改动前自动备份成 *.bak-olivia-<时间戳>）
.\tools\install-desktop.ps1

# 2. 给游戏打前端补丁（原版先备份成 feapp.dat.orig-backup）
.\tools\patch-feapp.ps1 -GameDir 'X:\SteamLibrary\steamapps\common\BSide Olivia Lin Test'

# 3. 重启 DSH
```

`install-desktop.ps1` 做三件事：profile 的 `package.json` 加 `file:` 依赖与 bundle 条目、
建 `node_modules\dsh-olivia-bridge` junction 指向本仓库、`cordis.patch.yml` 末尾追加
`preset-olivia`（林离人格，`complete: true`，不挂工具）。

游戏目录也可以设一次环境变量，之后游戏侧的两个脚本都不用再传参：

```powershell
[Environment]::SetEnvironmentVariable('BSIDE_GAME_DIR', 'X:\SteamLibrary\steamapps\common\BSide Olivia Lin Test', 'User')
```

补丁锚点是按 `0.0.9.627` 的前端包写的，每一步都校验锚点唯一性，换版本会直接报错中止，不会写坏文件。

## 游戏侧补丁

`tools/patch-feapp.ps1` 改前端包里的十五处（每次都先从 `feapp.dat.orig-backup` 重打，幂等）：

| # | 补丁点 | 目的 |
|---|---|---|
| 1 | `jl()` 里的 `Te.defaults.baseURL` | axios 基址钉死到本地 |
| 2 | `N=j(()=>d.value.offlineMode===!0)` → `!1` | 关掉离线门禁（为 true 时请求拦截器首行直接 throw） |
| 3 | `setClientConfig` 覆盖 | `offlineMode=false` + `toyApiUrl` 指向本地 + `appInfo.Channel="demo"`，绕开已停服的米哈游账号登录 |
| 4 | 实例创建时的 `baseURL:""` | 离线版 `conf.app.dat` 没有 `appConfig` 段，1/3 两条路都会短路 |
| 5 | `index.html` 注入 `tools/inject.js` | 探针 + XHR/fetch 层请求改写（必须插在 `</head>` 之前） |
| 6 | `m()` 函数 | 主动调 `toggleLetterEntry` 通知原生层显示入口（原生层不认，保留作双保险） |
| 7 | `N3=!1,Ss=!1,wa=({onComplete` → `N3=!0,Ss=!0` | **关键**：解除离线门控 —— `N3` 管「写信」按钮，`Ss` 管 MIDI 上传入口；只开前者会出现「信能写、曲子传不了」 |
| 8 | App 模板里的空 tour 锚点 | **保持原样**：导航已挪到各页标题栏（补丁 14），这里不再动 |
| 9 | `disabled:a.remainingCount<=0` + 额度文案 | 写信按钮不受额度影响，文案换成「今天还可寄 ∞ 封」 |
| 10 | `handleToyLoginSuccess` 末尾挂 `Yn().load()` | 触发离线曲库加载并上报结果（原生桥的返回不经 HTTP，探针看不到） |
| 11 | `N=b(0),$=b(3)` → `b(9999)` + 文案 | 解除前端硬编码的「每日定制 3 首」上限，文案显示 ∞ |
| 12 | `syncLocalStatus` / `startDownload` 那段 | 绕开原生下载状态机（原生不回应），自己上传的曲子直接标成已下载（只改「我的上传」处，官方曲库那处保留） |
| 13 | 信箱头部组件里的「分享信件」按钮 | 换成「删除」，调 `window.__oliviaDeleteMail(mail.id)` → 桥的 `/toy/letter/delete`。前端 store 只 splice 自己的缓存，不走服务端的话刷新就回来 |
| 14 | 曲库 / 信箱页的标题栏 `h1` | 换成「曲库」「信件」两个**固定顺序**的平行入口（曲库恒在左），当前页全亮、另一页 `opacity:.5`，走 `window.__oliviaNav()` |
| 15 | 右上角用户菜单里的「测试版」标签 | 从容器子节点里摘掉 |

```powershell
.\tools\patch-feapp.ps1              # 打补丁（幂等，反复运行结果一致）
.\tools\patch-feapp.ps1 -Port 8800   # 换端口
.\tools\patch-feapp.ps1 -Restore     # 一键还原原版
.\tools\verify-patches.ps1           # 只读校验全部补丁是否落地（全 PASS 才算到位）
```

补丁是**盲替换**，改坏语法会让游戏黑屏且窗口无响应。所以脚本在写回之前会把改好的 bundle 交给
`node --check` 解析一次，失败就中止 —— 此刻 `feapp.dat` 还停在从备份复制过来的原版状态，游戏照常能开。

## 定制演奏（MIDI 上传 → 生成 → 播放）

游戏原本要把 MIDI 上传到官方服务器换演奏，桥在本地实现了整条链路：

```
genObjectUploadUrl → PUT /toy/midi/upload/<key> → midi/generate → 轮询 getGenerateResult
                                                                        ↓
                                              WAV（试听） + MP4（演奏，需要 ffmpeg）
```

- MIDI 解析与 WAV 合成是**纯 JS、零依赖**（移植自 [Comma0103/Linli-Nocturne](https://github.com/Comma0103/Linli-Nocturne) 的 `midi-manifest.js` / `audio-renderer.js`，MIT）。
- 演奏侧的原生 WebPlayer 是 `<video>`，**播不了 WAV**，所以有 ffmpeg 时会再封一个音频-only MP4。
  没装 ffmpeg 也能用：任务正常完成、试听照常，只是演奏不出声，日志里会写明。
  ffmpeg 按 `配置 → OLIVIA_FFMPEG → <DSH_HOME>\olivia-bridge\ffmpeg\ → PATH` 的顺序发现，不硬编码任何路径。
- 上传是 `PUT`，属于非简单请求，浏览器会先发 `OPTIONS` 预检。`Access-Control-Allow-Methods`
  里少一个 `PUT`，请求就在离开浏览器之前被拒掉了 —— 而命令行 `curl` / `Invoke-WebRequest` **不走 CORS**，
  会把这类问题完全掩盖。测试里专门留了一条预检断言盯住它。
- 存储：`<DSH_HOME>\olivia-bridge\midi\`（`jobs.json` + `<key>.mid` + `<jobId>.wav|.mp4`）。
- 歌单（「加播单」/「音乐桌面」）走本地 `<DSH_HOME>\olivia-bridge\playlist.json`。
- 删除也是真删：「我的上传」里删歌走 `POST /toy/deleteUserSong`（`userSongId`），会连 WAV/MP4 一起清掉；
  信件走 `POST /toy/letter/delete`（`letter_id`），连她的回信一起删、幂等（重复删返回 `deleted:false`）。
  这两个端点以前落到 `lib/index.js` 末尾的兜底分支，返回 `code:0` + 空信封 ——
  界面看着删掉了、刷新又回来，是典型的静默失败。另留了一个 `POST /toy/letter/clear` 清空全部往来（前端暂未接入）。

## 配置

`cordis.patch.yml` 里 `olivia-bridge` 那一行的 `config`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `8791` | 监听端口，改了要同步重打游戏补丁 |
| `presetId` | `olivia` | 回信用的 agent preset（行 id 为 `preset-olivia`） |
| `provider` / `model` | 空 | 留空则跟随 DSH 默认模型 |
| `maxDailyLetters` | `1000000` | 每日寄信上限，客户端从 `list` 的 `remainingToday` 读 |
| `llmFallback` | `true` | agent 路径跑不通时退回直接用 LLM 服务生成回信 |
| `ffmpegPath` | 空 | 留空自动发现（见上）：`OLIVIA_FFMPEG` → `<DSH_HOME>\olivia-bridge\ffmpeg\ffmpeg.exe` → `PATH` |

## 观测与排错

```powershell
# 桥的日志（每次请求、每封信的生成耗时都在这里）
$dsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
Get-Content "$dsh\olivia-bridge\bridge.log" -Tail 40

# 信件库
Get-Content "$dsh\olivia-bridge\letters.json" -Raw

# 手动确认服务活着
Invoke-RestMethod http://127.0.0.1:8791/toy/letter/unread_count

# 静态诊断：preset 是否解析、会话建到哪一步、inbox / phase / 消息数
Invoke-RestMethod http://127.0.0.1:8791/olivia/diag

# 让 agent 真跑一轮，回报前后快照（定位「会话建了但没人跑」）
Invoke-RestMethod -Method Post http://127.0.0.1:8791/olivia/agent-test

# 直接打一次 LLM，拿底层真实错误。默认按 agent 路线复现：tools / reasoningEffort /
# maxTokens 取自会话最近一次请求头 —— 这三样正是 agent 路径与裸调用唯一的差别
# （实测同一 provider/model 下裸调成功、agent 路径必失败）。返回里的 errorChain
# 是沿 cause 展开的（≤6 层），TRANSPORT 那句的真因永远在第 2 层往后。
Invoke-RestMethod -Method Post http://127.0.0.1:8791/olivia/llm-test -ContentType 'application/json' -Body '{"text":"ping"}'

# 对照 / 单变量：{"plain":true} 退回只发 provider/model；也可单独覆盖
# {"plain":true,"reasoningEffort":"high"} 或直接给 {"tools":[],"maxTokens":4096}

# 重投某封失败的信
Invoke-RestMethod -Method Post http://127.0.0.1:8791/olivia/retry -Body '{"letterId":"3"}' -ContentType 'application/json'

# 端到端：投一封信等回信
node tools\verify.mjs

# 四组自测：契约层 / 响应形状 / MIDI 全链路 / profile YAML（各自用临时 DSH_HOME，不碰真实信件）
node test\contract.test.mjs
node test\response-shape.test.mjs
node test\midi-flow.test.mjs
node test\validate-profile-yaml.mjs

# 解压看她那个会话的事件（zstd JSONL）
node tools\dump-session.mjs
```

客户端每 60 秒轮询一次 `letter/list` + `unread_count`，所以回信生成完最多一分钟内在游戏里出现。

### agent 路径的四个硬要求

这几条都是实测踩出来的，写在这里免得改代码时再踩（`dsh-agent` 的 README 示例有部分是过时的 v3 写法）：

1. **消息必须带 `id`**。`UserMessage.id` 是 readonly 必需字段，官方 `createMessage` 用 `brandString(randomUUID())` 生成；缺了它 inbox 会**静默丢弃**。
2. **`source.kind` 不能是笼统的 `"plugin"`**。v4 会话格式硬拒（`dsh-session-format-v3-to-v4` 的 `source()` 校验），合法形状是 `plugin:<插件名>`。
3. **`agentOptions` 必须给 provider/model**。空着的话会话建得出来、`presetActive` 也是 true，但 turn 立刻空转、会话日志零事件。没配置时用 `ctx.agentDefaultModel.currentSelection()` 兜底。
4. **`followup()` 之后不能立刻 `whenIdle()`**。它只负责排队 + 异步唤醒驱动器，紧接着调用会在 agent 还没醒时返回（实测 146~174ms）。要先轮询等 assistant 消息落地。

另外两条：preset 按 **`config.id`** 索引（行 id 惯例是 `preset-<config.id>`）；sessionId 固定为 `olivia-letterbox` 并在启动时 `agents.resume()`，否则每次重启 DSH 她都会失忆。

## 已知边界

- 客户端与后端的契约来自对 0.0.9.627 前端包（`assets/main-*.js`）的逆向，以及社区实现的交叉验证。没实现的端点走 `lib/index.js` 末尾的兜底分支，返回**字段完备的空信封** —— 不是 `{}`：前端有 33 个调用点会直接对 `data` 里的数组调方法，缺字段就抛 TypeError、Promise 被拒、骨架屏永远转圈。
- 只实现文字回信。视频/语音回信需要客户端从 `detail.replyVideoUrl` 拿绝对 URL，并以带音轨 MP4 下发，当前没有做。
- **官方离线曲库（「自带曲目」）出不来**：它不走 HTTP，而是走原生桥 `getOfflineSongList`，该 action 在停服后的客户端上压根不回应；`songlist.dat` 又是密文，曲目媒体文件本地也没有。想听曲子只能自己上传 MIDI。
- MIDI 分享码是官方服务端能力，本地不伪造成功（返回 409）。
- 插件只监听 `127.0.0.1`，不对外网开放；服务端不校验 token，任何本机进程都能读写这些信件。
- 只动前端包，不碰任何原生 DLL。

## 卸载

```powershell
.\tools\install-desktop.ps1 -Uninstall   # 摘掉 junction
.\tools\patch-feapp.ps1 -Restore         # 还原游戏文件
# 再按 <DSH_HOME>\profiles\desktop\*.bak-olivia-<时间戳> 恢复 profile 的
# package.json / cordis.patch.yml，重启 DSH
```

## 参考

同一件事的社区实现，可交叉验证补丁点：

- [Comma0103/Linli-Nocturne](https://github.com/Comma0103/Linli-Nocturne) —— 补丁表最完整，前端与原生 DLL 都覆盖
- [AETAVK/linli-local-mail](https://github.com/AETAVK/linli-local-mail) —— 本地信件服务
- [2962152120/oliviaproxy](https://github.com/2962152120/oliviaproxy) —— 代理式实现

## 许可

MIT
