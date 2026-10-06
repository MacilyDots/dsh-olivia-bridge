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
    $a7 = 'N3=!1,Ss=!1,wa=({onComplete'
    $r7 = 'N3=!0,Ss=!1,wa=({onComplete'
    if (([regex]::Matches($js, [regex]::Escape($a7))).Count -ne 1) { throw "anchor 7 not unique" }
    $js = $js.Replace($a7, $r7)
    Write-Host "[patch 7] letter feature flag N3=!0 (write button no longer hidden)"

    # ── 补丁 8：把空的 tour 锚点改造成真正的侧边栏（主页 <-> 信箱 双向）──
    # App 模板里这两个 div 原本是给新手引导用的定位锚点，父容器是
    # `w-0 ... pointer-events-none`（宽 0、且不接收鼠标事件），所以根本点不到。
    # 这也正是「信箱页进得去、出不来」的原因：LITE 模式下 /collection 是信箱、
    # /studio 是曲库，而两者之间原本没有任何前端导航（官方 PRO 模式靠原生侧栏）。
    # 这里把它们做成 36px 宽的两个按钮，点击调用注入脚本暴露的
    # window.__oliviaNav()（内部走 Vue Router 的 replace）。
    $a8 = 'ef=n("div",{class:"flex flex-col items-center justify-center fixed top-1/2 -translate-y-1/2 left-0 w-0 h-[112px] pointer-events-none"},[n("div",{id:"tour-studio",class:"w-full h-full"}),n("div",{id:"tour-collection",class:"w-full h-full"})],-1)'
    $btn8 = 'w-full h-full flex items-center justify-center rounded-2 bg-grey-1 hover:bg-grey-2 text-text-secondary text-body-m cursor-pointer select-none'
    $r8 = 'ef=n("div",{class:"flex flex-col items-center justify-center fixed top-1/2 -translate-y-1/2 left-2 w-9 h-[112px] gap-2 z-50"},[n("div",{id:"tour-studio",class:"' + $btn8 + '",onClick:()=>window.__oliviaNav&&window.__oliviaNav("studio")},"\u66f2"),n("div",{id:"tour-collection",class:"' + $btn8 + '",onClick:()=>window.__oliviaNav&&window.__oliviaNav("collection")},"\u4fe1")],-1)'
    if (([regex]::Matches($js, [regex]::Escape($a8))).Count -ne 1) { throw "anchor 8 not unique" }
    $js = $js.Replace($a8, $r8)
    Write-Host "[patch 8] sidebar nav restored (studio <-> mailbox)"

    # ── 补丁 9：写信入口不再受额度影响 ────────────────────────────────
    # 真正的额度限制在桥侧（lib/index.js 的 maxDailyLetters），前端这里只负责
    # 不把用户挡在门外：remainingCount 在列表数据还没回来时是 0，原逻辑
    # `disabled:remainingCount<=0` 会把写信按钮直接灰掉。
    $a9a = 'disabled:a.remainingCount<=0'
    if (([regex]::Matches($js, [regex]::Escape($a9a))).Count -ne 1) { throw "anchor 9a not unique" }
    $js = $js.Replace($a9a, 'disabled:!1')

    # 「今天还可寄 N 封信」改成固定文案（\u 转义保持脚本纯 ASCII）
    $a9b = 'v(o(s)("mailbox_write_mail_remaing",{count:a.remainingCount}))'
    if (([regex]::Matches($js, [regex]::Escape($a9b))).Count -ne 1) { throw "anchor 9b not unique" }
    $js = $js.Replace($a9b, '"\u672c\u5730\u63a5\u5165 \u00b7 \u4e0d\u9650\u5c01\u6570"')
    Write-Host "[patch 9] quota text replaced + write button never disabled"

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
