# install-desktop.ps1 — 把 dsh-olivia-bridge 装进 desktop profile
#
# 做三件事：
#   1. 备份 profile 的 package.json / cordis.patch.yml
#   2. package.json 里加 file: 依赖与 bundle 条目，并建 node_modules junction
#   3. cordis.patch.yml 末尾追加"林离"preset（人格 + 无工具 + complete）
#
# 不改 pnpm-lock.yaml，不跑 pnpm install —— 只加一条 junction，让 profile 直接吃到本仓库。
[CmdletBinding()]
param(
    [string]$Profile = '',
    [string]$PluginDir = '',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# 默认 profile：$DSH_HOME（默认 %USERPROFILE%\.dsh）\profiles\desktop
if (-not $Profile) {
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $Profile = Join-Path $dshHome 'profiles\desktop'
}
# 默认插件目录：本仓库自身（脚本位于 <repo>\tools\ 下）
if (-not $PluginDir) { $PluginDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$pkgPath = Join-Path $Profile 'package.json'
$patchPath = Join-Path $Profile 'cordis.patch.yml'
$linkPath = Join-Path $Profile 'node_modules\dsh-olivia-bridge'
$personaPath = Join-Path $PluginDir 'tools\preset-persona.txt'

if (-not (Test-Path $pkgPath)) { throw "profile package.json not found: $pkgPath" }
if (-not (Test-Path $patchPath)) { throw "profile cordis.patch.yml not found: $patchPath" }

# ── 卸载 ────────────────────────────────────────────────────────────
if ($Uninstall) {
    if (Test-Path $linkPath) { Remove-Item $linkPath -Force -Recurse }
    Write-Host "[uninstall] junction removed. Remove the dependency/bundle rows and the preset block manually if needed."
    exit 0
}

# ── 备份 ────────────────────────────────────────────────────────────
Copy-Item $pkgPath "$pkgPath.bak-olivia-$stamp" -Force
Copy-Item $patchPath "$patchPath.bak-olivia-$stamp" -Force
Write-Host "[backup] $pkgPath.bak-olivia-$stamp"
Write-Host "[backup] $patchPath.bak-olivia-$stamp"

# ── 1) package.json：依赖 + bundle 条目 ─────────────────────────────
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$depKey = 'dsh-olivia-bridge'
$fileSpec = "file:$($PluginDir -replace '\\','/')"

$depProp = $pkg.dependencies.PSObject.Properties[$depKey]
if ($depProp) { $pkg.dependencies.$depKey = $fileSpec } else { $pkg.dependencies | Add-Member -NotePropertyName $depKey -NotePropertyValue $fileSpec }

if ($pkg.dsh.profile.bundles -notcontains $depKey) {
    $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + $depKey
}

$json = $pkg | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[pkg] dependency + bundle registered"

# ── 2) node_modules junction ────────────────────────────────────────
if (Test-Path $linkPath) {
    Write-Host "[link] junction already present"
} else {
    New-Item -ItemType Junction -Path $linkPath -Target $PluginDir | Out-Null
    Write-Host "[link] $linkPath -> $PluginDir"
}

# ── 3) cordis.patch.yml：追加林离 preset ────────────────────────────
$patchText = [System.IO.File]::ReadAllText($patchPath)
if ($patchText.Contains('preset-olivia')) {
    Write-Host "[preset] already present, skipped"
    exit 0
}

$persona = [System.IO.File]::ReadAllText($personaPath) -replace "`r`n", "`n"
$persona = $persona.TrimEnd("`n")
$indented = ($persona -split "`n" | ForEach-Object { if ($_ -eq '') { '' } else { '            ' + $_ } }) -join "`n"

$block = @"

# ── 林离信箱（dsh-olivia-bridge，2026-10-06）────────────────────────
# 这个 preset 供插件回信使用：complete 让这段人格成为该会话唯一的系统提示，
# 不挂任何工具。也可以在 GUI 的预设列表里手动选中，直接和她对话。
- id: preset-olivia
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: preset-olivia
    name: "林离"
    description: "BSide: Olivia Lin 的信箱人格 —— dsh-olivia-bridge 用它回信"
    order: 20
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          complete: true
          includeRuntimeContext: false
          prefix: |-
$indented
"@

[System.IO.File]::AppendAllText($patchPath, $block, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[preset] preset-olivia appended to cordis.patch.yml"
Write-Host "[done] restart DSH to load the plugin and preset."
