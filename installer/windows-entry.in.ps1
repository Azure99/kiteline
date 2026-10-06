param([string]$Version, [string]$Code)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or
    -not (($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1 -and $PSVersionTable.PSEdition -eq 'Desktop') -or
        ($PSVersionTable.PSVersion.Major -eq 7 -and $PSVersionTable.PSVersion -ge [version]'7.4'))) { throw 'Use Windows PowerShell 5.1 or PowerShell 7.4+ on Windows' }
if ($Version -cne __KITELINE_VERSION__) { throw 'The server release changed; obtain a new command from the web app' }
$kitelineInstaller = Join-Path ([IO.Path]::GetTempPath()) ('kiteline-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')
$kitelinePolicy = Get-ExecutionPolicy -Scope Process
try {
    Set-ExecutionPolicy -Scope Process Bypass -Force
    Invoke-WebRequest -UseBasicParsing -Uri __KITELINE_INSTALL_URL__ -OutFile $kitelineInstaller
    & $kitelineInstaller -Mode __KITELINE_MODE__ -Server __KITELINE_ORIGIN__ -Version $Version -Code $Code
} finally {
    try { if ([IO.File]::Exists($kitelineInstaller)) { [IO.File]::Delete($kitelineInstaller) } }
    finally { Set-ExecutionPolicy -Scope Process $kitelinePolicy -Force }
}
