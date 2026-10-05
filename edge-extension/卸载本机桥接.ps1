$ErrorActionPreference = 'Stop'
$registryPath = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.infolens.local_reader'
$hostManifest = Join-Path $PSScriptRoot 'native\host-manifest.json'
if (Test-Path -LiteralPath $registryPath) {
    $currentValue = (Get-Item -LiteralPath $registryPath).GetValue('')
    if ($currentValue -ne $hostManifest) { throw '登记目录不属于此安装，未改动。' }
    Remove-Item -LiteralPath $registryPath
}
Write-Output '本项目的 Edge 桥接登记已移除。模型和用户文件保留。'
