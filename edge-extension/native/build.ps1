$ErrorActionPreference = 'Stop'
$taskCompiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $taskCompiler /nologo /target:exe /platform:x64 /optimize+ ("/out:" + (Join-Path $PSScriptRoot 'InfoLensNative.exe')) (Join-Path $PSScriptRoot 'NativeLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native bridge compilation failed.' }
