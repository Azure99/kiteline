# Remote CLI

[中文](cli.md)

This guide is for owners operating workbench devices from a terminal on their own computer. `kiteline` connects to selected devices through the server, using credentials issued in the workbench. Use `kiteline-agent` to run and maintain the device agent, and `kiteline-server` for server administration.

## Download

From [GitHub Releases](https://github.com/Azure99/kiteline/releases), download the `kiteline-cli-<version>-<platform>-<architecture>` archive matching your server version and local system, plus its `.sha256` file. The supported systems and architectures are the same as for the [device agent](devices.en.md#supported-systems-and-prerequisites); Windows uses PowerShell 5.1 or 7.x starting at 7.4. The CLI bundles Node and needs no local Git, tmux or agent.

### Linux and macOS

```sh
KITELINE_VERSION=X.Y.Z  # Replace with the server version
KITELINE_PLATFORM=linux # Use macos for macOS
KITELINE_ARCH=amd64     # Use arm64 for ARM64 and Apple Silicon
name="kiteline-cli-$KITELINE_VERSION-$KITELINE_PLATFORM-$KITELINE_ARCH"
url="https://github.com/Azure99/kiteline/releases/download/v$KITELINE_VERSION"
curl -fLO "$url/$name.tar.gz"
curl -fLO "$url/$name.tar.gz.sha256"
sha256sum -c "$name.tar.gz.sha256"       # Linux
# shasum -a 256 -c "$name.tar.gz.sha256" # Use this instead on macOS
tar -xpzf "$name.tar.gz" --no-same-owner
export PATH="$PWD/$name/bin:$PATH"
kiteline --version
```

The PATH setting applies to this terminal. In a new terminal, set it again or use the full launcher path. Keep the whole package directory; the launcher uses its bundled runtime. For a macOS browser download blocked by quarantine, follow [manual installation](devices.en.md#manual-installation) to remove the quarantine attribute.

### Windows

Run in PowerShell:

```powershell
$version = 'X.Y.Z' # Replace with the server version
$package = "kiteline-cli-$version-windows-amd64"
$url = "https://github.com/Azure99/kiteline/releases/download/v$version"
Invoke-WebRequest -UseBasicParsing "$url/$package.zip" -OutFile "$package.zip"
Invoke-WebRequest -UseBasicParsing "$url/$package.zip.sha256" -OutFile "$package.zip.sha256"
$expected = (Get-Content "$package.zip.sha256" -Raw).Trim().Split(' ')[0]
if ((Get-FileHash "$package.zip" -Algorithm SHA256).Hash -ine $expected) { throw 'Checksum mismatch' }
Expand-Archive -LiteralPath "$package.zip" -DestinationPath .
Set-ExecutionPolicy -Scope Process Bypass -Force
$env:Path = (Resolve-Path -LiteralPath ".\$package\bin").Path + ';' + $env:Path
kiteline.ps1 --help
```

The execution policy and PATH settings apply only to this window. Replace `kiteline` in the commands below with `kiteline.ps1` on Windows; no administrator privileges are needed. Interactive attach must use the `.ps1` entry, which restores local terminal state.

A PowerShell token pipeline must start a separate PowerShell process so that the token becomes CLI stdin; do not pipe directly to the script. Pass text or JSON arguments directly to `& $cli` to avoid an outer PowerShell process parsing their quotes again:

```powershell
$cli = 'C:\package-directory\bin\kiteline.ps1'
$shell = (Get-Process -Id $PID).Path
Get-Content -Raw credential.txt | & $shell -NoProfile -ExecutionPolicy Bypass -File $cli auth login --server https://desk.example --token-stdin
$reply = & $cli targets --json
$reply | ConvertFrom-Json
```

### Use the CLI in an agent package

Agent packages also contain the same CLI at `bin/kiteline` (`bin/kiteline.ps1` on Windows), sharing Node with the agent. After agent installation, it is at `/opt/kiteline-agent/bin/kiteline`, or `C:\Program Files\kiteline-agent\bin\kiteline.ps1` on Windows. It is upgraded and removed with the agent package, without registering a global `kiteline` command. Wait for CLI calls using the package to finish before upgrading or uninstalling the agent. Removing the package does not revoke CLI credentials.

To upgrade the standalone CLI, verify and extract a new archive, switch to its launcher, and delete the old directory.

## Connect

### Issue a credential

In the workbench's Owner menu at the top right, open **CLI setup → CLI credentials**. Enter a name, select one or more devices, and choose the number of days or **No expiry**. The token is shown only once; the server retains only its digest.

The credential can operate the selected devices with the agent OS user's permissions; a workspace is not a sandbox. It cannot manage device registrations, binding codes or other credentials. The device agent's binding code is a different credential.

### Log in

```sh
kiteline auth login --server https://desk.example
# Non-interactive input must be explicit:
kiteline auth login --server https://desk.example --token-stdin < credential.txt
kiteline auth status
```

- The first command prompts to paste a token only on a TTY; without one it fails immediately. It verifies the credential before saving it.
- Credentials are saved to `~/.kiteline/credentials.json`; `KITELINE_CLI_HOME` selects another directory. New Linux/macOS directories use 0700 and files use 0600; Windows inherits access from the user's directory. Keep credentials outside shared directories and repositories.
- You can also set both `KITELINE_URL` and `KITELINE_TOKEN`. They override saved credentials; setting only one fails instead of combining it with the file.
- The CLI uses `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS`. It does not follow redirects; supply the exact workbench address in `--server`.

### Log out and revoke

- `auth logout` revokes the active token and removes its saved credential file. An already invalid token can also be removed locally; an unknown network result retains the file. Logging out an environment token leaves saved credentials intact; remove the environment variables yourself.
- You can revoke any credential in the dialog used to issue it. Revocation closes that credential's connections but keeps shared terminals running and does not undo input already sent. Other credentials keep working.
- [Resetting the owner password](server.en.md#reset-the-setup-token-or-password) invalidates all CLI credentials.

## Attach to an existing terminal

In the workbench session menu, choose “Continue in CLI” and copy the command with full target IDs. Run it in a local terminal logged in to this server. “Install and log in” opens setup when needed; the selected platform also sets the shell for the attach command. “Return to attach”, X or Escape in setup returns to the original session command; close once more to leave the flow. “CLI setup” opened directly from the Settings menu exits when closed. You can also specify targets manually:

```sh
kiteline terminal attach --device DEVICE_ID --workspace WORKSPACE_ID --session SESSION_ID
# With .kiteline.json in the current directory:
kiteline terminal attach
```

- Run in a real terminal: both stdin and stdout must be TTYs, and `--json` is not accepted. It does not create a shell.
- Type directly after connecting. `Ctrl+C` goes to the remote program, `Ctrl+B d` detaches, `Ctrl+B [` opens tmux history copy mode, and `Ctrl+B Ctrl+B` sends Ctrl+B.
- Input and terminal size are shared with the workbench. There is no exclusive input control; simultaneous input interleaves.
- Detaching or losing the connection ends only this connection; the session keeps running. If the local terminal cannot keep up with output for too long, the connection ends with an error. Run attach again to resume the current screen. On Windows, the entry may keep waiting if the host terminal never reads output.
- Normal detach returns 0; this is not the remote command's exit status.

## Select targets

```sh
kiteline targets
kiteline inspect --device DEVICE_ID --workspace WORKSPACE_ID
kiteline terminal list --device DEVICE_ID --workspace WORKSPACE_ID
```

`targets` lists full device and workspace IDs, names, online status and paths. Workspace paths for offline devices come from the last snapshot. `inspect` also lists the workspace's current terminal sessions and requires an online device. Distinguish identical names by full IDs; the CLI does not guess by name.

Put `.kiteline.json` in the current directory to avoid repeating targets:

```json
{ "device": "DEVICE_ID", "workspace": "WORKSPACE_ID", "session": "SESSION_ID" }
```

Save this file as UTF-8; in PowerShell, use `Set-Content -Encoding UTF8`.

The CLI reads this file only in the current directory, without searching parents. Command-line arguments override individual fields without changing the file. Commands that do not need a session ignore its `session`; see each command's `--help` for the rules.

## Operate terminals with short commands

```sh
kiteline terminal create --name work
# Put the returned session ID in cwd .kiteline.json, then:
kiteline terminal snapshot
kiteline terminal send --text 'pwd; git status --short' --enter
kiteline terminal wait
kiteline terminal snapshot --tail 40
kiteline web url
```

Each call is a separate short command; terminal and shell state remain on the device.

- `terminal send` success confirms only that input was delivered, not command completion. Observe with `snapshot` or `wait` before deciding what to do next. The CLI does not resend input automatically.
- `terminal wait` returns the current screen after output becomes quiet or the wait times out. Quiet does not mean task completion.
- `terminal resize` changes the shared terminal size for every client.
- The CLI has no Git or scheduled-task commands; use native tools in the terminal.
- `kiteline web url` returns the same terminal's workbench link. `web url --path PATH` returns a file link without checking existence. Click the terminal display in the workbench to type.

For conditional input (`--if-input`), incremental observation (`--if-changed`), style intervals (`--attrs`) and deadlines, see `kiteline terminal <command> --help`. The mechanisms are described in [Remote observation (Chinese)](../design/terminal.md#远程观察).

The epoch in `--if-changed`, `--if-input` and `--after` is limited to 128 UTF-16 code units. Longer values exit locally with code 2 without sending a request; `invalid_argument` returned by the device still exits with code 1.

### When recording is unavailable

When a command returns `recording_unavailable`, the terminal program is usually still running and attach remains available. To use short-command or workbench observation, check `terminal list`, then run `terminal recover`. Recovery does not restart the program, but discards the old web history and may briefly resize the terminal for a redraw. A `recovering` reply means only that the request was accepted.

Observations over 1 MiB return `limit_exceeded` while the terminal keeps running. Retry with less `--tail`, without `--attrs`, or with a smaller terminal size.

## Transfer files

```sh
kiteline files download 'notes/design.md' --output ./design.md
kiteline files upload 'notes/design copy.md' --file ./design.md
kiteline web url --path 'notes/design copy.md'
```

- Remote paths are relative to the selected workspace, use `/` separators, and cannot be absolute or contain `..` segments. Specify the local path with `--output` or `--file`.
- Downloads do not overwrite existing local files. Failure may leave an empty or partial file; do not treat it as complete.
- Upload creates a new file by default. An existing target returns a conflict, with a replacement version in the diagnostic. After deciding to replace it, run `kiteline files upload 'notes/design copy.md' --file ./design.md --replace-version VERSION`. This version is used to check the replacement target; it does not prove that no one changed the file since you downloaded it.
- Upload replaces a symlink itself; download follows it.
- An unknown upload result may have written the file. Download or check through the terminal first; the CLI does not resend automatically.

## Output and exit codes

Default output is readable text. With `--json`, stdout contains a structured reply with `outcome`, `result`, or `error.code`. Prompts and diagnostics use stderr. The CLI does not retry automatically.

| Exit | Meaning                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The operation or observation succeeded.                                                                                                        |
| 1    | A remote failure (including `invalid_argument`), partial failure, or read transport failure; partial results and diagnostics remain available. |
| 2    | A local error, such as an argument, configuration, default-target, or local file I/O error.                                                    |
| 3    | The request may have taken effect, but its result is unknown. Observe before deciding what to do next.                                         |

An unknown result always exits 3, such as a local read failure during upload that leaves the write outcome uncertain. Missing or invalid local target configuration exits 2; a target not found on the device exits 1.

JSON requests wait at most 30 seconds. File transfers end after 120 consecutive seconds without progress. `--help` and `--version` do not require a server connection.
