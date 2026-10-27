# Generated with the matching native launcher and current package requirements.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$KitelineArguments = @())
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-KitelineAgent {
    param([string[]]$Arguments)
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or
        -not (($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1 -and $PSVersionTable.PSEdition -eq 'Desktop') -or
            ($PSVersionTable.PSVersion.Major -eq 7 -and $PSVersionTable.PSVersion -ge [version]'7.4')) -or
        [System.Runtime.InteropServices.RuntimeInformation,mscorlib]::ProcessArchitecture -ne 'X64') {
        throw 'Windows x64 and Windows PowerShell 5.1 or PowerShell 7.4+ are required'
    }
    if ($PSVersionTable.PSVersion.Major -eq 5) { Add-Type -AssemblyName System.IO.Compression.FileSystem }
    $program = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) __KITELINE_DIRECTORY_NAME__
    $management = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) __KITELINE_DIRECTORY_NAME__
    $root = if (__KITELINE_MODE__ -eq 'installed') { $program } else { [IO.Directory]::GetParent($PSScriptRoot).FullName }
    $installed = $root.Equals($program, [StringComparison]::OrdinalIgnoreCase)
    $public = Join-Path $management 'kiteline-agent.ps1'
    $recordFile = Join-Path $management __KITELINE_RECORD_FILE__
    $useFile = Join-Path $management 'use.lock'
    $required = __KITELINE_REQUIRED_FILES__
    $nativeSource = @'
__KITELINE_NATIVE_SOURCE__
'@
    if (-not ('__KITELINE_LAUNCHER_TYPE__' -as [type])) {
        if ($PSVersionTable.PSVersion.Major -eq 5) { Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies ([ComponentModel.Win32Exception].Assembly.Location) }
        else { Add-Type -TypeDefinition $nativeSource }
    }
    $errors = [Collections.Generic.List[Exception]]::new()
    $managementLease = $null
    $result = 1
    $originalLocation = Get-Location
    $originalDirectory = [Environment]::CurrentDirectory
    if ($originalLocation.Provider.Name -ne 'FileSystem') { throw 'Run kiteline-agent from a filesystem directory' }
    [Environment]::CurrentDirectory = $originalLocation.ProviderPath
    $guard = [__KITELINE_LAUNCHER_TYPE__]::new()

    function Test-KitelineExists([string]$Path) {
        try { $null = [IO.File]::GetAttributes($Path); return $true }
        catch [IO.FileNotFoundException] { return $false }
        catch [IO.DirectoryNotFoundException] { return $false }
    }
    function Test-KitelineAbsolute([string]$Path) {
        if ($Path.Length -lt 2) { return $false }
        if ($Path[0] -in @('\','/')) { return $Path[1] -in @('\','/','?') }
        return $Path.Length -ge 3 -and $Path[0] -match '^[A-Za-z]$' -and $Path[1] -eq ':' -and $Path[2] -in @('\','/')
    }
    function New-KitelineDirectoryAcl([string]$Path, $Acl) {
        if ($PSVersionTable.PSVersion.Major -eq 5) { [IO.DirectoryInfo]::new($Path).Create($Acl) }
        else { [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($Path), $Acl) }
    }
    function Set-KitelineObjectAcl($Item, $Acl) {
        if ($PSVersionTable.PSVersion.Major -eq 5) { $Item.SetAccessControl($Acl) }
        else { [IO.FileSystemAclExtensions]::SetAccessControl($Item, $Acl) }
    }
    function Assert-KitelineNoReparse([string]$Path) {
        for ($item = [IO.Path]::GetFullPath($Path); $item; $item = [IO.Path]::GetDirectoryName($item)) {
            if ((Test-KitelineExists $item) -and ([IO.File]::GetAttributes($item) -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Installation/state paths cannot traverse a reparse point: $item"
            }
        }
    }
    function Assert-KitelineRelative([string]$Path) {
        if (-not $Path -or $Path.Contains('\') -or $Path.StartsWith('/')) { throw "Invalid package path: $Path" }
        foreach ($part in $Path.Split('/')) {
            if (-not $part -or $part -in @('.', '..') -or $part -match '[. ]$|[<>:"|?*\x00-\x1f]' -or
                $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)') {
                throw "Invalid Windows package path: $Path"
            }
        }
    }
    function Get-KitelineTree([string]$Directory) {
        $files = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
        $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($Directory)
        while ($pending.Count) {
            foreach ($path in [IO.Directory]::EnumerateFileSystemEntries($pending.Pop())) {
                $attributes = [IO.File]::GetAttributes($path)
                if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Links are not allowed in this tree: $path" }
                if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($path) }
                else {
                    $key = $path.Substring($Directory.TrimEnd('\','/').Length + 1).Replace('\', '/')
                    Assert-KitelineRelative $key
                    $files.Add($key, $path)
                }
            }
        }
        return ,$files
    }
    function Get-KitelineHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
    function Test-KitelinePackage([string]$Directory, [string[]]$RequiredFiles) {
        Assert-KitelineNoReparse $Directory
        $files = Get-KitelineTree $Directory
        foreach ($name in $RequiredFiles) {
            if (-not $files.ContainsKey($name)) { throw "Missing required package file: $name" }
        }
        $expected = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($line in [IO.File]::ReadAllLines((Join-Path $Directory 'SHA256SUMS'))) {
            if ($line -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Invalid SHA256SUMS record' }
            $sum = $Matches[1]; $name = $Matches[2]
            Assert-KitelineRelative $name
            if ($name -ieq 'SHA256SUMS') { throw 'SHA256SUMS cannot checksum itself' }
            $expected.Add($name, $sum)
        }
        $null = $files.Remove('SHA256SUMS')
        if ($files.Count -ne $expected.Count) { throw 'Package file set does not match SHA256SUMS' }
        foreach ($name in $files.Keys) {
            if (-not $expected.ContainsKey($name) -or (Get-KitelineHash $files[$name]) -cne $expected[$name]) {
                throw "Package checksum mismatch: $name"
            }
        }
        $release = [IO.File]::ReadAllText((Join-Path $Directory 'release.json')) | ConvertFrom-Json
        $identity = [IO.File]::ReadAllText((Join-Path $Directory 'dist/native/identity.json')) | ConvertFrom-Json
        $application = [IO.File]::ReadAllText((Join-Path $Directory 'shared/dist/version.json')) | ConvertFrom-Json
        if ($release.kind -cne 'agent' -or $release.platform -cne 'windows' -or $release.architecture -cne 'x64' -or
            $release.version -cne $application.version -or $release.version -notmatch '^[0-9A-Za-z.+-]+$' -or
            $identity.linkage -cne 'windows-msys' -or $identity.architecture -cne 'x64' -or $identity.node -cne "v$($release.node)") {
            throw 'A complete Windows x64 agent package with matching current identity is required'
        }
        return $release
    }
    function Expand-KitelineZip([string]$Archive, [string]$Destination, $Guard) {
        $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
        try {
            $entries = [Collections.Generic.List[object]]::new()
            $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            $kinds = [Collections.Generic.Dictionary[string,bool]]::new([StringComparer]::OrdinalIgnoreCase)
            $top = $null
            foreach ($entry in $zip.Entries) {
                $directory = $entry.FullName.EndsWith('/')
                $name = if ($directory) { $entry.FullName.Substring(0, $entry.FullName.Length - 1) } else { $entry.FullName }
                Assert-KitelineRelative $name
                if (-not $seen.Add($name)) { throw "Duplicate ZIP path: $name" }
                $mode = ($entry.ExternalAttributes -shr 16) -band 0xf000
                if (($entry.ExternalAttributes -band 0x400) -or $mode -notin @(0, 0x4000, 0x8000) -or
                    ($mode -eq 0x4000 -and -not $directory) -or ($mode -eq 0x8000 -and $directory)) { throw "Unsupported ZIP entry: $name" }
                $parts = $name.Split('/')
                if ($null -eq $top) { $top = $parts[0] }
                if ($top -cne $parts[0] -or $top -notmatch '^kiteline-agent-[0-9A-Za-z.+-]+-windows-amd64$') { throw 'ZIP must contain one Windows agent package root' }
                for ($index = 0; $index -lt $parts.Length; $index++) {
                    $prefix = [string]::Join('/', $parts[0..$index])
                    $isDirectory = $index -lt $parts.Length - 1 -or $directory
                    if ($kinds.ContainsKey($prefix) -and $kinds[$prefix] -ne $isDirectory) { throw "ZIP file/directory conflict: $prefix" }
                    $kinds[$prefix] = $isDirectory
                }
                if ($parts.Length -eq 1) {
                    if (-not $directory) { throw 'ZIP package root must be a directory' }
                    continue
                }
                $entries.Add(@{ Entry = $entry; Path = [string]::Join('/', $parts[1..($parts.Length - 1)]); Directory = $directory })
            }
            if (-not $entries.Count) { throw 'Empty agent ZIP' }
            foreach ($item in $entries) {
                Test-KitelineCancellation $Guard
                $path = Join-Path $Destination $item.Path
                if ($item.Directory) { $null = [IO.Directory]::CreateDirectory($path); continue }
                $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
                $inputStream = $item.Entry.Open()
                try {
                    $outputStream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
                } finally { $inputStream.Dispose() }
            }
        } finally { $zip.Dispose() }
    }
    function New-KitelineAcl([bool]$Directory, [string]$Sid) {
        $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
        $inherit = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
        foreach ($account in @('S-1-5-18', 'S-1-5-32-544', $Sid) | Where-Object { $_ } | Select-Object -Unique) {
            $rights = if ($account -in @('S-1-5-18', 'S-1-5-32-544')) { 'FullControl' } else { 'ReadAndExecute' }
            $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($account), [Security.AccessControl.FileSystemRights]$rights, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
        }
        return $acl
    }
    function New-KitelinePrivateDirectory([string]$Path) {
        Assert-KitelineNoReparse ([IO.Path]::GetDirectoryName($Path))
        if (Test-KitelineExists $Path) { throw "Preparation directory already exists: $Path" }
        New-KitelineDirectoryAcl $Path (New-KitelineAcl $true '')
    }
    function Assert-KitelineManagement([string]$Management) {
        Assert-KitelineNoReparse $Management
        if (-not (Test-KitelineExists $Management)) {
            New-KitelineDirectoryAcl $Management (New-KitelineAcl $true '')
        }
        $acl = Get-Acl -LiteralPath $Management
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw "Untrusted installation directory owner: $Management" }
        $write = [Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and $rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544')) {
                throw "Installation directory permits untrusted writes: $Management"
            }
        }
    }
    function Set-KitelineTreeAcl([string]$Path, [string]$Sid) {
        $files = Get-KitelineTree $Path
        Set-KitelineObjectAcl ([IO.DirectoryInfo]::new($Path)) (New-KitelineAcl $true $Sid)
        foreach ($file in $files.Values) {
            Set-KitelineObjectAcl ([IO.FileInfo]::new($file)) (New-KitelineAcl $false $Sid)
        }
        foreach ($directory in [IO.Directory]::EnumerateDirectories($Path, '*', [IO.SearchOption]::AllDirectories)) {
            Set-KitelineObjectAcl ([IO.DirectoryInfo]::new($directory)) (New-KitelineAcl $true $Sid)
        }
    }
    function Write-KitelineAtomic([string]$Path, [string]$Contents, [bool]$Overwrite = $true) {
        $pending = "$Path.$([Guid]::NewGuid().ToString('N')).pending"
        try {
            [IO.File]::WriteAllText($pending, $Contents)
            [__KITELINE_LAUNCHER_TYPE__]::PublishFile($pending, $Path, $Overwrite)
        } finally { if ([IO.File]::Exists($pending)) { [IO.File]::Delete($pending) } }
    }
    function Read-KitelineInstallation([string]$RecordFile) {
        if (-not (Test-KitelineExists $RecordFile)) { return $null }
        $value = [IO.File]::ReadAllText($RecordFile) | ConvertFrom-Json
        $null = [Security.Principal.SecurityIdentifier]::new($value.sid)
        foreach ($key in @('home', 'dataDir', 'runDir')) {
            if (-not (Test-KitelineAbsolute $value.$key)) { throw "Invalid installation $key" }
        }
        if (-not $value.user) { throw 'Invalid installation user' }
        return $value
    }
    function New-KitelineInstallation([string]$User, [string]$Data, [string]$Run) {
        if (-not $User) { throw 'Usage: kiteline-agent.ps1 install --user PROJECT_USER [--data-dir PATH] [--run-dir PATH]' }
        $sid = [Security.Principal.NTAccount]::new($User).Translate([Security.Principal.SecurityIdentifier]).Value
        $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey("SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid")
        if (-not $key) { throw 'The project user must have an initialized Windows profile' }
        try { $profile = [string]$key.GetValue('ProfileImagePath') } finally { $key.Dispose() }
        if (-not (Test-KitelineAbsolute $profile) -or -not [IO.Directory]::Exists($profile)) { throw 'The recorded project profile is unavailable' }
        if (-not $Data) {
            if ($sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
            else {
                $userKey = [Microsoft.Win32.Registry]::Users.OpenSubKey("$sid\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
                if (-not $userKey) { throw 'Target LocalAppData is unavailable; specify --data-dir and --run-dir explicitly' }
                try { $local = [string]$userKey.GetValue('Local AppData', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
                finally { $userKey.Dispose() }
                $local = [Regex]::Replace($local, '%USERPROFILE%', [Text.RegularExpressions.MatchEvaluator]{ param($match) $profile }, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            }
            if (-not (Test-KitelineAbsolute $local) -or $local.Contains('%')) { throw 'Target LocalAppData is unresolved; specify --data-dir explicitly' }
            $Data = Join-Path $local 'kiteline-agent'
        }
        if (-not (Test-KitelineAbsolute $Data)) { throw '--data-dir must be absolute' }
        if (-not $Run) { $Run = Join-Path $Data 'run' }
        if (-not (Test-KitelineAbsolute $Run)) { throw '--run-dir must be absolute' }
        Assert-KitelineNoReparse $Data; Assert-KitelineNoReparse $Run
        return [ordered]@{ user = $User; sid = $sid; home = $profile; dataDir = [IO.Path]::GetFullPath($Data); runDir = [IO.Path]::GetFullPath($Run) }
    }
    function Lock-KitelineState($Installation, $Guard) {
        if (-not (Test-KitelineExists $Installation.dataDir)) { return $null }
        Assert-KitelineNoReparse $Installation.dataDir
        $path = Join-Path $Installation.dataDir 'process.lock'
        $file = [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
        $file.Dispose()
        return $Guard.Lock($path, $false)
    }
    function Close-KitelineLease($Lease, [Collections.Generic.List[Exception]]$Errors) {
        if ($null -eq $Lease) { return }
        try { $Lease.Dispose() }
        catch { $Errors.Add($_.Exception) }
    }
    function Test-KitelineCancellation($Guard) {
        if ($Guard.Interrupted) { throw "Installation preparation cancelled (console status $($Guard.Interrupted))" }
    }
    function Invoke-KitelineNode([string]$Directory, [string[]]$NodeArguments, $Guard) {
        $rootJson = ConvertTo-Json $Directory -Compress
        $saved = @{}
        foreach ($key in __KITELINE_NODE_ENVIRONMENT_KEYS__) {
            $value = [Environment]::GetEnvironmentVariable($key)
            if ($null -ne $value) { $saved[$key] = $value }
        }
        $environmentJson = ConvertTo-Json $saved -Compress
        $bootstrap = @"
const path = require('node:path');
const url = require('node:url');
const root = $rootJson;

Object.assign(process.env, $environmentJson);
process.argv.splice(1, 0, path.join(root, 'agent/dist/main.js'));
import(url.pathToFileURL(process.argv[1]).href).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"@
        try {
            foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $null) }
            return $Guard.Run((Join-Path $Directory 'runtime/bin/node.exe'), $bootstrap, $NodeArguments, $Directory)
        } finally {
            foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
        }
    }
    function Update-KitelineMachinePath([string]$Program, [bool]$Present) {
        $directory = Join-Path $Program 'command'
        $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
        try {
            $raw = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
            $parts = @($raw.Split(';'))
            if ($Present) {
                if ($parts -icontains $directory) { return }
                $parts += $directory
            } else {
                $parts = @($parts | Where-Object { -not $_.Equals($directory, [StringComparison]::OrdinalIgnoreCase) })
            }
            $next = $parts -join ';'
            if ($next -cne $raw) { $key.SetValue('Path', $next, $kind) }
        } finally { $key.Dispose() }
    }
    function Remove-KitelineDirectory([string]$Path, [bool]$Recursive) {
        try { [IO.Directory]::Delete($Path, $Recursive) }
        catch { throw [IO.IOException]::new("Cannot remove directory ${Path}: $($_.Exception.Message)", $_.Exception) }
    }
    function Remove-KitelineTree([string]$Path) {
        if (-not (Test-KitelineExists $Path)) { return }
        Assert-KitelineNoReparse $Path
        $null = Get-KitelineTree $Path
        Remove-KitelineDirectory $Path $true
    }
    function Initialize-KitelineMaintenanceDirectory([string]$Program, [string]$Temporary) {
        # Move PowerShell's location and the process working directory outside the program
        # tree so it can be replaced or deleted.
        $safeDirectory = [IO.Path]::GetPathRoot($Program)
        Set-Location -LiteralPath $safeDirectory
        [Environment]::CurrentDirectory = $safeDirectory
        New-KitelinePrivateDirectory $Temporary
    }
    function New-KitelineUseFile([string]$Path) {
        if (-not [IO.File]::Exists($Path)) {
            $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew)
            $file.Dispose()
        }
    }
    function Remove-KitelineMaintenanceDirectory {
        param(
            [string]$Temporary,
            [string]$Previous,
            [Collections.Generic.List[Exception]]$Errors
        )
        if (-not $Temporary) { return }
        try {
            if ($Previous -and (Test-KitelineExists $Previous)) {
                [Console]::Error.WriteLine("Previous program files retained at $Previous")
            } else { Remove-KitelineTree $Temporary }
        } catch {
            $Errors.Add($_.Exception)
            [Console]::Error.WriteLine("Maintenance files retained at $Temporary")
        }
    }

    function Install-KitelineAgent {
        param(
            [string]$Root,
            [string]$Program,
            [string]$Management,
            [string]$Public,
            [string]$RecordFile,
            [string]$UseFile,
            [string[]]$RequiredFiles,
            $Installation,
            [string]$User,
            [string]$DataDir,
            [string]$RunDir,
            [bool]$FromInstalledEntry,
            $Guard,
            [Collections.Generic.List[Exception]]$Errors
        )
        $preparationLease = $null
        $temporary = $null
        try {
            $requested = New-KitelineInstallation $User $DataDir $RunDir
            if ($Installation -and $Installation.sid -cne $requested.sid) {
                throw "Current installation belongs to $($Installation.user)"
            }
            Assert-KitelineNoReparse $Program
            if ($FromInstalledEntry -or $Installation) {
                $preparationLease = $Guard.Lock($UseFile, $true)
            }
            if ($Installation) {
                $sourceRelease = Get-Content -Raw -LiteralPath (Join-Path $Root 'release.json') | ConvertFrom-Json
                $oldRelease = Get-Content -Raw -LiteralPath (Join-Path $Program 'release.json') | ConvertFrom-Json
                if ($sourceRelease.version -cne $oldRelease.version) {
                    throw 'A different version is installed; explicitly run upgrade first'
                }
                Write-Host 'The same version is already installed; identity, configuration and running tasks were not changed.'
                return 0
            }
            foreach ($path in @($Program, $Public, $RecordFile)) {
                if (Test-KitelineExists $path) { throw "$path already exists; inspect it before installing" }
            }
            $Installation = $requested
            Assert-KitelineNoReparse $Root

            $temporary = Join-Path ([IO.Path]::GetDirectoryName($Program)) ".kiteline-maintenance-$([Guid]::NewGuid().ToString('N'))"
            Initialize-KitelineMaintenanceDirectory -Program $Program -Temporary $temporary
            $replacement = Join-Path $temporary 'new'
            New-KitelinePrivateDirectory $replacement
            $sourceFiles = Get-KitelineTree $Root
            foreach ($directory in [IO.Directory]::EnumerateDirectories($Root, '*', [IO.SearchOption]::AllDirectories)) {
                $relative = $directory.Substring($Root.TrimEnd('\','/').Length + 1)
                $null = [IO.Directory]::CreateDirectory((Join-Path $replacement $relative))
            }
            foreach ($name in $sourceFiles.Keys) {
                Test-KitelineCancellation $Guard
                $target = Join-Path $replacement $name
                $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
                [IO.File]::Copy($sourceFiles[$name], $target, $false)
            }
            $release = Test-KitelinePackage $replacement $RequiredFiles
            $newPublic = [IO.File]::ReadAllText((Join-Path $replacement 'bin/kiteline-agent-installed.ps1'))
            if ((Invoke-KitelineNode $replacement @('--version') $Guard) -ne 0) {
                throw 'Prepared package could not start native Node'
            }
            Set-KitelineTreeAcl $replacement $Installation.sid
            Close-KitelineLease $preparationLease $Errors
            $preparationLease = $null
            Test-KitelineCancellation $Guard
            if ($Errors.Count) { throw 'Preparation cleanup failed; no installation change attempted' }
            New-KitelineUseFile $UseFile
            Test-KitelineCancellation $Guard

            $movedNew = $false
            $wroteRecord = $false
            try {
                [IO.Directory]::Move($replacement, $Program)
                $movedNew = $true
                Write-KitelineAtomic $RecordFile ($Installation | ConvertTo-Json -Compress) $false
                $wroteRecord = $true
                Write-KitelineAtomic $Public $newPublic
                Set-KitelineTreeAcl $Management $Installation.sid
                Update-KitelineMachinePath $Program $true
            } catch {
                $primary = $_.Exception
                try {
                    if ($movedNew) { [IO.Directory]::Move($Program, $replacement) }
                    if ($wroteRecord) { [IO.File]::Delete($RecordFile) }
                    if ($movedNew) { [IO.File]::Delete($Public) }
                } catch {
                    throw [AggregateException]::new('Installation and rollback failed', [Exception[]]@($primary, $_.Exception))
                }
                throw $primary
            }
            [__KITELINE_LAUNCHER_TYPE__]::NotifyEnvironment()
            Write-Host "Installed version $($release.version); not started. As $($Installation.user), run kiteline-agent run in a new non-elevated PowerShell window."
            return 0
        } catch {
            $Errors.Add($_.Exception)
            return 1
        } finally {
            Remove-KitelineMaintenanceDirectory -Temporary $temporary -Errors $Errors
            Close-KitelineLease $preparationLease $Errors
        }
    }

    function Upgrade-KitelineAgent {
        param(
            [string]$Program,
            [string]$Public,
            [string]$UseFile,
            [string[]]$RequiredFiles,
            $Installation,
            [string]$Archive,
            [bool]$Yes,
            [bool]$FromInstalledEntry,
            $Guard,
            [Collections.Generic.List[Exception]]$Errors
        )
        $preparationLease = $null
        $useLease = $null
        $temporary = $null
        $previous = $null
        try {
            if (-not $Installation) { throw 'kiteline-agent is not installed' }
            Assert-KitelineNoReparse $Program
            if ($FromInstalledEntry) { $preparationLease = $Guard.Lock($UseFile, $true) }
            $temporary = Join-Path ([IO.Path]::GetDirectoryName($Program)) ".kiteline-maintenance-$([Guid]::NewGuid().ToString('N'))"
            Initialize-KitelineMaintenanceDirectory -Program $Program -Temporary $temporary
            $replacement = Join-Path $temporary 'new'
            $previous = Join-Path $temporary 'previous'
            if (-not $Archive) { throw 'Usage: kiteline-agent.ps1 upgrade --archive RELEASE.zip [--yes]' }
            $checksum = [IO.File]::ReadAllText("$Archive.sha256").Trim().Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[0]
            $inputArchive = Join-Path $temporary 'input.zip'
            [IO.File]::Copy($Archive, $inputArchive, $false)
            if ($checksum -notmatch '^[a-fA-F0-9]{64}$' -or (Get-KitelineHash $inputArchive) -ine $checksum) {
                throw 'Package SHA256 verification failed'
            }
            New-KitelinePrivateDirectory $replacement
            Expand-KitelineZip $inputArchive $replacement $Guard
            $release = Test-KitelinePackage $replacement $RequiredFiles
            $newPublic = [IO.File]::ReadAllText((Join-Path $replacement 'bin/kiteline-agent-installed.ps1'))
            if ((Invoke-KitelineNode $replacement @('--version') $Guard) -ne 0) {
                throw 'Prepared package could not start native Node'
            }
            Set-KitelineTreeAcl $replacement $Installation.sid
            Close-KitelineLease $preparationLease $Errors
            $preparationLease = $null
            Test-KitelineCancellation $Guard
            if ($Errors.Count) { throw 'Preparation cleanup failed; no installation change attempted' }
            Write-Host "Install version $($release.version), retaining state at $($Installation.dataDir)? No external manager will be controlled."
            if (-not $Yes -and -not $Guard.Confirm('Type yes to continue: ')) { throw 'Cancelled' }
            Test-KitelineCancellation $Guard
            New-KitelineUseFile $UseFile
            $useLease = $Guard.Lock($UseFile, $false)
            $oldPublic = [IO.File]::ReadAllText($Public)
            Test-KitelineCancellation $Guard

            $movedNew = $false
            $movedOld = $false
            $publishedNew = $false
            try {
                [IO.Directory]::Move($Program, $previous)
                $movedOld = $true
                [IO.Directory]::Move($replacement, $Program)
                $movedNew = $true
                Write-KitelineAtomic $Public $newPublic
                $publishedNew = $true
                Update-KitelineMachinePath $Program $true
            } catch {
                $primary = $_.Exception
                try {
                    if ($movedNew) { [IO.Directory]::Move($Program, $replacement) }
                    if ($movedOld) { [IO.Directory]::Move($previous, $Program) }
                    if ($publishedNew) { Write-KitelineAtomic $Public $oldPublic }
                } catch {
                    throw [AggregateException]::new('Installation and rollback failed', [Exception[]]@($primary, $_.Exception))
                }
                throw $primary
            }
            [__KITELINE_LAUNCHER_TYPE__]::NotifyEnvironment()
            try { Remove-KitelineTree $previous }
            catch {
                throw [IO.IOException]::new("Upgrade applied, but cleanup of previous program files failed at ${previous}: $($_.Exception.Message)", $_.Exception)
            }
            Write-Host "Installed version $($release.version); not started. As $($Installation.user), run kiteline-agent run in a new non-elevated PowerShell window."
            return 0
        } catch {
            $Errors.Add($_.Exception)
            return 1
        } finally {
            Remove-KitelineMaintenanceDirectory -Temporary $temporary -Previous $previous -Errors $Errors
            Close-KitelineLease $useLease $Errors
            Close-KitelineLease $preparationLease $Errors
        }
    }

    function Uninstall-KitelineAgent {
        param(
            [string]$Program,
            [string]$Management,
            [string]$Public,
            [string]$RecordFile,
            [string]$UseFile,
            [string]$ManagementFile,
            $Installation,
            [bool]$Yes,
            [bool]$Purge,
            [bool]$FromInstalledEntry,
            $Guard,
            [ref]$ManagementLease,
            [Collections.Generic.List[Exception]]$Errors
        )
        $purgeManagementLease = $null
        $preparationLease = $null
        $useLease = $null
        $stateLease = $null
        $temporary = $null
        $previous = $null
        try {
            if ($Purge) {
                $purgeManagementLease = $ManagementLease.Value
                $ManagementLease.Value = $null
            }
            if (-not $Installation) { throw 'kiteline-agent is not installed' }
            Assert-KitelineNoReparse $Program
            if ($FromInstalledEntry) { $preparationLease = $Guard.Lock($UseFile, $true) }
            $temporary = Join-Path ([IO.Path]::GetDirectoryName($Program)) ".kiteline-maintenance-$([Guid]::NewGuid().ToString('N'))"
            Initialize-KitelineMaintenanceDirectory -Program $Program -Temporary $temporary
            $previous = Join-Path $temporary 'previous'
            Close-KitelineLease $preparationLease $Errors
            $preparationLease = $null
            Test-KitelineCancellation $Guard
            if ($Errors.Count) { throw 'Preparation cleanup failed; no installation change attempted' }
            $scope = if ($Purge) { 'delete entire recorded agent data and runtime directories' } else { 'retain all state' }
            $runtime = if ($Purge) { '; runtime at ' + $Installation.runDir } else { '' }
            Write-Host "Remove the program; $scope at $($Installation.dataDir)${runtime}? No external manager will be controlled."
            if (-not $Yes -and -not $Guard.Confirm('Type yes to continue: ')) { throw 'Cancelled' }
            Test-KitelineCancellation $Guard
            New-KitelineUseFile $UseFile
            $useLease = $Guard.Lock($UseFile, $false)
            if ($Purge) { $stateLease = Lock-KitelineState $Installation $Guard }
            Test-KitelineCancellation $Guard
            if ($Purge -and $Installation.dataDir.TrimEnd('\').StartsWith($Installation.runDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw "Cannot purge: runtime directory $($Installation.runDir) contains data directory $($Installation.dataDir); use default uninstall or separate these directories first"
            }
            Update-KitelineMachinePath $Program $false
            [__KITELINE_LAUNCHER_TYPE__]::NotifyEnvironment()
            if ($Purge) {
                if ($Installation.runDir.TrimEnd('\') -ine $Installation.dataDir.TrimEnd('\') -and
                    -not $Installation.runDir.StartsWith($Installation.dataDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    Remove-KitelineTree $Installation.runDir
                }
                if ($null -ne $stateLease) {
                    $null = Get-KitelineTree $Installation.dataDir
                    foreach ($item in [IO.Directory]::EnumerateFileSystemEntries($Installation.dataDir)) {
                        if ([IO.Path]::GetFileName($item) -ieq 'process.lock') { continue }
                        if ([IO.Directory]::Exists($item)) { Remove-KitelineDirectory $item $true }
                        else { [IO.File]::Delete($item) }
                    }
                    $stateLease.Dispose()
                    $stateLease = $null
                    [IO.File]::Delete((Join-Path $Installation.dataDir 'process.lock'))
                    Remove-KitelineDirectory $Installation.dataDir $false
                }
            }
            [IO.Directory]::Move($Program, $previous)
            [IO.File]::Delete($Public)
            [IO.File]::Delete($RecordFile)
            try { Remove-KitelineTree $previous }
            catch {
                throw [IO.IOException]::new("Program entry points and installation record removed, but cleanup of previous program files failed at ${previous}: $($_.Exception.Message)", $_.Exception)
            }
            if ($Purge) {
                $useLease.Dispose()
                $useLease = $null
                [IO.File]::Delete($UseFile)
                $purgeManagementLease.Dispose()
                $purgeManagementLease = $null
                [IO.File]::Delete($ManagementFile)
                if ([IO.Directory]::GetFileSystemEntries($Management).Length -eq 0) {
                    Remove-KitelineDirectory $Management $false
                }
            }
            Write-Host 'Uninstalled.'
            return 0
        } catch {
            $Errors.Add($_.Exception)
            return 1
        } finally {
            Remove-KitelineMaintenanceDirectory -Temporary $temporary -Previous $previous -Errors $Errors
            Close-KitelineLease $stateLease $Errors
            Close-KitelineLease $useLease $Errors
            Close-KitelineLease $preparationLease $Errors
            Close-KitelineLease $purgeManagementLease $Errors
        }
    }

    try {
        $action = if ($Arguments.Count) { $Arguments[0] } else { '--help' }
        if ($action -notin @('install', 'upgrade', 'uninstall')) {
            $useLease = $null
            try {
                if ($installed) {
                    $useLease = $guard.Lock($useFile, $true)
                    if (-not (Read-KitelineInstallation $recordFile)) { throw "Broken installation: $recordFile is missing" }
                }
                $result = Invoke-KitelineNode $root $Arguments $guard
            } catch {
                $errors.Add($_.Exception)
            } finally { Close-KitelineLease $useLease $errors }
        } else {
            $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
            if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
                throw 'Installation changes require an elevated PowerShell; bind and run as the project user'
            }
            $options = @{}
            for ($i = 1; $i -lt $Arguments.Count; $i++) {
                $name = $Arguments[$i]
                if ($options.ContainsKey($name)) { throw "Duplicate option: $name" }
                if (($action -in @('upgrade', 'uninstall') -and $name -eq '--yes') -or
                    ($action -eq 'uninstall' -and $name -eq '--purge')) {
                    $options[$name] = $true
                } elseif (($action -eq 'install' -and $name -in @('--user', '--data-dir', '--run-dir')) -or
                    ($action -eq 'upgrade' -and $name -eq '--archive')) {
                    if (++$i -ge $Arguments.Count) { throw "Missing value: $name" }
                    $options[$name] = $Arguments[$i]
                } else { throw "Unknown $action option: $name" }
            }
            if ($options['--archive']) { $options['--archive'] = [IO.Path]::GetFullPath($options['--archive']) }
            Assert-KitelineManagement $management
            $managementFile = Join-Path $management 'management.lock'
            $file = [IO.File]::Open($managementFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
            $file.Dispose()
            $managementLease = $guard.Lock($managementFile, $false)
            $installation = Read-KitelineInstallation $recordFile
            switch ($action) {
                'install' {
                    $result = Install-KitelineAgent -Root $root -Program $program -Management $management `
                        -Public $public -RecordFile $recordFile -UseFile $useFile -RequiredFiles $required `
                        -Installation $installation -User $options['--user'] -DataDir $options['--data-dir'] `
                        -RunDir $options['--run-dir'] -FromInstalledEntry $installed -Guard $guard -Errors $errors
                }
                'upgrade' {
                    $result = Upgrade-KitelineAgent -Program $program -Public $public -UseFile $useFile `
                        -RequiredFiles $required -Installation $installation -Archive $options['--archive'] `
                        -Yes ([bool]$options['--yes']) -FromInstalledEntry $installed -Guard $guard -Errors $errors
                }
                'uninstall' {
                    $result = Uninstall-KitelineAgent -Program $program -Management $management `
                        -Public $public -RecordFile $recordFile -UseFile $useFile -ManagementFile $managementFile `
                        -Installation $installation -Yes ([bool]$options['--yes']) -Purge ([bool]$options['--purge']) `
                        -FromInstalledEntry $installed -Guard $guard -ManagementLease ([ref]$managementLease) -Errors $errors
                }
            }
        }
    } catch {
        $errors.Add($_.Exception)
    } finally {
        Close-KitelineLease $managementLease $errors
        $interrupted = $guard.Interrupted
        Close-KitelineLease $guard $errors
        if ([IO.Directory]::Exists($originalLocation.ProviderPath)) { Set-Location -LiteralPath $originalLocation.ProviderPath }
        if ([IO.Directory]::Exists($originalDirectory)) { [Environment]::CurrentDirectory = $originalDirectory }
    }
    foreach ($error in $errors) { [Console]::Error.WriteLine($error.ToString()) }
    if ($errors.Count) { return 1 }
    if ($interrupted) { return $interrupted }
    return $result
}

exit (Invoke-KitelineAgent -Arguments @($KitelineArguments))
