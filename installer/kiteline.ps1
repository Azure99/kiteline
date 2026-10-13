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
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    & $node @nativeArgs
    $code = $LASTEXITCODE
} finally {
    [Console]::OutputEncoding = $previousOutputEncoding
}
exit $code
