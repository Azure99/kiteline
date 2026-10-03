param(
    [ValidateSet('Connect', 'Upgrade')][string]$Mode,
    [string]$Server,
    [string]$Version,
    [string]$Code
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or
    [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64') { throw 'Windows x64 and PowerShell 7 are required' }
$origin = [Uri]$Server
if (-not $origin.IsAbsoluteUri -or $origin.Scheme -notin @('http', 'https') -or
    $origin.UserInfo -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment) { throw 'An HTTP or HTTPS server origin is required' }
if ($Version -notmatch '^[0-9A-Za-z.+-]+$') { throw 'Invalid release version' }
if ($Mode -eq 'Connect' -and -not $Code) { throw 'Missing binding code; generate a connection command in the web app' }
if ([Console]::IsInputRedirected) { throw 'Run this command in an interactive PowerShell terminal on the target device' }
if ($env:KITELINE_AGENT_HOME -or $env:KITELINE_AGENT_RUN_DIR) { throw 'The connection/upgrade command uses the installation configuration; unset KITELINE_AGENT_HOME and KITELINE_AGENT_RUN_DIR' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$administrator = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Mode -eq 'Connect' -and $administrator) { throw 'Run the connection command in a non-elevated PowerShell window as your project user; only installation requests administrator approval' }
$pwsh = Join-Path $PSHOME 'pwsh.exe'
$management = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'kiteline-agent'
$public = Join-Path $management 'kiteline-agent.ps1'
$recordFile = Join-Path $management 'installation.json'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('kiteline-agent-download-' + [Guid]::NewGuid().ToString('N'))
$script:retainTemporary = $false

function Quote-Kiteline([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
function Assert-KitelineExit([string]$Operation) {
    # Only managed product commands reach this boundary; terminal DWORD results do not.
    if ($LASTEXITCODE -eq 125) { $script:retainTemporary = $true }
    if ($LASTEXITCODE -ne 0) { throw "$Operation failed (exit $LASTEXITCODE); no automatic retry was made" }
}
function Invoke-KitelineElevated([string]$Script, [string[]]$Arguments) {
    # The synchronous managed wait owns the download until the elevated transaction really exits.
    $source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class __KITELINE_DOWNLOAD_WAIT__ {
    // Matches the launcher ownership failure defined in installer/launcher.in.cs.
    const int FatalExitCode=125;
    public static bool RetainInput { get; private set; }
    delegate bool Handler(uint signal);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(Handler handler,bool add);
    public static int Run(string executable,string command) {
        RetainInput=false;
        int interrupted=0;
        Handler handler=signal => {
            if(signal>1) return false;
            Interlocked.CompareExchange(ref interrupted,signal==0 ? 130 : 131,0);
            return true;
        };
        if(!SetConsoleCtrlHandler(handler,true)) throw new Win32Exception(Marshal.GetLastWin32Error());
        Process child=null;
        Exception failure=null;
        int result=1;
        try {
            child=Process.Start(new ProcessStartInfo(executable,"-NoProfile -ExecutionPolicy Bypass -EncodedCommand "+command) { UseShellExecute=true, Verb="runas" });
            RetainInput=true;
            child.WaitForExit();
            result=child.ExitCode;
            RetainInput=result==FatalExitCode;
            if(result!=FatalExitCode && interrupted!=0) result=interrupted;
        } catch(Exception error) {
            failure=error;
        } finally {
            try { if(child!=null) child.Dispose(); }
            catch(Exception error) {
                failure=failure==null ? error : new AggregateException(failure,error);
            }
            if(!SetConsoleCtrlHandler(handler,false)) {
                Exception error=new Win32Exception(Marshal.GetLastWin32Error(),"remove download console handler");
                failure=failure==null ? error : new AggregateException(failure,error);
            }
            GC.KeepAlive(handler);
        }
        if(failure!=null) throw failure;
        return result;
    }
}
'@
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $typeName = 'KitelineDownload_' + [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($source))).Replace('-', '').Substring(0, 16) }
    finally { $hash.Dispose() }
    if (-not ($typeName -as [type])) { Add-Type -TypeDefinition $source.Replace('__KITELINE_DOWNLOAD_WAIT__', $typeName) }
    $command = '$ErrorActionPreference = ''Stop''; & ' + (Quote-Kiteline $Script) + ' ' + (($Arguments | ForEach-Object { Quote-Kiteline $_ }) -join ' ') + '; exit $LASTEXITCODE'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    try {
        $result = ($typeName -as [type])::Run($pwsh, $encoded)
        if ($result -ne 0) { throw "Elevated maintenance failed or was cancelled (exit $result); the process has finished" }
    } finally {
        if (($typeName -as [type])::RetainInput) { $script:retainTemporary = $true }
    }
}
function Get-KitelineArchive {
    $null = [IO.Directory]::CreateDirectory($temporary)
    $name = "kiteline-agent-$Version-windows-amd64.zip"
    $archive = Join-Path $temporary $name
    $url = "$Server/downloads/agent/$Version/$name"
    Invoke-WebRequest -Uri $url -OutFile $archive
    Invoke-WebRequest -Uri "$url.sha256" -OutFile "$archive.sha256"
    $sum = [IO.File]::ReadAllText("$archive.sha256").Trim()
    if ($sum -cnotmatch ('^([a-f0-9]{64})  ' + [Regex]::Escape($name) + '$')) { throw 'Invalid archive checksum record' }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Matches[1]) { throw 'Archive checksum mismatch' }
    return $archive
}
function Expand-KitelineDownload([string]$Archive) {
    $name = "kiteline-agent-$Version-windows-amd64"
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            if (-not $entry.FullName.StartsWith("$name/", [StringComparison]::Ordinal) -or $entry.FullName.Contains('\')) { throw 'Unexpected package ZIP path' }
            foreach ($part in $entry.FullName.TrimEnd('/').Split('/')) {
                if (-not $part -or $part -in @('.', '..') -or $part -match '[. ]$|[<>:"|?*\x00-\x1f]' -or
                    $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)') { throw 'Invalid Windows ZIP path' }
            }
            $kind = ($entry.ExternalAttributes -shr 16) -band 0xf000
            if (($entry.ExternalAttributes -band 0x400) -or $kind -notin @(0, 0x4000, 0x8000)) { throw 'ZIP links are not allowed' }
        }
        [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip, $temporary, $false)
    } finally { $zip.Dispose() }
    $package = Join-Path $temporary $name
    $release = [IO.File]::ReadAllText((Join-Path $package 'release.json')) | ConvertFrom-Json
    if ($release.kind -cne 'agent' -or $release.platform -cne 'windows' -or $release.architecture -cne 'x64' -or $release.version -cne $Version) { throw 'Package release mismatch' }
    return $package
}

try {
    if ($Mode -eq 'Upgrade') {
        if (-not [IO.File]::Exists($recordFile) -or -not [IO.File]::Exists($public)) { throw 'Install and bind the agent before upgrading' }
        $archive = Get-KitelineArchive
        Invoke-KitelineElevated $public @('upgrade', '--archive', $archive)
    } else {
        if (-not [IO.File]::Exists($recordFile)) {
            $null = Get-Command git.exe -CommandType Application
            $package = Expand-KitelineDownload (Get-KitelineArchive)
            $launcher = Join-Path $package 'bin/kiteline-agent.ps1'
            & $pwsh -NoProfile -ExecutionPolicy Bypass -File $launcher check
            Assert-KitelineExit 'Package check'
            Invoke-KitelineElevated $launcher @('install', '--user', $identity.Name)
        }
        $record = [IO.File]::ReadAllText($recordFile) | ConvertFrom-Json
        if ($record.sid -cne $identity.User.Value) { throw 'This installation belongs to another project user' }
        $installedVersion = & $pwsh -NoProfile -ExecutionPolicy Bypass -File $public --version
        Assert-KitelineExit 'Installed version check'
        if ($installedVersion -cne $Version) { throw 'A different version is installed; explicitly upgrade before connecting' }
        & $pwsh -NoProfile -ExecutionPolicy Bypass -File $public check
        Assert-KitelineExit 'Installed check'
        $Code | & $pwsh -NoProfile -ExecutionPolicy Bypass -File $public bind --server $Server --if-unbound
        Assert-KitelineExit 'Binding'
    }
} finally {
    if ([IO.Directory]::Exists($temporary)) {
        if ($script:retainTemporary) { [Console]::Error.WriteLine("Download files retained at $temporary; process cleanup could not be confirmed") }
        else { [IO.Directory]::Delete($temporary, $true) }
    }
}
if ($Mode -eq 'Connect') {
    Write-Host 'The agent runs here in the foreground. Ctrl-C stops it and ends managed terminal tasks. Background deployment belongs to your external process manager.'
    & $pwsh -NoProfile -ExecutionPolicy Bypass -File $public run
    Assert-KitelineExit 'Agent run'
}
