$ErrorActionPreference = 'Stop'
$nativeDir = Join-Path $PSScriptRoot 'native'
$hostManifest = (Resolve-Path -LiteralPath (Join-Path $nativeDir 'host-manifest.json')).Path
$config = Get-Content -LiteralPath $hostManifest -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $config.path)) { throw '桥接程序不存在，请先完成项目构建。' }
$registryPath = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.infolens.local_reader'
if (Test-Path -LiteralPath $registryPath) {
    $currentValue = (Get-Item -LiteralPath $registryPath).GetValue('')
    if ($currentValue -and $currentValue -ne $hostManifest) { throw '已有同名桥接指向其他目录，请先核对现有安装。' }
}
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $hostManifest
Write-Output 'InfoLens 本机桥接已注册，仅允许本项目的 Edge 扩展访问。'
Write-Output ('扩展目录：' + $PSScriptRoot)
