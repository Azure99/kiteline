# Generated with the matching native launcher and current package requirements.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$KitelineArguments = @())
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-KitelineAgent {
    param([string[]]$Arguments)
    if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64' -or $PSVersionTable.PSVersion.Major -lt 7) {
        throw 'Windows x64 and PowerShell 7 are required'
    }
    $program = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'kiteline-agent'
    $management = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'kiteline-agent'
    $root = __KITELINE_PACKAGE_ROOT__
    $installed = $root.Equals($program, [StringComparison]::OrdinalIgnoreCase)
    $public = Join-Path $management 'kiteline-agent.ps1'
    $recordFile = Join-Path $management 'installation.json'
    $useFile = Join-Path $management 'use.lock'
    $required = __KITELINE_REQUIRED_FILES__
    $componentRequired = __KITELINE_COMPONENT_FILES__
    $nativeSource = @'
__KITELINE_NATIVE_SOURCE__
'@
    if (-not ('__KITELINE_LAUNCHER_TYPE__' -as [type])) { Add-Type -TypeDefinition $nativeSource }
    $errors = [Collections.Generic.List[Exception]]::new()
    $shared = $null; $exclusive = $null; $manager = $null; $state = $null
    $temporary = $null; $previous = $null; $result = 1
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
                    $key = [IO.Path]::GetRelativePath($Directory, $path).Replace('\', '/')
                    Assert-KitelineRelative $key
                    $files.Add($key, $path)
                }
            }
        }
        return ,$files
    }
    function Get-KitelineHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
    function Test-KitelinePackage([string]$Directory) {
        Assert-KitelineNoReparse $Directory
        $files = Get-KitelineTree $Directory
        foreach ($name in $required) {
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
        $release = [IO.File]::ReadAllText((Join-Path $Directory 'release.json')) | ConvertFrom-Json -AsHashtable
        $identity = [IO.File]::ReadAllText((Join-Path $Directory 'dist/native/identity.json')) | ConvertFrom-Json -AsHashtable
        $application = [IO.File]::ReadAllText((Join-Path $Directory 'shared/dist/version.json')) | ConvertFrom-Json -AsHashtable
        if ($release.kind -cne 'agent' -or $release.platform -cne 'windows' -or $release.architecture -cne 'x64' -or
            $release.version -cne $application.version -or $release.version -notmatch '^[0-9A-Za-z.+-]+$' -or
            $release.sourceDigest -notmatch '^[a-f0-9]{64}$' -or $release.lockfile -notmatch '^[a-f0-9]{64}$' -or
            $identity.linkage -cne 'windows-msys' -or $identity.architecture -cne 'x64' -or $identity.node -cne "v$($release.node)" -or
            ($identity | ConvertTo-Json -Depth 100 -Compress) -cne ($release.native | ConvertTo-Json -Depth 100 -Compress)) {
            throw 'A complete Windows x64 agent package with matching current identity is required'
        }
        foreach ($name in $componentRequired) {
            if (-not $identity.files.Contains($name)) { throw "Missing required component identity: $name" }
        }
        $sources = @($identity.inputs.downloads.Keys | Where-Object { $_.StartsWith('sources/') })
        if (-not $sources.Count) { throw 'Windows component identity has no corresponding source catalog' }
        $recipe = [IO.File]::ReadAllText((Join-Path $Directory 'dist/native/sources/recipe/deploy/agent-windows.json')) | ConvertFrom-Json -AsHashtable
        if ($sources.Count -ne $recipe.sources.Count) { throw 'Corresponding source catalog does not match its build recipe' }
        foreach ($name in $recipe.sources.Keys) {
            $source = $recipe.sources[$name]
            $inputSource = $identity.inputs.downloads["sources/$name"]
            if (-not $inputSource -or $inputSource.sha256 -cne $source.sha256 -or $inputSource.url -cne $source.url -or
                $identity.files["native/sources/$name"] -cne $source.sha256) { throw "Corresponding source does not match its build recipe: $name" }
        }
        foreach ($source in $sources) {
            if (-not $identity.files.Contains("native/$source")) { throw "Missing corresponding source: $source" }
        }
        foreach ($name in $identity.files.Keys) {
            Assert-KitelineRelative $name
            if ($name -cnotmatch '^(native|runtime)/') { throw "Invalid component path: $name" }
            $target = if ($name.StartsWith('native/')) { "dist/$name" } else { $name }
            if (-not $expected.ContainsKey($target) -or $expected[$target] -cne $identity.files[$name]) {
                throw "Component checksum does not match the package: $name"
            }
        }
        $componentCount = 0
        foreach ($name in $files.Keys) {
            if ($name -ceq 'dist/native/identity.json') { continue }
            $key = if ($name.StartsWith('dist/native/')) { $name.Substring(5) } elseif ($name.StartsWith('runtime/')) { $name } else { continue }
            if (-not $identity.files.Contains($key)) { throw "Unregistered component file: $name" }
            $componentCount++
        }
        if ($componentCount -ne $identity.files.Count) { throw 'Component file set does not match identity' }
        return $release
    }
    function Expand-KitelineZip([string]$Archive, [string]$Destination) {
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
                Test-KitelineCancellation
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
        $null = [IO.FileSystemAclExtensions]::CreateDirectory((New-KitelineAcl $true ''), $Path)
    }
    function Assert-KitelineManagement {
        Assert-KitelineNoReparse $management
        if (-not (Test-KitelineExists $management)) {
            $null = [IO.FileSystemAclExtensions]::CreateDirectory((New-KitelineAcl $true ''), $management)
        }
        $acl = Get-Acl -LiteralPath $management
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw "Untrusted installation directory owner: $management" }
        $write = [Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and $rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544')) {
                throw "Installation directory permits untrusted writes: $management"
            }
        }
    }
    function Set-KitelineTreeAcl([string]$Path, [string]$Sid) {
        $files = Get-KitelineTree $Path
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), (New-KitelineAcl $true $Sid))
        foreach ($file in $files.Values) {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($file), (New-KitelineAcl $false $Sid))
        }
        foreach ($directory in [IO.Directory]::EnumerateDirectories($Path, '*', [IO.SearchOption]::AllDirectories)) {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($directory), (New-KitelineAcl $true $Sid))
        }
    }
    function Write-KitelineAtomic([string]$Path, [string]$Contents, [bool]$Overwrite = $true) {
        $pending = "$Path.$([Guid]::NewGuid().ToString('N')).pending"
        try {
            [IO.File]::WriteAllText($pending, $Contents)
            [IO.File]::Move($pending, $Path, $Overwrite)
        } finally { if ([IO.File]::Exists($pending)) { [IO.File]::Delete($pending) } }
    }
    function Read-KitelineInstallation {
        if (-not (Test-KitelineExists $recordFile)) { return $null }
        $value = [IO.File]::ReadAllText($recordFile) | ConvertFrom-Json -AsHashtable
        $null = [Security.Principal.SecurityIdentifier]::new($value.sid)
        foreach ($key in @('home', 'dataDir', 'runDir')) {
            if (-not [IO.Path]::IsPathFullyQualified($value[$key])) { throw "Invalid installation $key" }
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
        if (-not [IO.Path]::IsPathFullyQualified($profile) -or -not [IO.Directory]::Exists($profile)) { throw 'The recorded project profile is unavailable' }
        if (-not $Data) {
            if ($sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
            else {
                $userKey = [Microsoft.Win32.Registry]::Users.OpenSubKey("$sid\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
                if (-not $userKey) { throw 'Target LocalAppData is unavailable; specify --data-dir and --run-dir explicitly' }
                try { $local = [string]$userKey.GetValue('Local AppData', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
                finally { $userKey.Dispose() }
                $local = $local.Replace('%USERPROFILE%', $profile, [StringComparison]::OrdinalIgnoreCase)
            }
            if (-not [IO.Path]::IsPathFullyQualified($local) -or $local.Contains('%')) { throw 'Target LocalAppData is unresolved; specify --data-dir explicitly' }
            $Data = Join-Path $local 'kiteline-agent'
        }
        if (-not [IO.Path]::IsPathFullyQualified($Data)) { throw '--data-dir must be absolute' }
        if (-not $Run) { $Run = Join-Path $Data 'run' }
        if (-not [IO.Path]::IsPathFullyQualified($Run)) { throw '--run-dir must be absolute' }
        Assert-KitelineNoReparse $Data; Assert-KitelineNoReparse $Run
        return [ordered]@{ user = $User; sid = $sid; home = $profile; dataDir = [IO.Path]::GetFullPath($Data); runDir = [IO.Path]::GetFullPath($Run) }
    }
    function Lock-KitelineState($Installation) {
        if (-not (Test-KitelineExists $Installation.dataDir)) { return $null }
        Assert-KitelineNoReparse $Installation.dataDir
        $path = Join-Path $Installation.dataDir 'process.lock'
        $file = [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
        $file.Dispose()
        return $guard.Lock($path, $false)
    }
    function Close-KitelineLease($Lease) {
        if ($null -eq $Lease) { return }
        $failure = $null
        for (;;) {
            try { $Lease.Dispose(); break }
            catch {
                if ($null -eq $failure) {
                    $failure = $_.Exception; $errors.Add($failure)
                    [Console]::Error.WriteLine("Cleanup failed; retaining ownership: $($failure.Message)")
                }
                [Threading.Thread]::Sleep(10)
            }
        }
    }
    function Test-KitelineCancellation {
        if ($guard.Interrupted) { throw "Installation preparation cancelled (console status $($guard.Interrupted))" }
    }
    function Invoke-KitelineNode([string]$Directory, [string[]]$NodeArguments, [bool]$ProtectInstallation) {
        $rootJson = ConvertTo-Json $Directory -Compress
        $lockJson = if ($ProtectInstallation) { ConvertTo-Json $useFile -Compress } else { 'null' }
        $saved = @{}
        foreach ($key in @('NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_ICU_DATA','NODE_REDIRECT_WARNINGS','NODE_V8_COVERAGE','OPENSSL_CONF')) {
            $value = [Environment]::GetEnvironmentVariable($key)
            if ($null -ne $value) { $saved[$key] = $value }
        }
        $environmentJson = ConvertTo-Json $saved -Compress
        $bootstrap = @"
const path=require('node:path'),url=require('node:url'),root=$rootJson;
const native=require(path.join(root,'dist/native/kiteline-windows.node'));
const pin=native.adoptPin('__KITELINE_PIN__');
const lockPath=$lockJson,lease=lockPath ? native.lock(lockPath,true) : null;
process.once('exit',()=>{if(lease)native.closeHandle(lease);native.closeHandle(pin);});
Object.assign(process.env,$environmentJson);
process.argv.splice(1,0,path.join(root,'agent/dist/main.js'));
import(url.pathToFileURL(process.argv[1]).href).catch(error=>{console.error(error);process.exitCode=1;});
"@
        try {
            foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $null) }
            return $guard.Run((Join-Path $Directory 'runtime/bin/node.exe'), $bootstrap, $NodeArguments, $Directory)
        } finally {
            foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
        }
    }
    function Remove-KitelineTree([string]$Path) {
        if (-not (Test-KitelineExists $Path)) { return }
        Assert-KitelineNoReparse $Path
        $null = Get-KitelineTree $Path
        [IO.Directory]::Delete($Path, $true)
    }

    try {
        $action = if ($Arguments.Count) { $Arguments[0] } else { '--help' }
        if ($action -notin @('install', 'upgrade', 'uninstall')) {
            if ($installed) {
                $shared = $guard.Lock($useFile, $true)
                if (-not (Read-KitelineInstallation)) { throw "Broken installation: $recordFile is missing" }
            }
            $result = Invoke-KitelineNode $root $Arguments $installed
        } else {
            $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
            if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Installation changes require an elevated PowerShell; bind and run as the project user' }
            $options = @{}
            for ($i = 1; $i -lt $Arguments.Count; $i++) {
                $name = $Arguments[$i]
                if ($options.ContainsKey($name)) { throw "Duplicate option: $name" }
                if (($action -in @('upgrade', 'uninstall') -and $name -eq '--yes') -or ($action -eq 'uninstall' -and $name -eq '--purge-state')) { $options[$name] = $true }
                elseif (($action -eq 'install' -and $name -in @('--user', '--data-dir', '--run-dir')) -or ($action -eq 'upgrade' -and $name -eq '--archive')) {
                    if (++$i -ge $Arguments.Count) { throw "Missing value: $name" }
                    $options[$name] = $Arguments[$i]
                } else { throw "Unknown $action option: $name" }
            }
            if ($options['--archive']) { $options['--archive'] = [IO.Path]::GetFullPath($options['--archive']) }
            Assert-KitelineManagement
            $managementFile = Join-Path $management 'management.lock'
            $file = [IO.File]::Open($managementFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite); $file.Dispose()
            $manager = $guard.Lock($managementFile, $false)
            $installation = Read-KitelineInstallation
            if ($action -eq 'install') {
                $requested = New-KitelineInstallation $options['--user'] $options['--data-dir'] $options['--run-dir']
                if ($installation -and $installation.sid -cne $requested.sid) { throw "Current installation belongs to $($installation.user)" }
            } elseif (-not $installation) { throw 'kiteline-agent is not installed' }
            Assert-KitelineNoReparse $program
            if ($installed) { $shared = $guard.Lock($useFile, $true) }
            if ($action -eq 'install' -and $installation) {
                if (-not $shared) { $shared = $guard.Lock($useFile, $true) }
                $sourceRelease = Test-KitelinePackage $root
                $oldRelease = Test-KitelinePackage $program
                if ($sourceRelease.version -cne $oldRelease.version) { throw 'A different version is installed; explicitly run upgrade first' }
                if ([IO.File]::ReadAllText($public) -cne [IO.File]::ReadAllText((Join-Path $program 'bin/kiteline-agent-installed.ps1'))) { throw 'Broken installed public launcher' }
                Write-Host 'The same version is already installed; identity, configuration and running tasks were not changed.'
                $result = 0
            } else {
                if ($action -eq 'install') {
                    foreach ($path in @($program, $public, $recordFile)) { if (Test-KitelineExists $path) { throw "$path already exists; inspect it before installing" } }
                    $installation = $requested
                    $null = Test-KitelinePackage $root
                }
                # All maintenance code is already resident in this system PowerShell process.
                Set-Location ([IO.Path]::GetPathRoot($program))
                [Environment]::CurrentDirectory = [IO.Path]::GetPathRoot($program)
                $temporary = Join-Path ([IO.Path]::GetDirectoryName($program)) ".kiteline-maintenance-$([Guid]::NewGuid().ToString('N'))"
                New-KitelinePrivateDirectory $temporary
                $replacement = Join-Path $temporary 'new'
                $previous = Join-Path $temporary 'previous'
                $newPublic = $null
                if ($action -eq 'install') {
                    New-KitelinePrivateDirectory $replacement
                    $sourceFiles = Get-KitelineTree $root
                    foreach ($directory in [IO.Directory]::EnumerateDirectories($root, '*', [IO.SearchOption]::AllDirectories)) {
                        $null = [IO.Directory]::CreateDirectory((Join-Path $replacement ([IO.Path]::GetRelativePath($root, $directory))))
                    }
                    foreach ($name in $sourceFiles.Keys) {
                        Test-KitelineCancellation
                        $target = Join-Path $replacement $name
                        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
                        [IO.File]::Copy($sourceFiles[$name], $target, $false)
                    }
                } elseif ($action -eq 'upgrade') {
                    if (-not $options['--archive']) { throw 'Usage: kiteline-agent.ps1 upgrade --archive RELEASE.zip [--yes]' }
                    $archive = [IO.Path]::GetFullPath($options['--archive'])
                    $checksum = [IO.File]::ReadAllText("$archive.sha256").Trim().Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[0]
                    $inputArchive = Join-Path $temporary 'input.zip'
                    [IO.File]::Copy($archive, $inputArchive, $false)
                    if ($checksum -notmatch '^[a-fA-F0-9]{64}$' -or (Get-KitelineHash $inputArchive) -ine $checksum) { throw 'Package SHA256 verification failed' }
                    New-KitelinePrivateDirectory $replacement
                    Expand-KitelineZip $inputArchive $replacement
                }
                if ($action -ne 'uninstall') {
                    $release = Test-KitelinePackage $replacement
                    $newPublic = [IO.File]::ReadAllText((Join-Path $replacement 'bin/kiteline-agent-installed.ps1'))
                    if ((Invoke-KitelineNode $replacement @('--version') $false) -ne 0) { throw 'Prepared package could not start native Node' }
                    Set-KitelineTreeAcl $replacement $installation.sid
                }
                Close-KitelineLease $shared; $shared = $null
                Test-KitelineCancellation
                if ($errors.Count) { throw 'Preparation cleanup failed; no installation change attempted' }
                if ($action -ne 'install') {
                    $message = if ($action -eq 'upgrade') { "Install version $($release.version), retaining state at $($installation.dataDir)?" } else { "Remove the program; $(if ($options['--purge-state']) {'purge application JSON and tasks'} else {'retain all state'}) at $($installation.dataDir)?" }
                    Write-Host "$message No external manager will be controlled."
                    if (-not $options['--yes'] -and -not $guard.Confirm('Type yes to continue: ')) { throw 'Cancelled' }
                }
                Test-KitelineCancellation
                if (-not [IO.File]::Exists($useFile)) { $file = [IO.File]::Open($useFile, [IO.FileMode]::CreateNew); $file.Dispose() }
                $exclusive = $guard.Lock($useFile, $false)
                $state = Lock-KitelineState $installation
                $oldPublic = if ($action -ne 'install') { [IO.File]::ReadAllText($public) } else { $null }
                Test-KitelineCancellation
                if ($action -eq 'uninstall') {
                    [IO.Directory]::Move($program, $previous)
                    [IO.File]::Delete($public)
                    [IO.File]::Delete($recordFile)
                    if ($options['--purge-state'] -and $null -ne $state) {
                        foreach ($name in @('agent.json', 'connection.json', 'config.json', 'temporary-files.json', 'tasks')) {
                            $path = Join-Path $installation.dataDir $name
                            if (-not (Test-KitelineExists $path)) { continue }
                            Assert-KitelineNoReparse $path
                            if ($name -eq 'tasks') { Remove-KitelineTree $path } else { [IO.File]::Delete($path) }
                        }
                    }
                    Remove-KitelineTree $previous
                    Write-Host 'Uninstalled. External manager configuration and workspaces were not changed.'
                } else {
                    $movedNew = $false; $movedOld = $false; $wroteRecord = $false
                    try {
                        if ($action -eq 'upgrade') { [IO.Directory]::Move($program, $previous); $movedOld = $true }
                        [IO.Directory]::Move($replacement, $program); $movedNew = $true
                        if ($action -eq 'install') {
                            Write-KitelineAtomic $recordFile ($installation | ConvertTo-Json -Compress) $false; $wroteRecord = $true
                        }
                        Write-KitelineAtomic $public $newPublic
                        if ($action -eq 'install') { Set-KitelineTreeAcl $management $installation.sid }
                    } catch {
                        $primary = $_.Exception
                        try {
                            if ($movedNew) { [IO.Directory]::Move($program, $replacement) }
                            if ($action -eq 'upgrade' -and $movedOld) {
                                if (Test-KitelineExists $previous) { [IO.Directory]::Move($previous, $program) }
                                Write-KitelineAtomic $public $oldPublic
                            } elseif ($action -eq 'install') {
                                if ($wroteRecord) { [IO.File]::Delete($recordFile) }
                                if ($movedNew) { [IO.File]::Delete($public) }
                            }
                        } catch { throw [AggregateException]::new("Installation and rollback failed; inspect $temporary", [Exception[]]@($primary, $_.Exception)) }
                        throw $primary
                    }
                    if (Test-KitelineExists $previous) { Remove-KitelineTree $previous }
                    Write-Host "Installed version $($release.version); not started. As $($installation.user), run & '$public' run."
                }
                $result = 0
            }
        }
    } catch {
        $errors.Add($_.Exception)
    } finally {
        if ($temporary) {
            if ($previous -and (Test-KitelineExists $previous)) { [Console]::Error.WriteLine("Program backup retained at $previous") }
            else {
                try { Remove-KitelineTree $temporary }
                catch { $errors.Add($_.Exception); [Console]::Error.WriteLine("Maintenance files retained at $temporary") }
            }
        }
        Close-KitelineLease $state
        Close-KitelineLease $exclusive
        Close-KitelineLease $shared
        Close-KitelineLease $manager
        $interrupted = $guard.Interrupted
        Close-KitelineLease $guard
        if ([IO.Directory]::Exists($originalLocation.ProviderPath)) { Set-Location -LiteralPath $originalLocation.ProviderPath }
        if ([IO.Directory]::Exists($originalDirectory)) { [Environment]::CurrentDirectory = $originalDirectory }
    }
    foreach ($error in $errors) { [Console]::Error.WriteLine($error.ToString()) }
    if ($errors.Count) { return 1 }
    if ($interrupted) { return $interrupted }
    return $result
}

exit (Invoke-KitelineAgent -Arguments @($KitelineArguments))
