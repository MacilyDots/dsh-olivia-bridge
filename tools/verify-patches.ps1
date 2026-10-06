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
    @{ n = '7 N3 = !0 (write btn)';   s = 'N3=!0,Ss=!1,wa=({onComplete'; want = $true }
    @{ n = '7 old N3 (must go)';      s = 'N3=!1,Ss=!1'; want = $false }
    @{ n = '8 sidebar -> studio';     s = 'window.__oliviaNav&&window.__oliviaNav("studio")'; want = $true }
    @{ n = '8 sidebar -> mailbox';    s = 'window.__oliviaNav&&window.__oliviaNav("collection")'; want = $true }
    @{ n = '8 old invisible anchor';  s = 'left-0 w-0 h-[112px] pointer-events-none'; want = $false }
    @{ n = '9 write btn enabled';     s = 'disabled:!1'; want = $true }
    @{ n = '9 old disabled check';    s = 'disabled:a.remainingCount<=0'; want = $false }
    @{ n = '9 quota text replaced';   s = '\u672c\u5730\u63a5\u5165 \u00b7 \u4e0d\u9650\u5c01\u6570'; want = $true }
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
