# patch-feapp.ps1 — 把《BSide: Olivia Lin》客户端接到本地 DSH 桥
#
# 全部补丁都改在前端包里，不动任何原生 DLL：
#   1. axios 工厂 jl() 的基址钉死到本地 —— 不依赖原生层是否下发 clientConfig
#   2. 离线门禁 isOfflineMode 恒 false —— 否则请求拦截器首行直接 throw，一个请求都发不出
#   3. setClientConfig 里再兜一层：offlineMode=false + toyApiUrl 指向本地 + Channel=demo
#   4. 实例创建时就把 baseURL 钉死（离线版 conf.app.dat 没有 appConfig，1/3 都会短路）
#   5. 往 index.html 注入探针 + 请求改写器（必须插在 </head> 之前）
#   6. 主动通知原生层显示信件/音乐入口（原生层不认，保留作双保险 + 诊断）
#   7. **关键**：N3=!1 → N3=!0，解除信箱页面「写信」按钮的离线门控
#   8. 把空的 tour 锚点改造成真的侧边栏（主页 <-> 信箱 双向导航）
#   9. 写信按钮不再受额度影响 + 额度文案换成「本地接入 · 不限封数」
#
# 脚本幂等：每次都从 feapp.dat.orig-backup 重打，反复运行结果一致。
# 原版备份在首次运行时创建；-Restore 一键还原。
[CmdletBinding()]
param(
    [int]$Port = 8791,
    [switch]$Restore,
    [string]$GameDir = $env:BSIDE_GAME_DIR
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

# 游戏根目录（里面应有 0.0.9.627\resources\feapp.dat）。
# 用 -GameDir 传，或先设一次环境变量 BSIDE_GAME_DIR。
if (-not $GameDir) {
    throw "未指定游戏目录。用法：.\tools\patch-feapp.ps1 -GameDir 'X:\SteamLibrary\steamapps\common\BSide Olivia Lin Test'，或先设 `$env:BSIDE_GAME_DIR"
}

$feapp = Join-Path $GameDir '0.0.9.627\resources\feapp.dat'
$backup = "$feapp.orig-backup"
if (-not (Test-Path $feapp)) { throw "feapp.dat not found: $feapp" }

# ── 还原 ────────────────────────────────────────────────────────────
if ($Restore) {
    if (-not (Test-Path $backup)) { throw "no backup to restore from: $backup" }
    Copy-Item $backup $feapp -Force
    Write-Host "[restore] feapp.dat restored from $backup"
    exit 0
}

# ── 备份原版（只做一次，之后永远以它为基准重打） ────────────────────
if (-not (Test-Path $backup)) {
    Copy-Item $feapp $backup -Force
    Write-Host "[backup] original saved to $backup"
}
Copy-Item $backup $feapp -Force
Write-Host "[reset] feapp.dat reset to pristine before patching"

$base = "http://127.0.0.1:$Port"

$zip = [System.IO.Compression.ZipFile]::Open($feapp, [System.IO.Compression.ZipArchiveMode]::Update)
try {
    $entry = $zip.Entries | Where-Object { $_.FullName -match '^assets/main-.*\.js$' } | Select-Object -First 1
    if (-not $entry) { throw "frontend main bundle not found in feapp.dat" }
    $entryName = $entry.FullName
    Write-Host "[zip] main bundle: $entryName"

    $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
    $js = $reader.ReadToEnd()
    $reader.Close()

    # ── 补丁 1：axios 基址钉死 ──────────────────────────────────────
    $a1 = 'jl=(e,t)=>{Te.defaults.baseURL=e,Object.entries(t).forEach'
    $r1 = 'jl=(e,t)=>{Te.defaults.baseURL="' + $base + '/toy",Object.entries(t||{}).forEach'
    if (([regex]::Matches($js, [regex]::Escape($a1))).Count -ne 1) { throw "anchor 1 not unique" }
    $js = $js.Replace($a1, $r1)
    Write-Host "[patch 1] axios baseURL pinned to $base/toy"

    # ── 补丁 2：离线门禁恒关 ────────────────────────────────────────
    $a2 = 'N=j(()=>d.value.offlineMode===!0)'
    if (([regex]::Matches($js, [regex]::Escape($a2))).Count -ne 1) { throw "anchor 2 not unique" }
    $js = $js.Replace($a2, 'N=j(()=>!1)')
    Write-Host "[patch 2] offline gate forced off"

    # ── 补丁 3：原生配置到手时再兜一层 ──────────────────────────────
    # Channel 是关键：LoginView 里只有 `appInfo.Channel === "steam"` 才会走
    # handleMhyLogin()，也就是米哈游账号 SDK 的登录流程。离线版的 appInfo 里
    # Channel 仍是 steam，于是客户端一启动就去打已停服的 passport-api.mihoyo.com，
    # SDK 抛 Network Error，onMounted 中断，连 getUserInfo 都发不出去
    # （实测探针：只看到 mihoyo.com 的请求 + "Network Error"）。
    # 钉成 demo 即可绕开登录流程（社区交接文档里那味 "demo" 补丁就是它）。
    $a3 = 'd.value=J,d.value.appConf.toyApiUrl&&jl(d.value.appConf.toyApiUrl+"/toy",d.value.apiHeaders)'
    $r3 = 'window.__oliviaBridgePatched=1,fetch("' + $base + '/olivia/patch3-fired?ch="+encodeURIComponent((J&&J.appInfo&&J.appInfo.Channel)||"none")),J.offlineMode=!1,J.appConf.toyApiUrl="' + $base + '",J.appInfo=Object.assign({},J.appInfo||{},{Channel:"demo"}),d.value=J,jl("' + $base + '/toy",J.apiHeaders),d.value.appConf.toyApiUrl&&jl(d.value.appConf.toyApiUrl+"/toy",d.value.apiHeaders)'
    if (([regex]::Matches($js, [regex]::Escape($a3))).Count -ne 1) { throw "anchor 3 not unique" }
    $js = $js.Replace($a3, $r3)
    Write-Host "[patch 3] setClientConfig override installed (offlineMode off + toyApiUrl + Channel=demo)"

    # ── 补丁 4：axios 实例创建时就把地址钉死（关键）─────────────────
    # 离线版的 conf.app.dat 里没有 appConfig 段（官方停服时移除了在线配置），
    # 原生层下发不了 toyApiUrl，于是前端那句 `appConf.toyApiUrl && jl(...)` 整段短路，
    # 补丁 1/3 都不会被执行（实测客户端日志：section appConfig[object] not found）。
    # 唯一可靠的落点就是这里：实例一建出来 baseURL 就是对的。
    $a4 = 'baseURL:"",timeout:1e4'
    $r4 = 'baseURL:"' + $base + '/toy",timeout:1e4'
    if (([regex]::Matches($js, [regex]::Escape($a4))).Count -ne 1) { throw "anchor 4 not unique" }
    $js = $js.Replace($a4, $r4)
    Write-Host "[patch 4] axios baseURL set at instance creation"

    # ── 补丁 6：主动通知原生层显示信件入口 ──────────────────────────
    # 真相：settingsData 里 mailWidget 默认就是 true，m() 在 store 初始化时也确实
    # 被调用了。但那个 _e watch 只在「值发生变化」时才调 Z.toggleLetterEntry，
    # 初始值没人改过，于是原生层从来没收到过通知，桌面入口一直不出现。
    # 这里改成不依赖变化检测，直接主动通知一次（bridge 调用包 try/catch，
    # 免得原生层不认这个事件时把整个 store 初始化带崩）。
    $a6 = 'const m=()=>{e.isOfflineMode&&(l.value.mailWidget!==!1&&(l.value.mailWidget=!1),l.value.musicWidget!==!1&&(l.value.musicWidget=!1))};'
    $r6 = 'const m=()=>{try{fetch("' + $base + '/olivia/patch6-fired?mw="+String(l.value.mailWidget)+"&off="+String(e.isOfflineMode))}catch(x){}l.value.mailWidget=!0,l.value.musicWidget=!0;try{Z.toggleLetterEntry({new_status:!0}),Z.toggleMusicEntry({new_status:!0})}catch(x){}};'
    if (([regex]::Matches($js, [regex]::Escape($a6))).Count -ne 1) { throw "anchor 6 not unique" }
    $js = $js.Replace($a6, $r6)
    Write-Host "[patch 6] letter/music entry pushed to native layer"

    # ── 补丁 7：解除写信按钮的离线门控（**真正的关键补丁**）─────────
    # 信件页面的「写信」按钮可见性 = MailBoxView 的 `"hide-write":o(p)||!o(N3)`：
    #   p = isOfflineMode，N3 = 一个硬编码常量 `N3=!1,Ss=!1`（Ss 是 MIDI 上传开关）。
    # 补丁 2 已经把 isOfflineMode 干掉，但那只是让 `o(p)` 变 false；`!o(N3)` 仍是
    # true，按钮照样隐藏 —— 而且 N3 全文件只出现两次（定义 + 这一处使用），
    # 离线版从没有任何代码把它置真，所以它就是个恒假的死开关。
    #
    # 信箱页面本身并没有被删：`/collection` 路由的 CollectionDynamicView 是
    # `appMode===Se.PRO ? Rb(CollectionView) : f5(MailBoxView)`，而离线会话
    # （startOfflineSession / appMode 默认值）都是 Se.LITE → 侧边栏「Collection」
    # 那一页就是信箱页。之前认定「路由表里没有 mailbox 所以进不去」是找错了对象：
    # 少的不是路由，是信纸上的那支笔。
    # （社区对照：Comma0103/Linli-Nocturne 的 offline-feature 补丁 id 就叫
    #   `mailbox-entry`，改的是同一处 N3；AETAVK/linli-local-mail 则直接把
    #   `"hide-write":o(p)||!o(N3)` 替换成 `"hide-write":!1`。）
    # 同一条语句里的 **Ss 是 MIDI 上传开关**（独立于 N3），全文 4 处：
    #   `!o(w)&&o(Ss)?` → 曲库页顶部的上传卡片（id=tour-midi-upload）
    #   `o(Ss)?`        → 「我的上传」空状态里的上传按钮
    #   `o(Ss)?`        → CollectionView 的上传卡片
    # 只开 N3 会出现「信能写、曲子传不了」，所以两个一起置真。
    # （Nocturne 的 `musicGate` 补丁做的正是后半截：N3=!0,Ss=!1 → N3=!0,Ss=!0。）
    $a7 = 'N3=!1,Ss=!1,wa=({onComplete'
    $r7 = 'N3=!0,Ss=!0,wa=({onComplete'
    if (([regex]::Matches($js, [regex]::Escape($a7))).Count -ne 1) { throw "anchor 7 not unique" }
    $js = $js.Replace($a7, $r7)
    Write-Host "[patch 7] feature flags N3=!0 + Ss=!0 (write button + MIDI upload button)"

    # ── 补丁 8：侧边栏锚点保持原样（导航已改到标题栏，见补丁 14）────────────
    # App 模板里这两个 div 原本是新手引导的定位锚点，父容器是
    # `w-0 ... pointer-events-none`（宽 0、不接收鼠标事件），所以既不可见也点不到。
    # 早先这里把它们改造成窗口左缘固定的「曲」「信」两个竖排按钮 —— 能用了，
    # 但悬浮在页面标题的视觉层级之外，用户反馈「丑」。
    # 现在导航改到各页标题栏右侧（补丁 14），这里恢复原状、不再修改。
    $a8 = 'ef=n("div",{class:"flex flex-col items-center justify-center fixed top-1/2 -translate-y-1/2 left-0 w-0 h-[112px] pointer-events-none"},[n("div",{id:"tour-studio",class:"w-full h-full"}),n("div",{id:"tour-collection",class:"w-full h-full"})],-1)'
    if (([regex]::Matches($js, [regex]::Escape($a8))).Count -ne 1) { throw "anchor 8 not unique" }
    Write-Host "[patch 8] sidebar anchors left untouched (nav moved to page headers)"

    # ── 补丁 9：写信入口不再受额度影响 ────────────────────────────────
    # 真正的额度限制在桥侧（lib/index.js 的 maxDailyLetters），前端这里只负责
    # 不把用户挡在门外：remainingCount 在列表数据还没回来时是 0，原逻辑
    # `disabled:remainingCount<=0` 会把写信按钮直接灰掉。
    $a9a = 'disabled:a.remainingCount<=0'
    if (([regex]::Matches($js, [regex]::Escape($a9a))).Count -ne 1) { throw "anchor 9a not unique" }
    $js = $js.Replace($a9a, 'disabled:!1')

    # 「今天还可寄 N 封信」改成不限（\u 转义保持脚本纯 ASCII）
    $a9b = 'v(o(s)("mailbox_write_mail_remaing",{count:a.remainingCount}))'
    if (([regex]::Matches($js, [regex]::Escape($a9b))).Count -ne 1) { throw "anchor 9b not unique" }
    $js = $js.Replace($a9b, '"\u4eca\u5929\u8fd8\u53ef\u5bc4 \u221e \u5c01"')
    Write-Host "[patch 9] quota text replaced + write button never disabled"

    # ── 补丁 10：加载离线曲库（游戏自带曲目的唯一数据源）────────────
    # 自带曲目不走 HTTP。offlineCatalog store（`Yn`）的 load() 会调**原生桥**：
    #     Xm() -> We({action:"getOfflineSongList", data:{}})
    # 原生返回一段 JSON 字符串，再由 `y1()` 解析成 songs / musicStyles /
    # performanceModes。但 load() 只在 `startOfflineSession()`（离线兜底登录）里
    # 被调用 —— 我们的桥让 getUserInfo 成功返回，客户端走的是在线路径，
    # 于是 offlineCatalog 永远是空的：曲库页不转圈、但也没有歌。
    # （官方离线版之所以有歌，正是因为它连不上服务器 → 走离线兜底 → 原生把
    #   曲目列表交给前端。）
    #
    # 这里挂在 handleToyLoginSuccess 的结尾补一次 load()。
    # 顺带把结果上报到桥：原生桥的返回**不经 HTTP**，探针在 fetch/XHR 层看不到，
    # 所以由这里直接报 songs/musicStyles 数量或失败原因。
    # ⚠️ 这里必须是**表达式**：它夹在 `return s.isNewUser=G, ..., <这块>, z` 的
    # 逗号表达式里，所以不能直接写 `try{...}catch(e){}` —— 那会抛
    # `SyntaxError: Unexpected token 'try'`，整个 bundle 解析失败、Vue 应用不挂载，
    # 表现是**黑屏且窗口无响应**（2026-10-07 就是这么翻的车）。
    # 用 Promise.resolve().then(...) 包一层，try/catch 落进箭头函数体就合法了。
    $a10 = 'Lt().liteStartPoll(),uo().startPolling())),z}'
    $r10 = 'Lt().liteStartPoll(),uo().startPolling())),Promise.resolve().then(()=>{try{return Yn().load()}catch(x){}}).then(()=>{try{fetch("' + $base + '/olivia/catalog-loaded?n="+Yn().songs.length+"&styles="+Yn().musicStyles.length)}catch(x){}}).catch(e=>{try{fetch("' + $base + '/olivia/catalog-failed?e="+encodeURIComponent(String(e&&e.message||e)).slice(0,150))}catch(x){}}),z}'
    if (([regex]::Matches($js, [regex]::Escape($a10))).Count -ne 1) { throw "anchor 10 not unique" }
    $js = $js.Replace($a10, $r10)
    Write-Host "[patch 10] offline catalog load hooked (native getOfflineSongList) + reported"

    # ── 补丁 11：解除「每日定制 3 首」上限 ───────────────────────────
    # midi store 里那个 3 是硬编码：`N=b(0),$=b(3)`（$ = midiDailyLimit，
    # N = midiGeneratedToday）。消费点两处都是「剩余 = 上限 - 已用」：
    #   MidiUploadCardLarge: h = max(0, midiDailyLimit - midiGeneratedToday)
    #                        → 文案 `midi_daily_remaining`「今天还可定制 {remaining} 首」
    #   MidiUploadDialog:    disabled: remaining <= 0
    #                        → 文案 `midi_daily_limit_reached`「今日定制次数已用完」
    # 所以把上限抬上去就同时解决两处。这个数字与桥无关（接口不返回它），
    # 纯前端常量，官方按在线服务端规则设成 3。
    $a11 = 'N=b(0),$=b(3);let L=null;'
    $r11 = 'N=b(0),$=b(9999);let L=null;'
    if (([regex]::Matches($js, [regex]::Escape($a11))).Count -ne 1) { throw "anchor 11 not unique" }
    $js = $js.Replace($a11, $r11)

    # 数字不显示成 9999，直接写成 ∞（这个消费点在全文唯一）
    $a11b = 'v(o(c)("midi_daily_remaining",{remaining:o(h)}))'
    if (([regex]::Matches($js, [regex]::Escape($a11b))).Count -ne 1) { throw "anchor 11b not unique" }
    $js = $js.Replace($a11b, '"\u4eca\u5929\u8fd8\u53ef\u5b9a\u5236 \u221e \u9996"')
    Write-Host "[patch 11] midiDailyLimit 3 -> 9999 + label shows infinity"

    # ── 补丁 12：「我的上传」不再走原生下载（否则永远卡在「下载中」）──
    # StudioLiteView 的 Dt() 是这么写的：
    #   me.forEach(Be=>f.initSongStatus(Be.id,Be.styleType)),
    #   me.length>0 && await f.syncLocalStatus(me.map(Le)),   // → 原生 checkLocalSongs
    #   q.filter(...).forEach(Be=>f.startDownload(Be))        // → 原生 startDownloadTasks
    # 整条下载状态机都压在原生层上：syncLocalStatus 问「本地有没有」，startDownload
    # 发起下载，进度来自 getDownloadTasksProgress。而这几个 action 原生都不回应
    # （和 getOfflineSongList 同一个现象），于是条目永远停在「下载中 0B/0B」。
    #
    # 我们自己上传的曲子根本不需要下载 —— 它的 videoUrl / audioUrl 就是桥直接给的
    # 本地地址。所以这里绕开原生：syncLocalStatus 不再 await（它可能永远不 settle，
    # await 会把后面整段卡住），并直接把条目写进 downloadMap 标成 completed。
    $a12 = 'me.length>0&&await f.syncLocalStatus(me.map(Le)),q.filter(Be=>!f.isDownloaded(Be.id)&&!f.isDownloading(Be.id)).forEach(Be=>f.startDownload(Be))'
    $r12 = 'me.length>0&&f.syncLocalStatus(me.map(Le)).catch(()=>{}),q.forEach(Be=>f.downloadMap.set(Be.id,{progress:100,state:"completed",totalBytes:1,downloadedBytes:1,downloadSpeed:0,styleType:Be.styleType,name:Be.name,nameKey:Be.nameKey,performanceType:Be.performanceType??""}))'
    if (([regex]::Matches($js, [regex]::Escape($a12))).Count -ne 1) { throw "anchor 12 not unique" }
    $js = $js.Replace($a12, $r12)
    Write-Host "[patch 12] uploaded songs marked downloaded (native download bypassed)"

    # ── 补丁 13：把信箱详情区的「分享信件」按钮换成「删除」──────────────
    # 原做法是在详情组件后面另插一个 absolute 定位的按钮，但那个位置的三元条件
    # （o(M)）实测恒为假，按钮根本不出现（已用无条件渲染验证：那段代码本身没问题）；
    # 而且另插的按钮会叠在标题栏上，不协调。
    # 改成直接替换头部组件 MailBoxContentHeader（G4）里的分享按钮：
    #   文字 mailbox_share_letter -> 删除；图标 type share -> delete；
    #   onClick 由 emit("share") 改为调 inject.js 挂的 __oliviaDeleteMail(mail.id)，
    #   由它打桥的 /toy/letter/delete（桥侧已实现真删除）。
    # i 是该组件 setup 里的 props（const i = e），render 闭包可见。
    $a13 = 'n("button",{type:"button",class:"flex items-center gap-1 px-3 py-1.5 rounded-3 bg-primary-2 hover:bg-primary-1 active:bg-primary-3 text-grey-0 text-body-s font-medium cursor-pointer transition-colors",onClick:p},[k(y,{type:"share"}),pe(" "+v(o(s)("mailbox_share_letter")),1)])'
    $r13 = 'n("button",{type:"button",class:"flex items-center gap-1 px-3 py-1.5 rounded-3 bg-primary-2 hover:bg-primary-1 active:bg-primary-3 text-grey-0 text-body-s font-medium cursor-pointer transition-colors",onClick:()=>{window.__oliviaDeleteMail&&window.__oliviaDeleteMail(i.mail.id)}},[k(y,{type:"delete"}),pe(" "+v("\u5220\u9664"),1)])'
    if (([regex]::Matches($js, [regex]::Escape($a13))).Count -ne 1) { throw "anchor 13 not unique" }
    $js = $js.Replace($a13, $r13)
    Write-Host "[patch 13] mailbox share button replaced by delete"

    # ── 补丁 14：曲库 / 信箱 标题栏改成两个固定顺序的平行入口 ────────────
    # 关键点：**顺序固定** —— 「曲库」永远在左、「信件」永远在右，不随当前页互换
    # （早先的写法是当前页占左，导致点完右边那个它就跑到了左边，观感很跳）。
    # 当前页那个保持全亮、另一个降到 opacity .5 并在 hover 时恢复，用来区分「你在哪」。
    # 字体形状/大小沿用原标题的 class（text-text-title text-headline-l）；
    # 去框用内联 style（编译期 CSS 未必有 tailwind 的边框/内距类）；间距也用内联。
    $navTitle = 'text-text-title text-headline-l'
    $navBase = 'background:transparent;border:none;padding:0;cursor:pointer'
    $navGap = 'background:transparent;border:none;padding:0;cursor:pointer;margin-left:24px'
    $a14a = 'n("div",F3,[n("h1",G3,v(o(t)("studio_title")),1)])'
    $r14a = 'n("div",F3,[n("button",{type:"button",class:"' + $navTitle + '",style:"' + $navBase + '",onClick:()=>window.__oliviaNav&&window.__oliviaNav("studio")},v(o(t)("studio_title"))),n("button",{type:"button",class:"' + $navTitle + '",style:"' + $navGap + ';opacity:.5",onClick:()=>window.__oliviaNav&&window.__oliviaNav("collection")},v(o(t)("mailbox_title")))])'
    if (([regex]::Matches($js, [regex]::Escape($a14a))).Count -ne 1) { throw "anchor 14a not unique" }
    $js = $js.Replace($a14a, $r14a)
    $a14b = 'n("div",u5,[n("h1",p5,v(o(t)("mailbox_title")),1)])'
    $r14b = 'n("div",u5,[n("button",{type:"button",class:"' + $navTitle + '",style:"' + $navBase + ';opacity:.5",onClick:()=>window.__oliviaNav&&window.__oliviaNav("studio")},v(o(t)("studio_title"))),n("button",{type:"button",class:"' + $navTitle + '",style:"' + $navGap + '",onClick:()=>window.__oliviaNav&&window.__oliviaNav("collection")},v(o(t)("mailbox_title")))])'
    if (([regex]::Matches($js, [regex]::Escape($a14b))).Count -ne 1) { throw "anchor 14b not unique" }
    $js = $js.Replace($a14b, $r14b)
    Write-Host "[patch 14] fixed-order header nav (studio left / mailbox right)"
    # ── 补丁 15：移除右上角的「测试版」标签 ──────────────────────────────
    # 它在用户菜单容器里（absolute right-5 ... z-50）的第二个子节点，
    # 是 n("div",r0,v(o(a)("common_beta_tag")),1)。直接从这个数组里摘掉。
    $a15 = 'z-50"},[n("div",r0,v(o(a)("common_beta_tag")),1),'
    $r15 = 'z-50"},['
    if (([regex]::Matches($js, [regex]::Escape($a15))).Count -ne 1) { throw "anchor 15 not unique" }
    $js = $js.Replace($a15, $r15)
    Write-Host "[patch 15] beta tag removed from header"    # ── 语法断言（**所有 bundle 补丁之后、写回之前**）─────────────────
    # 上面的字符串替换全是盲替，一旦把语法改坏，结果是黑屏 + 窗口卡死，
    # 而且从外部很难判断是"补丁写错了"还是"原生层卡了"。
    # 这里把改好的 bundle 交给 node 解析一次：失败就中止，而 feapp.dat 此刻
    # 还停在脚本开头从 orig-backup 复制过来的**原版**状态，游戏照常能开。
    # 注意：它必须放在**最后一个改 $js 的补丁之后**，否则后面的补丁不受保护。
    $tmpJs = Join-Path $env:TEMP ("feapp-syntax-" + [guid]::NewGuid().ToString('N') + ".mjs")
    [System.IO.File]::WriteAllText($tmpJs, $js, (New-Object System.Text.UTF8Encoding($false)))
    $syntaxOut = & node --check $tmpJs 2>&1 | Out-String
    $syntaxOk = ($LASTEXITCODE -eq 0)
    Remove-Item $tmpJs -Force -ErrorAction SilentlyContinue
    if (-not $syntaxOk) {
        throw "patched bundle failed the syntax check - feapp.dat was left at the pristine backup.`n$syntaxOut"
    }
    Write-Host "[check] bundle syntax OK"

    $entry.Delete()
    $new = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $writer = New-Object System.IO.StreamWriter($new.Open(), (New-Object System.Text.UTF8Encoding($false)))
    $writer.Write($js)
    $writer.Close()

    # ── 补丁 5：往 index.html 注入哨兵 + 请求改写器 ──────────────────
    # 前面几个补丁都改在主 bundle 里，但如果客户端压根没读这个包（或有别的加载路径），
    # 它们全是白改。注入的脚本会在页面加载时直接向桥发探测请求：
    # 桥的日志里出现 /olivia/probe-from-game 就证明包被读了；
    # 同时它在 XHR/fetch 层改写 /toy/* 请求，比改 axios baseURL 更底层。
    $htmlEntry = $zip.Entries | Where-Object { $_.FullName -eq 'index.html' } | Select-Object -First 1
    if (-not $htmlEntry) { throw "index.html not found in feapp.dat" }
    $htmlReader = New-Object System.IO.StreamReader($htmlEntry.Open(), [System.Text.Encoding]::UTF8)
    $html = $htmlReader.ReadToEnd()
    $htmlReader.Close()

    if ($html.Contains('oliviaBridgeProbe')) {
        Write-Host "[patch 5] probe already injected"
    } else {
        $injectPath = Join-Path $PSScriptRoot 'inject.js'
        if (-not (Test-Path $injectPath)) { throw "inject.js not found: $injectPath" }
        $inject = [System.IO.File]::ReadAllText($injectPath)
        $snippet = "<script>`n" + $inject + "`n</script>`n"
        # 必须插在 </head> 之前（也就是所有 <meta> 之后）：<meta charset> 只在文档
        # 前 1024 字节内有效，插到 <head> 紧跟其后会把 charset 声明推出这个窗口，
        # 浏览器按错误编码解析整页 —— 实测过一次全黑屏。
        $headEnd = $html.IndexOf('</head>')
        if ($headEnd -ge 0) {
            $html = $html.Insert($headEnd, $snippet)
        } else {
            $html = $snippet + $html
        }
        $htmlEntry.Delete()
        $newHtml = $zip.CreateEntry('index.html', [System.IO.Compression.CompressionLevel]::Optimal)
        $htmlWriter = New-Object System.IO.StreamWriter($newHtml.Open(), (New-Object System.Text.UTF8Encoding($false)))
        $htmlWriter.Write($html)
        $htmlWriter.Close()
        Write-Host "[patch 5] probe + request rewriter injected before </head>"
    }
} finally {
    $zip.Dispose()
}

Write-Host "[done] feapp.dat patched -> $base (run with -Restore to revert)"
