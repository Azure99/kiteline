# Connect devices

[中文](devices.md)

This guide explains how to connect Linux, macOS and Windows machines to the workbench and keep the agent running. First follow [Deploy the server](server.en.md) and sign in to the workbench.

## Supported systems and prerequisites

| System                                                  | Architecture                         | Agent release package                                  |
| ------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| Linux: Ubuntu 24.04, Debian 12, Alpine 3.23, CentOS 7.9 | amd64, arm64                         | `kiteline-agent-<version>-linux-<architecture>.tar.gz` |
| macOS 14 or later                                       | amd64 (Intel), arm64 (Apple Silicon) | `kiteline-agent-<version>-macos-<architecture>.tar.gz` |
| Windows 11                                              | x64                                  | `kiteline-agent-<version>-windows-amd64.zip`           |

All four Linux distributions use the same release package for a given architecture.

The agent runs on the device as the project user: the operating-system account you normally use and that owns your project files. Workbench terminals, file operations, Git and scheduled tasks run with this account's permissions. Installing the agent in system directories, and running `upgrade` or `uninstall` on that installation, require administrator privileges (sudo on Linux and macOS, UAC elevation on Windows). The project user can also extract the complete release package into a directory they own and [run it directly](#manual-installation), without administrator privileges or running `install`. Binding, running and other `kiteline-agent` commands must be performed by the project user.

The package includes Node, tmux, the terminal recorder, terminfo, ripgrep and file-operation helpers. You do not need to install these, npm or a compiler. The device must provide:

- Git 2.23.0 or later.
- The project user's shell: the account's login shell on Linux and macOS, PowerShell on Windows. See [Shell](reference.en.md#shell) for the default selection.
- Linux and macOS: an SSH client (`ssh`) and a UTF-8 locale.
- Linux: `flock` (util-linux), `infocmp` (ncurses), `curl`, `tar`, `gzip`, `sha256sum` and `getent`; installing in system directories also requires sudo access when the project user is not root.
- Tools used by your projects, such as compilers and AI CLIs.

The install command checks the agent's prerequisites and lists missing items; see [Install system dependencies](#install-system-dependencies) for each system's installation steps.

## Connect using the web command

When there are no devices, select "Connect device" on the home page; the device navigation also provides this entry. Choose the device's system, copy the install command, and run it on the device as the project user. On Windows, use a regular, non-administrator PowerShell window; an administrator window is rejected. The command contains a single-use binding code and must run before it expires (see [Limits](reference.en.md#limits)).

The server address in the command is the browser's current origin, which the device must be able to reach. If you opened the workbench through `127.0.0.1`, `localhost` or SSH forwarding, reopen it at an address the device can reach before generating the command. Commands generated from an HTTPS origin download only over HTTPS.

The command downloads the agent release matching the server, verifies SHA-256, and runs `kiteline-agent check` for prerequisites. It then installs the agent, binds it with the binding code, and runs it in the foreground in the current terminal:

- Linux and macOS: installation uses sudo to write to `/opt/kiteline-agent`, with the public launcher at `/usr/local/bin/kiteline-agent`. Root installs directly.
- Windows: after you confirm the UAC prompt, a new administrator PowerShell window installs to `C:\Program Files\kiteline-agent` and adds `kiteline-agent` to the system PATH. Binding and running still happen in the original window. The command relaxes PowerShell execution policy temporarily for this process only. You can use `kiteline-agent` in the current window; reopen other existing windows from the Start menu to use it there.

After binding, the page distinguishes a registered device whose connection is not yet confirmed from one that is online. Start the agent if it is not online; once online, you can add a workspace directly from the binding dialog.

For a foreground agent, Ctrl-C stops the agent and ends its terminal sessions and active scheduled-task runs. Closing the terminal also does this on Linux and macOS. On Windows, closing the PowerShell window directly or signing out forcibly ends the agent without cleanup: active scheduled-task runs require review at the next startup (see [Review after an agent restart](scheduled-tasks.en.md#review-after-an-agent-restart)). Remove leftover session directories as described in [Clean up leftover terminal sessions](reference.en.md#clean-up-leftover-terminal-sessions).

To start again later, no rebinding is needed. Run as the project user:

```sh
kiteline-agent run
```

To keep the agent running after closing the terminal or signing out, see [Run in the background](#run-in-the-background).

### If it fails

- Missing tools or failed checks: the command lists missing items and installation suggestions; see [Install system dependencies](#install-system-dependencies). Fix them and rerun the same command while the binding code remains valid.
- `… uses the installation configuration`: `KITELINE_AGENT_HOME` or `KITELINE_AGENT_RUN_DIR` is set in the current shell. Unset both and retry; use [Manual installation](#manual-installation) to customize directories.
- Expired code: the dialog shows "Binding code expired". Click "Generate again", copy the new command and run it.
- Installed but binding failed: rerunning the command skips installation and retries binding directly.
- `This installation is already bound`: this device is already bound, and the command does not start the agent. Run `kiteline-agent run` directly.
- `A different version is installed`: [upgrade the agent](#upgrade-the-agent) first.
- `Binding result is unknown`: follow [Bind again](#bind-again).

### Bind-only command

The binding dialog also provides a bind-only command. It runs `check` and binds using the code, without installing or starting the agent. Use it for a manually installed device or when binding again, then run `kiteline-agent run`.

## Add a workspace

Once the device is online, open "Add workspace" from the binding dialog or device details. When entering a new path, go there before registering it; see [Devices and workspaces](usage.en.md#devices-and-workspaces) for the steps. Register a project directory to open [Terminal](usage.en.md#terminal), Files and Git.

## Run in the background

A foreground agent stops when its terminal closes, on Ctrl-C or when the user signs out. To start at boot and keep terminals and scheduled tasks running after the project user signs out, use a service manager: systemd on Linux, launchd on macOS, or WinSW on Windows.

The following steps apply to system installations. Example configurations are in the installation's `deploy/` directory (`/opt/kiteline-agent/deploy/` on Linux and macOS, `C:\Program Files\kiteline-agent\deploy\` on Windows). The project does not install, start or remove services for you. Upgrades replace the whole installation directory, so copy examples elsewhere before editing. Alpine uses OpenRC by default rather than systemd; write a service using the user, directories and environment variables in the systemd example as a reference.

Before configuring a service, complete installation and binding in the foreground, confirm that the agent connects, then stop it with Ctrl-C. Only one agent can use a data directory at a time.

The service environment differs from your login shell:

- Services do not read shell configuration. Put `PATH`, locale and proxy variables needed by the agent, workbench Git and scheduled tasks in the service configuration. `/etc/kiteline-agent.env` supplies only data and runtime directory locations. Terminals and scheduled tasks use different shell startup arguments; see [Shell](reference.en.md#shell).
- Git credentials requiring interactive unlocking, such as passphrase-protected keys loaded only into a desktop session's SSH agent, are unavailable to the service. Use authentication that does not require interaction.
- After starting the service, run `kiteline-agent doctor` as the project user to inspect the running agent's actual environment. Then perform a Fetch in workbench Git to check authentication.

### systemd

On Linux, run as the project user with sudo access:

```sh
sudo cp /opt/kiteline-agent/deploy/kiteline-agent.service /etc/systemd/system/kiteline-agent.service
sudo sed -i "s/YOUR_PROJECT_USER/$(id -un)/g" /etc/systemd/system/kiteline-agent.service
sudo -e /etc/systemd/system/kiteline-agent.service
```

Check and adjust in the editor:

- `WorkingDirectory` and `HOME`: the project user's home directory (`/root` for root).
- `PATH`: add directories containing Git and project tools, such as the absolute path to `~/.local/bin` or SCL Git's directories.
- `LANG`: an installed UTF-8 locale. CentOS 7 does not have `C.UTF-8`; use `en_US.UTF-8`.
- Proxy: add lines such as `Environment=HTTPS_PROXY=http://proxy.example.com:3128` as needed; see [Outbound proxies and certificates](#outbound-proxies-and-certificates).

Keep the other settings, including `KillMode` and `TimeoutStopSec=45`. Enable and start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now kiteline-agent
systemctl status kiteline-agent
sudo journalctl -u kiteline-agent -f
```

The service starts at boot, and systemd restarts the agent if it exits abnormally. To stop and start:

```sh
sudo systemctl stop kiteline-agent
sudo systemctl start kiteline-agent
```

### launchd

On macOS, run as the project user, who must be an administrator. The example is a system LaunchDaemon running the agent as the project user:

```sh
sudo cp /opt/kiteline-agent/deploy/kiteline-agent.plist /Library/LaunchDaemons/com.kiteline.agent.plist
sudo sed -i '' "s/YOUR_PROJECT_USER/$(id -un)/g" /Library/LaunchDaemons/com.kiteline.agent.plist
sudo -e /Library/LaunchDaemons/com.kiteline.agent.plist
```

Check `HOME`, `WorkingDirectory` (default `/Users/<username>`), `PATH` and `LANG`. Data and runtime directories come from `/etc/kiteline-agent.env`; do not set `KITELINE_AGENT_HOME` or `KITELINE_AGENT_RUN_DIR` in the plist. When reusing an older plist, first confirm that this file points to the directories currently in use, then remove those two entries. Load it:

```sh
sudo chown root:wheel /Library/LaunchDaemons/com.kiteline.agent.plist
sudo chmod 644 /Library/LaunchDaemons/com.kiteline.agent.plist
plutil -lint /Library/LaunchDaemons/com.kiteline.agent.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.kiteline.agent.plist
```

The agent starts immediately and at every boot. launchd does not restart it after an abnormal exit. Logs go to `~/.local/share/kiteline-agent/launchd.log` and `launchd-error.log`. macOS privacy controls may deny a background agent access to Desktop, Documents and Downloads; keep project directories outside them.

To stop and start:

```sh
sudo launchctl bootout system /Library/LaunchDaemons/com.kiteline.agent.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.kiteline.agent.plist
```

### WinSW

On Windows, use WinSW 2.12 to register the agent as a Windows service. Run these commands in administrator PowerShell. Place the service directory under the project user's home so only that user and administrators can modify its programs:

```powershell
$projectUser = 'PROJECT_USER'  # Replace with the project user's directory name under C:\Users
$service = "C:\Users\$projectUser\kiteline-service"
New-Item -ItemType Directory -Force -Path $service
Invoke-WebRequest -UseBasicParsing 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile "$service\kiteline-agent.exe"
(Get-Content "$env:ProgramFiles\kiteline-agent\deploy\kiteline-agent.xml" -Raw).Replace('PROJECT_USER', $projectUser) |
  Set-Content "$service\kiteline-agent.xml" -Encoding utf8
notepad "$service\kiteline-agent.xml"
```

WinSW finds configuration by its own filename, so `kiteline-agent.exe` and `kiteline-agent.xml` must share a basename and directory. Check in Notepad:

- `PATH`: include Git's `cmd` directory and your project tools; include the PS7 directory when using it.
- Data and runtime directories come from the installation record; do not set `KITELINE_AGENT_HOME` or `KITELINE_AGENT_RUN_DIR` in the XML. When reusing an older XML, first confirm that `dataDir` and `runDir` in `%ProgramData%\kiteline-agent\installation.json` point to the directories currently in use, then remove those two entries.
- Proxy: add lines such as `<env name="HTTPS_PROXY" value="http://proxy.example.com:3128" />` as needed.
- Keep `<hidewindow>false</hidewindow>`, `<stopparentprocessfirst>true</stopparentprocessfirst>` and `<stoptimeout>45sec</stoptimeout>`. WinSW relies on them to send Ctrl-C to the agent when stopping the service and allow enough time to end terminal sessions and scheduled-task runs.

Save and register the service:

```powershell
& "$service\kiteline-agent.exe" install
```

The service defaults to LocalSystem, which the agent rejects. Open `services.msc`, double-click "Kiteline Agent", choose "This account" on the "Log On" tab, and enter the project user's account (`.\PROJECT_USER` for a local account) and Windows password. For a Microsoft account, use that account's password, not a PIN. Confirm, then start:

```powershell
& "$service\kiteline-agent.exe" start
& "$service\kiteline-agent.exe" status
```

The service starts at boot and writes logs in the service directory. Use `stopwait` to stop it; this waits until the service has actually stopped, whereas `stop` only sends a stop request:

```powershell
& 'C:\Users\PROJECT_USER\kiteline-service\kiteline-agent.exe' stopwait
& 'C:\Users\PROJECT_USER\kiteline-service\kiteline-agent.exe' start
```

## Install system dependencies

### Linux

Run as root, or prefix each command with `sudo` as a regular user.

```sh
# Ubuntu 24.04, Debian 12
apt-get update
apt-get install -y curl ca-certificates tar gzip coreutils git openssh-client ncurses-bin locales util-linux sudo

# Alpine 3.23
apk add curl ca-certificates tar gzip coreutils musl-utils git openssh-client ncurses musl-locales util-linux sudo

# CentOS 7.9: first switch yum repositories to vault.centos.org
sed -i -e 's/^mirrorlist=/#mirrorlist=/' -e 's|^#\? *baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' /etc/yum.repos.d/CentOS-*.repo
yum install -y curl ca-certificates tar gzip coreutils openssh-clients ncurses glibc-common util-linux sudo
```

CentOS 7 is no longer maintained and its official mirrors are offline, so its yum repositories must use `vault.centos.org`. Its bundled Git is older than 2.23.0; install a newer version separately, such as Software Collections' `rh-git227`. Install the Software Collections repository files with `centos-release-scl`, then switch those to vault as well:

```sh
yum install -y centos-release-scl
sed -i -e 's/^mirrorlist=/#mirrorlist=/' -e 's|^#\? *baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' /etc/yum.repos.d/CentOS-SCLo-*.repo
[ "$(uname -m)" = aarch64 ] && sed -i 's|vault.centos.org/centos/7/sclo/|vault.centos.org/altarch/7/sclo/|' /etc/yum.repos.d/CentOS-SCLo-*.repo
yum install -y rh-git227
```

For SCL Git, run `source /opt/rh/rh-git227/enable` in the shell before starting the agent. For a service, put the resulting `PATH` and `LD_LIBRARY_PATH` in the service configuration (inspect them with `echo "$PATH"` and `echo "$LD_LIBRARY_PATH"`).

### macOS

Prepare Git as the project user:

```sh
xcode-select --install
```

This installs Command Line Tools, including Git. You can also use Git 2.23.0 or later from another source. The system provides the SSH client.

### Windows

Windows PowerShell 5.1 and PowerShell 7.x starting at 7.4 are supported. Git for Windows is also required; install it with winget:

```powershell
winget install --id Git.Git --source winget
```

After installation, open a new PowerShell window and check that `git --version` runs. The project user must have signed in to Windows at least once and have a user profile. If the project user is a standard user, enter an administrator's account and password at the installation UAC prompt.

Run with ordinary privileges for daily use. If the project account is itself an administrator and needs those privileges, stop the agent, open PowerShell with “Run as administrator” under that same account, and run `kiteline-agent run`. Terminal, file, Git and scheduled-task operations will then also have administrator privileges. Entering another administrator’s credentials switches accounts and cannot run the original project user’s installation.

### UTF-8 locale

On Linux and macOS, the agent requires a UTF-8 locale. Run `locale charmap`; it should print `UTF-8`. Otherwise, run `locale -a` to list installed locales, then set one in the shell configuration read at project-user login: `~/.bash_profile` for bash, or `~/.profile` if that file does not exist; `~/.zprofile` for zsh; `~/.profile` for Alpine ash.

```sh
export LANG=C.UTF-8      # Ubuntu, Debian, Alpine
export LANG=en_US.UTF-8  # CentOS 7, macOS
```

Choose one line. `LC_ALL` and `LC_CTYPE` override `LANG`; change them too if set to non-UTF-8 values. `LANG` is often empty when connecting to macOS over SSH and needs this setting. Background services do not read shell configuration; set it in the service configuration as described in [Run in the background](#run-in-the-background).

## Manual installation

After downloading, verifying and extracting the complete release package, the project user can run it directly in the foreground, or an administrator can install it in system directories. Both use the web app's [bind-only command](#bind-only-command).

Direct execution uses the default data and runtime directories listed in [Agent environment variables](reference.en.md#agent-environment-variables). To customize them, set `KITELINE_AGENT_HOME` and `KITELINE_AGENT_RUN_DIR` in the same shell used for `check`, binding and `run`. Keep both the data and runtime directories outside the program directory and retain the same directory settings when replacing the package.

The agent version must match the server or the device cannot connect. Check the server version with `curl -fsS https://YOUR_SERVER/healthz`. Download packages from the server (`https://YOUR_SERVER/downloads/agent/<version>/<filename>`, no sign-in required) or [GitHub Releases](https://github.com/Azure99/kiteline/releases). Each package has a matching `.sha256` checksum file.

### Linux and macOS

Run as the project user in a new directory they own:

```sh
KITELINE_SERVER=https://YOUR_SERVER  # Replace with the workbench address
KITELINE_VERSION=X.Y.Z               # Replace with the server version
KITELINE_PLATFORM=linux              # Use macos for macOS
KITELINE_ARCH=amd64                  # Use arm64 for ARM64 and Apple Silicon
name="kiteline-agent-$KITELINE_VERSION-$KITELINE_PLATFORM-$KITELINE_ARCH"
curl -fLO "$KITELINE_SERVER/downloads/agent/$KITELINE_VERSION/$name.tar.gz"
curl -fLO "$KITELINE_SERVER/downloads/agent/$KITELINE_VERSION/$name.tar.gz.sha256"
sha256sum -c "$name.tar.gz.sha256"            # Linux
# shasum -a 256 -c "$name.tar.gz.sha256"      # On macOS, use this instead of the previous line
tar -xpzf "$name.tar.gz" --no-same-owner
"./$name/bin/kiteline-agent" check
```

Bundled programs such as tmux and `flock` are not notarized by Apple. A package downloaded in a macOS browser carries `com.apple.quarantine`; macOS may refuse to run bundled programs. Files downloaded with the curl commands above do not carry that attribute. For a browser download, verify SHA-256, then run `xattr -dr com.apple.quarantine "./$name"` on the extracted directory before `check`. For an installed copy, run `sudo xattr -dr com.apple.quarantine /opt/kiteline-agent`.

To run without a system installation, expand the web app's [bind-only command](#bind-only-command), replace both occurrences of `kiteline-agent` with `"./$name/bin/kiteline-agent"`, and execute it in the current shell. After binding, run:

```sh
"./$name/bin/kiteline-agent" run
```

Keep the entire extracted directory and use this entry for subsequent commands.

To install in system directories instead, run:

```sh
sudo "./$name/bin/kiteline-agent" install --user "$(id -un)"
```

An administrator installing for another account runs this command with the project username in place of `"$(id -un)"`; the project user still runs `check`.

`install` records the agent data directory in `/etc/kiteline-agent.env`. It defaults to the project user's `~/.local/share/kiteline-agent`, with `run` inside it as the runtime directory. To use other directories, edit `KITELINE_AGENT_HOME` and `KITELINE_AGENT_RUN_DIR` in this file before binding; see [Directory configuration file](reference.en.md#directory-configuration-file) for the format. The runtime directory path has a length limit (see [Limits](reference.en.md#limits)).

Then, as the project user, run the [bind-only command](#bind-only-command) copied from the web app, followed by `kiteline-agent run`.

Installing the same version again for the same user reports that it is already installed and does not change the programs, binding or tasks. `install` refuses if another version is installed; use [Upgrade the agent](#upgrade-the-agent).

### Windows

Download, verify and check in the project user's regular PowerShell window:

```powershell
$server = 'https://YOUR_SERVER'  # Replace with the workbench address
$version = 'X.Y.Z'               # Replace with the server version
$package = "kiteline-agent-$version-windows-amd64"
Set-Location 'C:\Users\PROJECT_USER\AGENT_PACKAGE_DIR'  # Replace with a new directory you created
Invoke-WebRequest -UseBasicParsing "$server/downloads/agent/$version/$package.zip" -OutFile "$package.zip"
Invoke-WebRequest -UseBasicParsing "$server/downloads/agent/$version/$package.zip.sha256" -OutFile "$package.zip.sha256"
$expected = (Get-Content "$package.zip.sha256" -Raw).Trim().Split(' ')[0]
if ((Get-FileHash "$package.zip" -Algorithm SHA256).Hash -ine $expected) { throw 'Checksum mismatch' }
Expand-Archive -LiteralPath "$package.zip" -DestinationPath .
& (Join-Path $PSHOME $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'powershell.exe' } else { 'pwsh.exe' })) -NoProfile -ExecutionPolicy Bypass -File ".\$package\bin\kiteline-agent.ps1" check
```

To run without a system installation, expand the web app's [bind-only command](#bind-only-command), replace the script path after each of its two `-File` arguments with `".\$package\bin\kiteline-agent.ps1"`, and execute it in the current window. After binding, run:

```powershell
& (Join-Path $PSHOME $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'powershell.exe' } else { 'pwsh.exe' })) -NoProfile -ExecutionPolicy Bypass -File ".\$package\bin\kiteline-agent.ps1" run
```

Keep the entire extracted directory and use this entry for subsequent commands.

To install in system directories instead, first run `whoami` in the current window and note the project user's account name, such as `desktop-1234\alice`. Open PowerShell as administrator (right-click and choose "Run as administrator"), go to the same download directory and install, using that account name for `--user`:

```powershell
# Replace X.Y.Z with the version downloaded above
Set-Location 'C:\Users\PROJECT_USER\AGENT_PACKAGE_DIR'
& (Join-Path $PSHOME $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'powershell.exe' } else { 'pwsh.exe' })) -NoProfile -ExecutionPolicy Bypass -File '.\kiteline-agent-X.Y.Z-windows-amd64\bin\kiteline-agent.ps1' install --user 'COMPUTER\PROJECT_USER'
```

The data directory defaults to the project user's `%LOCALAPPDATA%\kiteline-agent`, and the runtime directory to `run` inside it. Specify other absolute paths during installation with `--data-dir` and `--run-dir`. If the installer cannot determine the project user's LocalAppData, for example when that user is not currently signed in, it requires both options explicitly.

Close the administrator window after installation. Open a new ordinary PowerShell window as the project user from the Windows Start menu, then run the web app's [bind-only command](#bind-only-command), then `kiteline-agent run`.

### Restore Windows repository ownership

After running the agent elevated, the root of your repository may be owned by `Administrators`. Git may report `dubious ownership` when you return to ordinary permissions, even if you can still read and write files. Use the following only for your own repository, when its root is owned by `Administrators` and your account already has `FullControl` on that directory. In your ordinary PowerShell session, enter the repository root and restore its owner:

```powershell
icacls . /setowner ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
```

This does not recursively change child-file owners, grant additional access, or add a Git trust exception.

## Outbound proxies and certificates

Agent traffic to the server (binding requests and control/data WebSocket connections) uses proxies configured through environment variables. Connections to development services on the device are always direct. Programs started in terminals inherit the agent's environment but decide for themselves whether to use proxies.

| Variable                     | Purpose                                              |
| ---------------------------- | ---------------------------------------------------- |
| `https_proxy`, `HTTPS_PROXY` | Proxy for a server address beginning with `https://` |
| `http_proxy`, `HTTP_PROXY`   | Proxy for a server address beginning with `http://`  |
| `all_proxy`, `ALL_PROXY`     | Proxy when the preceding variables are unset         |
| `no_proxy`, `NO_PROXY`       | Hosts to connect to directly                         |

- On Linux and macOS, lowercase variables take precedence: a leftover `https_proxy` overrides a newly set `HTTPS_PROXY`. Windows environment variable names are case-insensitive.
- Proxy addresses must start with `http://` or `https://`; other schemes, such as `socks5://`, produce `Agent environment proxy must use HTTP or HTTPS`. Without a scheme, the agent uses the server address's scheme. For example, `HTTPS_PROXY=proxy.example.com:3128` becomes `https://proxy.example.com:3128`, which usually fails to connect, so always write `http://` explicitly.
- The proxy must allow CONNECT to the server's host and port, even for an `http://` server address. Some proxies allow CONNECT only to port 443 by default; adjust them for other server ports.
- Separate `no_proxy` entries with commas or spaces. `*` bypasses the proxy for everything. Entries starting with `.` or `*` match suffixes (`.example.com` matches `kiteline.example.com`). An entry can include `:port`. CIDR networks are not supported.

For foreground use, set variables in the same shell where you run the install command or `kiteline-agent run`:

```sh
export HTTPS_PROXY=http://proxy.example.com:3128
export http_proxy=http://proxy.example.com:3128
export NO_PROXY=localhost,127.0.0.1,.internal.example.com
kiteline-agent run
```

```powershell
$env:HTTPS_PROXY = 'http://proxy.example.com:3128'
kiteline-agent run
```

Install and upgrade commands download with curl, or PowerShell on Windows. curl recognizes only lowercase `http_proxy`, so HTTP origins need that lowercase variable; the example sets both types. On Windows, the agent reads environment variables only and does not use system proxy settings.

For a service, set these variables in its configuration (see [Run in the background](#run-in-the-background)), then restart the service. Restarting ends current terminal sessions and scheduled-task runs.

If the server uses a certificate issued by a private CA:

- Linux and macOS: add the CA to the system trust store for curl in the install command, and point `NODE_EXTRA_CA_CERTS` to its PEM file for the agent. Use `export NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in the shell for foreground use, or put it in the service configuration.
- Windows: `NODE_EXTRA_CA_CERTS` does not affect the agent's own connections. Windows devices need an origin whose certificate is trusted without this variable, such as one issued by a public CA.

## Run in a container

The agent can run in a Linux container you prepare; workspaces, terminals and development services then run inside it. The container needs tools checked by `kiteline-agent check` (Git, SSH, `flock`, `infocmp`, a UTF-8 locale) and your project tools. The installation (`/opt/kiteline-agent`, `/usr/local/bin/kiteline-agent`, `/etc/kiteline-agent.*`) is in the container filesystem and is lost on recreation, so install as root while building the image. sudo is not needed inside the container. Keep the agent data and project directories in volumes or mounts so bindings, workspaces and scheduled tasks survive recreation. With no systemd in the container, run `kiteline-agent run` as its main process.

This example downloads and installs the agent from the server at image build time. In an empty directory, create `Dockerfile`:

```dockerfile
FROM debian:12
ARG KITELINE_SERVER
ARG KITELINE_VERSION
ENV LANG=C.UTF-8
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash dev
RUN cd /var/tmp \
    && name="kiteline-agent-$KITELINE_VERSION-linux-$(dpkg --print-architecture)" \
    && curl -fsSLO "$KITELINE_SERVER/downloads/agent/$KITELINE_VERSION/$name.tar.gz" \
    && curl -fsSLO "$KITELINE_SERVER/downloads/agent/$KITELINE_VERSION/$name.tar.gz.sha256" \
    && sha256sum -c "$name.tar.gz.sha256" \
    && tar -xpzf "$name.tar.gz" --no-same-owner \
    && "./$name/bin/kiteline-agent" install --user dev \
    && rm -rf "$name" "$name.tar.gz" "$name.tar.gz.sha256"
USER dev
WORKDIR /home/dev
RUN mkdir -p /home/dev/.local/share/kiteline-agent /home/dev/projects
CMD ["/usr/local/bin/kiteline-agent", "run"]
```

And `compose.yaml`:

```yaml
services:
  agent:
    hostname: dev-container
    build:
      context: .
      args:
        KITELINE_SERVER: https://YOUR_SERVER
        KITELINE_VERSION: "X.Y.Z"
    init: true
    restart: unless-stopped
    stop_grace_period: 45s
    volumes:
      - agent-data:/home/dev/.local/share/kiteline-agent
      - ./projects:/home/dev/projects
volumes:
  agent-data:
```

`KITELINE_VERSION` must match the server. `./projects` is the host project directory and should have the same owner as `dev` in the container (UID 1000). A device takes its name from the hostname at binding time. `hostname` fixes the container hostname; otherwise its random container ID becomes the device name. You can also choose "Rename" from "Device actions" after binding. `init: true` lets an init process reap child processes, and `stop_grace_period` gives the agent time to end terminal sessions and scheduled-task runs. Build and bind once:

```sh
mkdir -p projects
docker compose build
docker compose run --rm agent sh
```

Paste and run the web app's [bind-only command](#bind-only-command) in the container shell, then `exit`. Credentials are stored in the `agent-data` volume. Start the agent:

```sh
docker compose up -d
docker compose logs -f agent
```

When adding a workspace in the web app, choose a directory under `/home/dev/projects`.

To upgrade, change `KITELINE_VERSION`, run `docker compose build`, then `docker compose up -d`. The volume keeps the binding, so no rebinding is needed. Stopping or recreating a container ends the agent's terminal sessions and scheduled-task runs, just like stopping a foreground agent.

- Git authentication: mount the project user's SSH keys, `config` and `known_hosts` at `/home/dev/.ssh`, or mount an SSH agent socket and set `SSH_AUTH_SOCK`. Install any credential helper referenced by `.gitconfig` in the image too. A read-only `known_hosts` mount cannot record new hosts; add them beforehand.
- Linked worktrees: mount the main repository and each worktree at the same absolute paths as on the host, or paths recorded in `.git` files will not exist inside the container.
- Development services: services started inside the container are directly accessible through the workbench. Services in another container must share the agent's network namespace (`network_mode: "service:agent"` in Compose). The host's `localhost` and other containers on the same bridge are not the agent's `localhost`.

## Upgrade the agent

The agent version must match the server. [Upgrade the server](server.en.md#upgrade-the-server) first, then each device showing "Version mismatch".

If you run directly from an extracted directory, use [Manual package replacement](#manual-package-replacement). For a system installation, use the web or manual upgrade commands below.

Before upgrading a system installation, stop all processes using it, or the upgrade is rejected (`Agent installation is busy`, or `Installation is busy` on Windows):

- Foreground agent: press Ctrl-C.
- Service: use the stop commands in [Run in the background](#run-in-the-background); these also prevent automatic service-manager restarts.
- Agent instances using other data directories.
- Other running `kiteline-agent` commands and CLI calls using the package: wait for them to finish.

Stopping the agent ends its terminal sessions and scheduled-task runs. Binding, configuration, workspaces, task definitions and retained run records are kept.

### Manual package replacement

Press Ctrl-C to stop the old agent and wait for the command to finish. Follow [Manual installation](#manual-installation) to download and verify the complete package matching the server, and extract it into a new directory. As the same project user, run `check` and `run` through the new package entry, retaining the original data and runtime directory settings without binding again. Binding, configuration, task definitions and retained run records continue to use the original data; workspace files stay in their original locations.

Use a new directory when re-extracting the same version too, rather than merging files into the old program directory. Once the new package checks and runs successfully, you can delete the old program directory you own.

### Upgrade using the web command

Copy the command from "Upgrade agent" on the device page and run it in an interactive terminal or SSH session on the device. If the platform is unknown, select it first. The command downloads and verifies the agent release matching the server from the current origin: on Linux and macOS, upgrading uses sudo; on Windows, run it in PowerShell and confirm UAC to upgrade in a new administrator window. At `Type yes to continue:`, enter `yes`. If the server version changes after you copy the command, it stops with `The server release changed`; copy a new command.

Upgrading does not change the binding or saved server address. The agent does not start automatically after a successful upgrade (the output includes `not started`). Start it as usual: run `kiteline-agent run` in the foreground, or start its service.

### Manual upgrade

Download the new package and its `.sha256` file into the same directory (as in [Manual installation](#manual-installation)), then run:

```sh
sudo /usr/local/bin/kiteline-agent upgrade --archive "$PWD/kiteline-agent-X.Y.Z-linux-amd64.tar.gz"
```

```powershell
# Run in administrator PowerShell, using the new package’s maintenance script
Set-Location 'C:\Users\PROJECT_USER\Downloads'
$package = 'kiteline-agent-X.Y.Z-windows-amd64'
$expected = (Get-Content -LiteralPath "$package.zip.sha256").Split(' ')[0]
if ((Get-FileHash -LiteralPath "$package.zip" -Algorithm SHA256).Hash -ine $expected) { throw 'Package SHA256 verification failed' }
Expand-Archive -LiteralPath "$package.zip" -DestinationPath .
& (Join-Path $PSHOME $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'powershell.exe' } else { 'pwsh.exe' })) -NoProfile -ExecutionPolicy Bypass -File ".\$package\bin\kiteline-agent.ps1" upgrade --archive "$PWD\$package.zip"
```

Adjust the version and filename to the downloaded package. Add `--yes` to skip confirmation. If replacing the program fails, the upgrade attempts to restore the previous installation; if restoration fails, the output gives the backup location.

## Uninstall

If you run directly from an extracted directory, press Ctrl-C to stop the agent, then delete the program directory you own. Agent data and workspace files outside it are kept.

The following uninstall commands apply to system installations. After deleting a device, the web app provides local uninstall commands. If the platform is unknown, select the target device’s platform first.

First stop all users of the installation as in [Upgrade the agent](#upgrade-the-agent). The uninstall command does not manage service configuration; remove any service first:

- systemd: run `sudo systemctl disable --now kiteline-agent`, remove `/etc/systemd/system/kiteline-agent.service`, then run `sudo systemctl daemon-reload`.
- launchd: run `bootout` from the [stop commands](#launchd), then remove `/Library/LaunchDaemons/com.kiteline.agent.plist`.
- WinSW: run `stopwait` and `uninstall` on the service executable in administrator PowerShell, then remove the service directory.

Choose an uninstall mode. Default uninstall removes the program directory, command entry and installation record, keeping agent data, runtime directories, Unix `/etc/kiteline-agent.env` and coordination locks. On Linux and macOS:

```sh
sudo /usr/local/bin/kiteline-agent uninstall
```

On Windows, in administrator PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" uninstall
```

On Windows, both modes remove the `kiteline-agent` entry from the system PATH; reopen existing windows.

Reinstalling for the same project user with the original data path reuses binding and data. On Windows, pass custom data and runtime paths again when reinstalling; the installer does not remember them. Unix installation reuses `/etc/kiteline-agent.env`; remove it or correct its data path before changing the project user.

For complete removal, use `--purge`:

```sh
sudo /usr/local/bin/kiteline-agent uninstall --purge
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" uninstall --purge
```

`--purge` also removes `/etc/kiteline-agent.env`, the entire agent data and runtime directories (including binding, workspace registrations, scheduled tasks and run records), coordination locks and empty agent-owned directories. Check the directories listed by the command, then type `yes` to confirm; add `--yes` to skip confirmation.

Neither mode cleans up [CLI credentials](cli.en.md#connect): they are stored in a separate directory and are not revoked by uninstalling.

## Bind again

Binding again gives the device a new identity. Workspace registrations and scheduled tasks remain in the agent data directory and are retained.

General procedure:

1. Stop the agent (Ctrl-C in the foreground, or stop the service).
2. Delete `connection.json` from the agent data directory:

   ```sh
   rm ~/.local/share/kiteline-agent/connection.json
   ```

   ```powershell
   Remove-Item "$env:LOCALAPPDATA\kiteline-agent\connection.json"
   ```

   Use the actual path if you customized the data directory.

3. Click "Connect device" in the workbench and run the [bind-only command](#bind-only-command) as the project user.
4. Start the agent.
5. The old device record remains offline. Choose "Delete device" from its "Device actions" menu.

Handling specific cases:

- `Binding result is unknown`: the server may already have processed the request. Use the binding dialog's status:
  - "Waiting for device": run the same command again.
  - "Binding code expired": click "Generate again" and run the new command.
  - A registered status such as "Registered; not connected": if `connection.json` exists in the agent data directory, start the agent. Otherwise, delete the newly registered device in the web app, then use a new code with the bind-only command.
- `was registered but its credentials were not saved`: delete that device in the web app and bind using a new code.
- Lost credentials, for example after deleting or changing the data directory: follow the general procedure and delete the old device record.
- Two agent data directories contain the same credentials, for example after cloning a VM, disk or data directory: the later connection replaces the earlier agent, which prints `Remote connection stopped` with reason `connection_replaced` and stops connecting. Follow the general procedure on the copy.
- Device deleted in the web app: the agent prints `Remote connection stopped` and stops connecting. Follow the general procedure to use it again.
- Changed server address or a different server: the agent connects only to its original binding address. Follow the general procedure, generating a code from the new origin that the device can reach.
