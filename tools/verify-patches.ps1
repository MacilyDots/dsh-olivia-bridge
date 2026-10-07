# verify-patches.ps1 — 校验 feapp.dat 里所有前端补丁的落地状态
#
# 只读：解包 = 检查，绝不写回。改完补丁后跑一次，比翻 bridge.log 快得多。
# 用法：.\tools\verify-patches.ps1 [-GameDir <游戏根目录>] [-Port 8791]
[CmdletBinding()]
param(
    [string]$GameDir = $env:BSIDE_GAME_DIR,
    [int]$Port = 8791
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not $GameDir) {
    throw "未指定游戏目录。用法：.\tools\verify-patches.ps1 -GameDir 'X:\SteamLibrary\steamapps\common\BSide Olivia Lin Test'，或先设 `$env:BSIDE_GAME_DIR"
}

$feapp = Join-Path $GameDir '0.0.9.627\resources\feapp.dat'
if (-not (Test-Path $feapp)) { throw "feapp.dat not found: $feapp" }
$base = "http://127.0.0.1:$Port"

$zip = [System.IO.Compression.ZipFile]::OpenRead($feapp)
try {
    $e = $zip.Entries | Where-Object { $_.FullName -match '^assets/main-.*\.js$' } | Select-Object -First 1
    if (-not $e) { throw 'frontend main bundle not found' }
    $rd = New-Object System.IO.StreamReader($e.Open(), [System.Text.Encoding]::UTF8)
    $js = $rd.ReadToEnd(); $rd.Close()

    $h = $zip.Entries | Where-Object { $_.FullName -eq 'index.html' } | Select-Object -First 1
    $html = ''
    if ($h) {
        $rd2 = New-Object System.IO.StreamReader($h.Open(), [System.Text.Encoding]::UTF8)
        $html = $rd2.ReadToEnd(); $rd2.Close()
    }
} finally { $zip.Dispose() }

Write-Host "bundle: $($e.FullName)   length=$($js.Length)"
Write-Host ''

$checks = @(
    @{ n = '1 axios factory pinned';  s = "jl=(e,t)=>{Te.defaults.baseURL=`"$base/toy`",Object.entries(t||{})"; want = $true }
    @{ n = '2 offline gate off';      s = 'N=j(()=>!1)'; want = $true }
    @{ n = '2 old gate (must go)';    s = 'N=j(()=>d.value.offlineMode===!0)'; want = $false }
    @{ n = '3 setClientConfig hook';  s = '__oliviaBridgePatched=1'; want = $true }
    @{ n = '4 instance baseURL';      s = "baseURL:`"$base/toy`",timeout:1e4"; want = $true }
    @{ n = '6 native entry notify';   s = 'patch6-fired'; want = $true }
    @{ n = '7 N3+Ss = !0';            s = 'N3=!0,Ss=!0,wa=({onComplete'; want = $true }
    @{ n = '7 old N3-only (must go)'; s = 'N3=!0,Ss=!1'; want = $false }
    @{ n = '7 old gate (must go)';    s = 'N3=!1,Ss=!1'; want = $false }
    @{ n = '14 nav hook -> studio';     s = 'window.__oliviaNav&&window.__oliviaNav("studio")'; want = $true }
    @{ n = '14 nav hook -> mailbox';    s = 'window.__oliviaNav&&window.__oliviaNav("collection")'; want = $true }
    @{ n = '8 anchors untouched';  s = 'left-0 w-0 h-[112px] pointer-events-none'; want = $true }
    @{ n = '9 write btn enabled';     s = 'disabled:!1'; want = $true }
    @{ n = '9 old disabled check';    s = 'disabled:a.remainingCount<=0'; want = $false }
    @{ n = '9 quota text = inf';      s = '\u4eca\u5929\u8fd8\u53ef\u5bc4 \u221e \u5c01'; want = $true }
    @{ n = '10 catalog load hooked';  s = 'try{return Yn().load()}catch(x){}'; want = $true }
    @{ n = '10 catalog report';       s = '/olivia/catalog-loaded?n='; want = $true }
    @{ n = '11 midi cap lifted';      s = 'N=b(0),$=b(9999);let L=null;'; want = $true }
    @{ n = '11 old cap (must go)';    s = 'N=b(0),$=b(3);let L=null;'; want = $false }
    @{ n = '11 label = inf';          s = '\u4eca\u5929\u8fd8\u53ef\u5b9a\u5236 \u221e \u9996'; want = $true }
    @{ n = '11 old label (must go)';  s = 'midi_daily_remaining'; want = $false }
    @{ n = '12 download bypassed';    s = 'f.downloadMap.set(Be.id,{progress:100,state:"completed"'; want = $true }
    # 判据要盯「我的上传」那处（Dt）：原锚点里的 startDownload 必须消失。
    # 别用 `await f.syncLocalStatus(...)` 当判据 —— 官方曲库的 La() 里还有一处
    # 长得一样的调用，那处本来就该保留（曲库本地没歌，状态无所谓），会永远误报。
    @{ n = '12 old startDownload (must go)'; s = 'q.filter(Be=>!f.isDownloaded(Be.id)&&!f.isDownloading(Be.id)).forEach(Be=>f.startDownload(Be))'; want = $false }
    @{ n = '13 mailbox delete btn';   s = 'window.__oliviaDeleteMail(i.mail.id)'; want = $true }
      @{ n = '14 studio->mailbox nav'; s = 'window.__oliviaNav("collection")'; want = $true }
      @{ n = '14 mailbox->studio nav'; s = 'window.__oliviaNav("studio")'; want = $true }
      @{ n = '15 beta tag gone';        s = 'common_beta_tag'; want = $false }
)

$fail = 0
foreach ($c in $checks) {
    $count = ([regex]::Matches($js, [regex]::Escape($c.s))).Count
    $ok = if ($c.want) { $count -ge 1 } else { $count -eq 0 }
    if (-not $ok) { $fail++ }
    $tag = if ($ok) { 'PASS' } else { 'FAIL' }
    $expect = if ($c.want) { '>=1' } else { '0' }
    Write-Host ("[{0}] {1,-24} count={2} (expect {3})" -f $tag, $c.n, $count, $expect)
}

$probe = $html.Contains('oliviaBridgeProbe')
if (-not $probe) { $fail++ }
Write-Host ("[{0}] {1,-24}" -f $(if ($probe) { 'PASS' } else { 'FAIL' }), '5 index.html probe')

# 语义复核：N3 全文件只该出现两次（定义 + MailBoxView 的 hide-write）。
$n3 = ([regex]::Matches($js, 'N3')).Count
Write-Host ''
Write-Host "[info] 'N3' occurrences = $n3 (expected 2: definition + hide-write)"
Write-Host "[info] hide-write expression present = $($js.Contains('"hide-write":o(p)||!o(N3)'))"
Write-Host ''
Write-Host $(if ($fail -eq 0) { '[ALL PASS]' } else { "[$fail CHECK(S) FAILED]" })
exit $fail
