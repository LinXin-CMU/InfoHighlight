param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$hostSource = Join-Path $PSScriptRoot 'InfoLensHost.cs'
$hostBinary = if ($OutputPath) { $OutputPath } else { Join-Path $PSScriptRoot 'InfoLensHost.exe' }
$applicationIcon = Join-Path $PSScriptRoot 'icons\infolens.ico'
$trayIcon = Join-Path $PSScriptRoot 'icons\infolens-tray.ico'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32icon:$applicationIcon" "/resource:$trayIcon,InfoLens.Tray.ico" "/out:$hostBinary" $hostSource (Join-Path $PSScriptRoot 'FloatingController.cs')
if ($LASTEXITCODE -ne 0) { throw 'Host compilation failed.' }
