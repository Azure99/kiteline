# Connect devices

[中文](devices.md)

This guide explains how to connect Linux, macOS and Windows machines to the workbench and keep the agent running. First follow [Deploy the server](server.en.md) and sign in to the workbench.

## Supported systems and prerequisites

| System                                                  | Architecture                         | Agent release package                                  |
| ------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| Linux: Ubuntu 24.04, Debian 12, Alpine 3.23, CentOS 7.9 | amd64, arm64                         | `kiteline-agent-<version>-linux-<architecture>.tar.gz` |
| macOS 14 or later                                       | amd64 (Intel), arm64 (Apple Silicon) | `kiteline-agent-<version>-macos-<architecture>.tar.gz` |
| Windows 11                                              | x64                                  | `kiteline-agent-<version>-windows-amd64.zip`           |

All four Linux distributions use the same Linux release package for a given architecture.

The agent runs on the device as the project user: the operating-system account you normally use and that owns your project files. Workbench terminals, file operations, Git and scheduled tasks run with this account's permissions. Installing, upgrading and uninstalling the agent require administrator privileges (sudo on Linux and macOS, UAC elevation on Windows). Binding, running and other `kiteline-agent` commands must be performed by the project user. Other users receive `Use project user … to run this command`.

The package includes Node, tmux, the terminal recorder, terminfo, ripgrep and file-operation helpers. The macOS package also includes flock; the Windows package includes a private MSYS2 runtime. You do not need to install these, npm or a compiler. The device must provide:

- Git 2.23.0 or later.
- The project user's shell: the account's login shell on Linux and macOS, PowerShell 7 on Windows.
- Linux and macOS: an SSH client (`ssh`) and a UTF-8 locale.
- Linux: `flock` (util-linux), `infocmp` (ncurses), `curl`, `tar`, `gzip`, `sha256sum` and `getent`; sudo access is also required when the project user is not root.
- Tools used by your projects, such as compilers and AI CLIs.

The web install command first checks tools needed for downloading and installing, such as `curl` and `sudo`. `kiteline-agent check` then checks Git, SSH, `flock`, the shell, UTF-8 locale and `infocmp`. Both list missing prerequisites.

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

Run as the project user. This user must be an administrator to install with sudo during connection; otherwise, have an administrator follow [Manual installation](#manual-installation) for that user.

```sh
xcode-select --install
```

This installs Command Line Tools, including Git. You can also use Git 2.23.0 or later from another source. The system provides the SSH client.

### Windows

PowerShell 7 and Git for Windows are required. You can install them with winget:

```powershell
winget install --id Microsoft.PowerShell --source winget
winget install --id Git.Git --source winget
```

After installation, open a new PowerShell 7 window (`pwsh`) and check that `git --version` runs. Use PowerShell 7 for all subsequent agent commands, not Windows PowerShell 5.1, cmd or WSL. The project user must have signed in to Windows at least once and have a user profile. If the project user is a standard user, enter an administrator's account and password at the installation UAC prompt.

### UTF-8 locale

On Linux and macOS, the agent requires a UTF-8 locale. Run `locale charmap`; it should print `UTF-8`. Otherwise, run `locale -a` to list installed locales, then set one in the shell configuration read at project-user login: `~/.bash_profile` for bash, or `~/.profile` if that file does not exist; `~/.zprofile` for zsh; `~/.profile` for Alpine ash.

```sh
export LANG=C.UTF-8      # Ubuntu, Debian, Alpine
export LANG=en_US.UTF-8  # CentOS 7, macOS
```

Choose one line. `LC_ALL` and `LC_CTYPE` override `LANG`; change them too if set to non-UTF-8 values. `LANG` is often empty when connecting to macOS over SSH and needs this setting. Background services do not read shell configuration; set it in the service configuration as described in [Run in the background](#run-in-the-background).

## Connect using the web command

1. In the workbench device list, click "Connect device" and choose the device's system under "Device platform". The dialog generates a single-use binding code and shows its expiry time (see [Limits](reference.en.md#limits) for its lifetime).
2. Click "Copy install command".
3. Open a terminal on the device as the project user, paste the command and run it. On Windows, use a regular, non-administrator PowerShell 7 window; an administrator window is rejected.

The server address in the command is the browser's current origin, which the device must be able to reach. If you opened the workbench through `127.0.0.1`, `localhost` or SSH forwarding, reopen it at an address the device can reach before generating the command. Commands generated from an HTTPS origin download only over HTTPS.

Make sure `KITELINE_AGENT_HOME` and `KITELINE_AGENT_RUN_DIR` are not set in the current shell. Otherwise the command reports `… uses the installation configuration` and stops. To customize directories, follow [Manual installation](#manual-installation).

The command checks the system, architecture and basic tools, downloads the agent release matching the server, verifies SHA-256, and runs `kiteline-agent check` for prerequisites. It then installs the agent, binds it with the binding code, and runs it in the foreground in the current terminal.

- Linux and macOS: installation uses sudo to write to `/opt/kiteline-agent`, with the public launcher at `/usr/local/bin/kiteline-agent`. sudo prompts for a password; root installs directly.
- Windows: confirm the UAC prompt before installation. A new administrator PowerShell window installs to `C:\Program Files\kiteline-agent`, with the public launcher at `C:\ProgramData\kiteline-agent\kiteline-agent.ps1`. Binding and running still happen in the original window. The command relaxes PowerShell execution policy temporarily for this process only.

After binding succeeds, the dialog shows "Device online". Click "View device" to open its page. The agent prints `Agent <device ID> connecting to <server address>` in the terminal.

For a foreground agent, Ctrl-C stops the agent and ends its terminal sessions and active scheduled-task runs. Closing the terminal also does this on Linux and macOS. On Windows, closing the PowerShell window directly or signing out forcibly ends the agent without cleanup: active scheduled-task runs require review at the next startup (see [Review after an agent restart](scheduled-tasks.en.md#review-after-an-agent-restart)). Remove leftover session directories as described in [Clean up leftover terminal sessions](reference.en.md#clean-up-leftover-terminal-sessions). To start again later, run as the project user:

```sh
kiteline-agent run
```

```powershell
& "$PSHOME\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" run
```

This Windows form sets `Bypass` for the current process only; Group Policy still takes precedence. All PowerShell commands in this guide use this form. For a shorter form, see [kiteline-agent commands](reference.en.md#kiteline-agent-commands).

You do not need to bind again when restarting. To keep the agent running after closing the terminal or signing out, see [Run in the background](#run-in-the-background).

Running the install command again on an already installed and bound device stops at binding with `This installation is already bound`; it does not start the agent. Use the startup command above instead. If the installed version differs from the server, the command stops with `A different version is installed`; [upgrade the agent](#upgrade-the-agent) first.

### If it fails

- Missing tools or failed checks: the command lists missing items and installation suggestions. Fix them and rerun the same command while the binding code remains valid.
- Expired code: the dialog shows "Binding code expired". Click "Generate again", copy the new command and run it.
- Installed but binding failed: rerunning the command skips installation and retries binding directly.
- `Binding result is unknown`: follow [Bind again](#bind-again).

### Bind-only command

Expand "Already installed: bind only" in the dialog and click "Copy binding command". This command runs `check` and binds using the code, without installing or starting the agent. Use it for a manually installed device or when binding again, then start the agent with the command above. On an already bound device, this command also stops with `This installation is already bound`.

## Manual installation

If you need control over downloading and installing, for example because downloaded content cannot be passed directly to a shell or an administrator installs for the project user, install manually and then use the [bind-only command](#bind-only-command).

The agent version must match the server or the device cannot connect. Check the server version with `curl -fsS https://YOUR_SERVER/healthz`. Download packages from the server (`https://YOUR_SERVER/downloads/agent/<version>/<filename>`, no sign-in required) or [GitHub Releases](https://github.com/Azure99/kiteline/releases). Each package has a matching `.sha256` checksum file.

### Linux and macOS

Run as the project user:

```sh
KITELINE_SERVER=https://YOUR_SERVER  # Replace with the workbench address
KITELINE_VERSION=0.2.5               # Replace with the server version
KITELINE_PLATFORM=linux              # Use macos for macOS
KITELINE_ARCH=amd64                  # Use arm64 for ARM64 and Apple Silicon
name="kiteline-agent-$KITELINE_VERSION-$KITELINE_PLATFORM-$KITELINE_ARCH"
curl -fLO "$KITELINE_SERVER/downloads/agent/$KITELINE_VERSION/$name.tar.gz"
curl -fLO "$KITELINE_SERVER/downloads/agent/$KITELINE_VERSION/$name.tar.gz.sha256"
sha256sum -c "$name.tar.gz.sha256"            # Linux
# shasum -a 256 -c "$name.tar.gz.sha256"      # On macOS, use this instead of the previous line
tar -xpzf "$name.tar.gz" --no-same-owner
"./$name/bin/kiteline-agent" check
sudo "./$name/bin/kiteline-agent" install --user "$(id -un)"
```

`install` prints `Installed but not started` when finished. An administrator installing for another account runs the last command with the project username in place of `"$(id -un)"`; the project user still runs `check`.

Bundled programs such as tmux and `flock` are not notarized by Apple. A package downloaded in a macOS browser carries `com.apple.quarantine`; macOS may refuse to run bundled programs because it cannot verify the developer. Files downloaded with the curl commands above do not carry that attribute. For a browser download, verify SHA-256, then run `xattr -dr com.apple.quarantine "./$name"` on the extracted directory before `check`. For an installed copy, run `sudo xattr -dr com.apple.quarantine /opt/kiteline-agent`.

Then, as the project user, run the [bind-only command](#bind-only-command) copied from the web app, followed by `kiteline-agent run`.

`install` records the agent data directory in `/etc/kiteline-agent.env`. It defaults to the project user's `~/.local/share/kiteline-agent`, with `run` inside it as the runtime directory. To use other directories, edit `KITELINE_AGENT_HOME` and `KITELINE_AGENT_RUN_DIR` in this file before binding; see [Reference](reference.en.md#agent-environment-variables) for the format. The runtime directory path has a length limit (see [Limits](reference.en.md#limits)); exceeding it produces `KITELINE_AGENT_RUN_DIR is too long`.

Installing the same version again for the same user reports that it is already installed and does not change the programs, binding or tasks. `install` refuses if another version is installed; use [Upgrade the agent](#upgrade-the-agent).

### Windows

Download, verify and check in the project user's regular PowerShell 7 window:

```powershell
$server = 'https://YOUR_SERVER'  # Replace with the workbench address
$version = '0.2.5'               # Replace with the server version
$package = "kiteline-agent-$version-windows-amd64"
Set-Location "$HOME\Downloads"
Invoke-WebRequest "$server/downloads/agent/$version/$package.zip" -OutFile "$package.zip"
Invoke-WebRequest "$server/downloads/agent/$version/$package.zip.sha256" -OutFile "$package.zip.sha256"
$expected = (Get-Content "$package.zip.sha256" -Raw).Trim().Split(' ')[0]
if ((Get-FileHash "$package.zip" -Algorithm SHA256).Hash -ine $expected) { throw 'Checksum mismatch' }
Expand-Archive -LiteralPath "$package.zip" -DestinationPath .
& "$PSHOME\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File ".\$package\bin\kiteline-agent.ps1" check
whoami
```

`whoami` prints the project user's account name, such as `desktop-1234\alice`. Open PowerShell 7 as administrator (right-click and choose "Run as administrator"), go to the same download directory and install, using that account name for `--user`:

```powershell
# Replace 0.2.5 with the version downloaded above
Set-Location 'C:\Users\PROJECT_USER\Downloads'
& "$PSHOME\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File '.\kiteline-agent-0.2.5-windows-amd64\bin\kiteline-agent.ps1' install --user 'COMPUTER\PROJECT_USER'
```

Close the administrator window after installation. Back in the project user's window, run the web app's [bind-only command](#bind-only-command), then the Windows startup command in [Connect using the web command](#connect-using-the-web-command).

The data directory defaults to the project user's `%LOCALAPPDATA%\kiteline-agent`, and the runtime directory to `run` inside it. Specify other absolute paths during installation with `--data-dir` and `--run-dir`; the runtime path also has a length limit. If the installer cannot determine the project user's LocalAppData, for example when that user is not currently signed in, it requires both options explicitly.

## Add a workspace

When the device is online, click "Add" in the workspace list on its page. In "Add workspace", browse to a project directory or enter an absolute path, then click "Select this directory". See [Devices and workspaces](usage.en.md#devices-and-workspaces) for the dialog's other options and workspace management. You can then create terminal sessions in the web app or locally on the device; see [Terminal](usage.en.md#terminal).

## Run in the background

A foreground agent stops when its terminal closes, on Ctrl-C or when the user signs out. To start at boot and keep terminals and scheduled tasks running after the project user signs out, use a service manager: systemd on Linux, launchd on macOS, or WinSW on Windows.

Example configurations are in the installation's `deploy/` directory (`/opt/kiteline-agent/deploy/` on Linux and macOS, `C:\Program Files\kiteline-agent\deploy\` on Windows). The project does not install, start or remove services for you. Upgrades replace the whole installation directory, so copy examples elsewhere before editing. Alpine uses OpenRC by default rather than systemd; write a service using the user, directories and environment variables in the systemd example as a reference.

Before configuring a service:

1. Complete installation and binding in the foreground as above, and confirm that the agent connects.
2. Stop the foreground agent with Ctrl-C. Only one agent can use a data directory at a time.

The service environment differs from your login shell:

- Services start the agent directly without reading shell configuration. Put `PATH`, locale and proxy variables needed by the agent, workbench Git and scheduled tasks in the service configuration. `/etc/kiteline-agent.env` supplies only data and runtime directory locations. Interactive terminals inherit the agent environment, after which their shells may read their own configuration files; see [Shell](reference.en.md#shell) for startup arguments.
- Git credentials requiring interactive unlocking, such as passphrase-protected keys loaded only into a desktop session's SSH agent, are unavailable to the service. Use authentication that does not require interaction.
- After starting the service, run `kiteline-agent doctor` as the project user (on Windows, replace `run` in the startup command with `doctor`) to inspect the running agent's actual environment. Then perform a Fetch in workbench Git to check authentication.

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

Check `HOME`, `WorkingDirectory` (default `/Users/<username>`), `PATH` and `LANG`. `KITELINE_AGENT_HOME` and `KITELINE_AGENT_RUN_DIR` must match `/etc/kiteline-agent.env`; keep the example values if you have not customized the directories. Load it:

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

On Windows, use WinSW 2.12 to register the agent as a Windows service. Run these commands in administrator PowerShell 7. Place the service directory under the project user's home so only that user and administrators can modify its programs:

```powershell
$projectUser = 'PROJECT_USER'  # Replace with the project user's directory name under C:\Users
$service = "C:\Users\$projectUser\kiteline-service"
New-Item -ItemType Directory -Force -Path $service
Invoke-WebRequest 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile "$service\kiteline-agent.exe"
(Get-Content "$env:ProgramFiles\kiteline-agent\deploy\kiteline-agent.xml" -Raw).Replace('PROJECT_USER', $projectUser) |
  Set-Content "$service\kiteline-agent.xml" -Encoding utf8
notepad "$service\kiteline-agent.xml"
```

WinSW finds configuration by its own filename, so `kiteline-agent.exe` and `kiteline-agent.xml` must share a basename and directory. Check in Notepad:

- `PATH`: include PowerShell 7, Git's `cmd` directory and your project tools.
- `KITELINE_AGENT_HOME` and `KITELINE_AGENT_RUN_DIR`: match the directories chosen during installation. Keep the example values if you did not specify `--data-dir` or `--run-dir`.
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
& "$PSHOME\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" run
```

Install and upgrade commands download with curl, or PowerShell on Windows. curl recognizes only lowercase `http_proxy`, so HTTP origins need that lowercase variable; the example sets both types. On Windows, the agent reads environment variables only and does not use system proxy settings, so set the variables above for the agent too.

For a service, set these variables in its configuration (see [Run in the background](#run-in-the-background)), then restart the service. Restarting ends current terminal sessions and scheduled-task runs.

If the server uses a certificate issued by a private CA:

- Linux and macOS: add the CA to the system trust store for curl in the install command, and point `NODE_EXTRA_CA_CERTS` to its PEM file for the agent. Use `export NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in the shell for foreground use, or put it in the service configuration.
- Windows: the launcher removes `NODE_*` variables including `NODE_EXTRA_CA_CERTS` before starting bundled Node, so this variable does not affect the agent's own connections. Windows devices need an origin whose certificate is trusted without this variable, such as one issued by a public CA.

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
        KITELINE_VERSION: "0.2.5"
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

When adding a workspace in the web app, choose a directory under `/home/dev/projects`. For local attach, run `docker compose exec agent kiteline-agent attach SESSION_ID` on the host. For containers launched another way, use `docker exec -it -u PROJECT_USER CONTAINER /usr/local/bin/kiteline-agent attach SESSION_ID`, with `-u` specifying the same user as the agent.

To upgrade, change `KITELINE_VERSION`, run `docker compose build`, then `docker compose up -d`. The volume keeps the binding, so no rebinding is needed. Stopping or recreating a container has the same effect as stopping a foreground agent (see [Connect using the web command](#connect-using-the-web-command)).

- Git authentication: mount the project user's SSH keys, `config` and `known_hosts` at `/home/dev/.ssh`, or mount an SSH agent socket and set `SSH_AUTH_SOCK`. Install any credential helper referenced by `.gitconfig` in the image too. A read-only `known_hosts` mount cannot record new hosts; add them beforehand.
- Linked worktrees: mount the main repository and each worktree at the same absolute paths as on the host, or paths recorded in `.git` files will not exist inside the container.
- Development services: services started inside the container are directly accessible through the workbench. Services in another container must share the agent's network namespace (`network_mode: "service:agent"` in Compose). The host's `localhost` and other containers on the same bridge are not the agent's `localhost`.

## Upgrade the agent

The agent version must match the server. [Upgrade the server](server.en.md#upgrade-the-server) first, then each device showing "Version mismatch".

Before upgrading, stop all processes using this installation. Otherwise the upgrade refuses to proceed (`Agent installation is busy` on Linux and macOS):

- Foreground agent: press Ctrl-C.
- Service: use the stop commands in [Run in the background](#run-in-the-background); these also prevent automatic service-manager restarts.
- Local attachments and other running `kiteline-agent` commands: detach with Ctrl-b d, or wait for the command to finish.
- Agent instances using other data directories.

Stopping the agent ends its terminal sessions and scheduled-task runs. Binding, configuration, workspaces, task definitions and retained run records are kept.

### Upgrade using the web command

1. Open the device page and choose "Upgrade agent" from "Device actions". When versions differ, "View update command" in the notice opens the same dialog.
2. Choose the device platform and click "Copy upgrade command".
3. Run it in an interactive terminal or SSH session on the device.

On Linux and macOS, the command downloads the agent matching the server from the current origin, verifies it, then upgrades with sudo. On Windows, run it in PowerShell 7 and confirm UAC; upgrading happens in a new administrator window. At `Type yes to continue:`, enter `yes`. The command includes the server version at generation time. If it subsequently changes, the command stops with `The server release changed`; copy a new command from the web app.

Upgrading does not change the binding or saved server address. The agent does not start automatically after a successful upgrade (the output includes `not started`). Start it as usual, either in the foreground or through its service.

### Manual upgrade

Download the new package and its `.sha256` file into the same directory (as in [Manual installation](#manual-installation)), then run:

```sh
sudo /usr/local/bin/kiteline-agent upgrade --archive "$PWD/kiteline-agent-0.2.6-linux-amd64.tar.gz"
```

```powershell
# Run in administrator PowerShell 7
& "$PSHOME\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" upgrade --archive 'C:\Users\PROJECT_USER\Downloads\kiteline-agent-0.2.6-windows-amd64.zip'
```

Adjust the version and filename to the downloaded package. Add `--yes` to skip confirmation.

If upgrading fails, the agent restores the previous installation directory and reports that no instance was started. If restoration also fails, the output gives the old installation's backup location. For locking and replacement during upgrade and uninstall, see [Agent installation and runtime (Chinese)](../design/agent-lifecycle.md).

## Uninstall

First stop all users of the installation as in [Upgrade the agent](#upgrade-the-agent). The uninstall command does not manage service configuration; remove any service first:

- systemd: run `sudo systemctl disable --now kiteline-agent`, remove `/etc/systemd/system/kiteline-agent.service`, then run `sudo systemctl daemon-reload`.
- launchd: run `bootout` from the [stop commands](#launchd), then remove `/Library/LaunchDaemons/com.kiteline.agent.plist`.
- WinSW: run `stopwait` and `uninstall` on the service executable in administrator PowerShell 7, then remove the service directory.

Uninstall the program. On Linux and macOS:

```sh
sudo /usr/local/bin/kiteline-agent uninstall
```

On Windows, in administrator PowerShell 7:

```powershell
& "$PSHOME\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" uninstall
```

Enter `yes` at `Type yes to continue:`, or add `--yes` to skip confirmation. Uninstall removes the installation directory, public launcher and installation record. By default, it keeps the agent data directory and project files, so reinstalling on the same device does not require rebinding.

With `--purge-state`, it also deletes these entries in the agent data directory:

| File                   | Content                                         |
| ---------------------- | ----------------------------------------------- |
| `agent.json`           | Workspace registrations, shortcuts and settings |
| `connection.json`      | Binding credentials and server address          |
| `config.json`          | Agent configuration                             |
| `temporary-files.json` | Temporary-file records                          |
| `tasks/`               | Scheduled-task definitions and run records      |

`--purge-state` applies to the data directory recorded by the installation (`/etc/kiteline-agent.env` or the default location; on Windows, the directory selected at installation). It does not apply to `KITELINE_AGENT_HOME` set only in service configuration. Uninstall refuses if the data directory is in use. Project files and workspace directories are not deleted.

These files remain after uninstall and can be removed manually when no longer needed:

- Linux and macOS: the data directory itself (including `run/` and launchd logs), `/etc/kiteline-agent.env`, and lock files `/opt/.kiteline-agent-use.lock` and `/opt/.kiteline-agent-install.lock`.

  ```sh
  sudo rm -f /etc/kiteline-agent.env /opt/.kiteline-agent-use.lock /opt/.kiteline-agent-install.lock
  rm -rf ~/.local/share/kiteline-agent
  ```

- Windows: `C:\ProgramData\kiteline-agent` (lock files) and the data directory.

  ```powershell
  # Administrator PowerShell 7
  Remove-Item -Recurse -Force "$env:ProgramData\kiteline-agent"
  # Project user's PowerShell 7
  Remove-Item -Recurse -Force "$env:LOCALAPPDATA\kiteline-agent"
  ```

The next `install` reuses a retained `/etc/kiteline-agent.env` unchanged. Before installing for another project user, delete this file or correct its `KITELINE_AGENT_HOME`; otherwise the new user's `bind` and `run` fail because they cannot access the old directory.

Deleting the data directory also deletes this device's binding credentials. Finally, open its workbench page and choose "Delete device" from "Device actions" to remove it from the list.

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
