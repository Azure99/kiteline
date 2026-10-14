$PSNativeCommandUseErrorActionPreference = $false
$node = Join-Path $PSScriptRoot '..\runtime\bin\node.exe'
$entry = Join-Path $PSScriptRoot '..\cli\dist\main.js'
# Windows PowerShell 5.1 otherwise alters embedded quotes and empty arguments.
$json = ConvertTo-Json -InputObject @([string[]]$args) -Compress
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
$bootstrap = 'process.argv.splice(2, 1, ...JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8")));'
$import = 'data:text/javascript;base64,' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bootstrap))
$nativeArgs = @('--import', $import, $entry, $encoded)
$previousOutputEncoding = [Console]::OutputEncoding
$resultPath = $null
$code = 2
try {
    if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
        if (-not ('KitelineCliConsole' -as [type])) {
            Add-Type -ErrorAction Stop @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class KitelineCliConsole {
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleMode(IntPtr h, out uint mode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleMode(IntPtr h, uint mode);
    public static uint InputMode() {
        uint mode;
        if (!GetConsoleMode(GetStdHandle(-10), out mode)) throw new Win32Exception();
        return mode;
    }
    public static void Restore(uint mode) {
        if (!SetConsoleMode(GetStdHandle(-10), mode)) throw new Win32Exception();
    }
}
'@
        }
        $inputMode = [KitelineCliConsole]::InputMode()
        $resultPath = Join-Path ([IO.Path]::GetTempPath()) ('kiteline-attach-' + [Guid]::NewGuid().ToString('N'))
        $previousResult = $env:KITELINE_ATTACH_RESULT
        $env:KITELINE_ATTACH_RESULT = $resultPath
    }
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    & $node @nativeArgs
    $code = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine('failed [io_error] ' + $_.Exception.Message)
} finally {
    try {
        if ($resultPath) {
            $changed = [KitelineCliConsole]::InputMode() -ne $inputMode
            try {
                $completed = $false
                if ([IO.File]::Exists($resultPath)) {
                    $result = [IO.File]::ReadAllText($resultPath)
                    # A deadline can interrupt the file write before the result is complete.
                    $completed = $result -cin @('0', '1', '2')
                    if ($completed) { $code = [int]$result }
                }
                if ($changed -and -not $completed) {
                    # ConPTY forwards mouse/cursor resets only while VT input is enabled.
                    [Console]::Write([Text.Encoding]::ASCII.GetString([Convert]::FromBase64String('__TERMINAL_RESET_BASE64__')))
                    [Console]::Error.WriteLine('failed [io_error] Terminal output or cleanup did not complete; output may be incomplete.')
                    if ($code -eq 0) { $code = 2 }
                }
            } finally {
                if ($changed) { [KitelineCliConsole]::Restore($inputMode) }
            }
        }
    } catch {
        $code = 2
        [Console]::Error.WriteLine('failed [io_error] Terminal restoration failed: ' + $_.Exception.Message)
    } finally {
        try {
            if ($resultPath) {
                $env:KITELINE_ATTACH_RESULT = $previousResult
                [IO.File]::Delete($resultPath)
            }
        } catch {
            $code = 2
            [Console]::Error.WriteLine('failed [io_error] Attach result cleanup failed: ' + $_.Exception.Message)
        } finally {
            try { [Console]::OutputEncoding = $previousOutputEncoding } catch {
                $code = 2
                [Console]::Error.WriteLine('failed [io_error] Output encoding restoration failed: ' + $_.Exception.Message)
            }
        }
    }
}
exit $code
