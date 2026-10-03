param([string]$Version, [string]$Code)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'Use PowerShell 7 on Windows' }
if ($Version -cne __KITELINE_VERSION__) { throw 'The server release changed; obtain a new command from the web app' }
$kitelineInstaller = Join-Path ([IO.Path]::GetTempPath()) ('kiteline-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')
$kitelinePolicy = Get-ExecutionPolicy -Scope Process
try {
    Set-ExecutionPolicy -Scope Process Bypass -Force
    Invoke-WebRequest -Uri __KITELINE_INSTALL_URL__ -OutFile $kitelineInstaller
    & $kitelineInstaller -Mode __KITELINE_MODE__ -Server __KITELINE_ORIGIN__ -Version $Version -Code $Code
} finally {
    try { if ([IO.File]::Exists($kitelineInstaller)) { [IO.File]::Delete($kitelineInstaller) } }
    finally { Set-ExecutionPolicy -Scope Process $kitelinePolicy -Force }
}
