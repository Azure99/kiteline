# Connect devices: advanced setups

[中文](devices-advanced.md)

This guide covers setups needed only in a few cases when connecting devices: manual download and installation (including running directly without a system installation), connecting to the server through a proxy or a private CA, and running the agent in a container. For the usual connection process, see [Connect devices](devices.en.md).

## Manual installation

After downloading, verifying and extracting the complete release package, the project user can run it directly in the foreground, or an administrator can install it in system directories. Both use the web app's [bind-only command](devices.en.md#bind-only-command).

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

To run without a system installation, expand the web app's [bind-only command](devices.en.md#bind-only-command), replace both occurrences of `kiteline-agent` with `"./$name/bin/kiteline-agent"`, and execute it in the current shell. After binding, run:

```sh
"./$name/bin/kiteline-agent" run
```

Keep the entire extracted directory and use this entry for subsequent commands.

To install in system directories instead, run:

```sh
sudo "./$name/bin/kiteline-agent" install --user "$(id -un)"
```

An administrator installing for another account runs this command with the project username in place of `"$(id -un)"`; the project user still runs `check`.

`install` records the agent data directory in `/etc/kiteline-agent.env`. It defaults to the project user's `~/.local/share/kiteline-agent`, with `run` inside it as the runtime directory. To use other directories, edit `KITELINE_AGENT_HOME` in this file before binding and add `KITELINE_AGENT_RUN_DIR` if needed; see [Directory configuration file](reference.en.md#directory-configuration-file) for the format. The runtime directory path has a length limit (see [Limits](reference.en.md#limits)).

Then, as the project user, run the [bind-only command](devices.en.md#bind-only-command) copied from the web app, followed by `kiteline-agent run`.

Installing the same version again for the same user reports that it is already installed and does not change the programs, binding or tasks. `install` refuses if another version is installed; use [Upgrade the agent](devices.en.md#upgrade-the-agent).

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

To run without a system installation, expand the web app's [bind-only command](devices.en.md#bind-only-command), replace the script path after each of its two `-File` arguments with `".\$package\bin\kiteline-agent.ps1"`, and execute it in the current window. After binding, run:

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

The data directory defaults to the project user's `%LOCALAPPDATA%\kiteline-agent`, and the runtime directory to `run` inside it. Specify other absolute paths during installation with `--data-dir` and `--run-dir`. If the installer cannot determine the project user's LocalAppData, for example when that user is not currently signed in, it requires `--data-dir` explicitly.

Close the administrator window after installation. Open a new ordinary PowerShell window as the project user from the Windows Start menu, then run the web app's [bind-only command](devices.en.md#bind-only-command), then `kiteline-agent run`.

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
- Separate `no_proxy` entries with commas or spaces. `*` bypasses the proxy for everything. Entries starting with `.` or `*` match suffixes (`.example.com` matches `kiteline.example.com`). An entry can include `:port`. CIDR networks are not supported. Server addresses using `localhost`, `127.0.0.1` or `[::1]` also use the proxy variables. Add the corresponding host to `no_proxy`, preserving square brackets for IPv6 (for example, `[::1]`) when it must connect directly; otherwise binding and control/data connections also pass through the proxy.

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

For a service, set these variables in its configuration (see [Run in the background](devices.en.md#run-in-the-background)), then restart the service. Restarting ends current terminal sessions and scheduled-task runs.

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

Paste and run the web app's [bind-only command](devices.en.md#bind-only-command) in the container shell, then `exit`. Credentials are stored in the `agent-data` volume. Start the agent:

```sh
docker compose up -d
docker compose logs -f agent
```

When adding a workspace in the web app, choose a directory under `/home/dev/projects`.

To upgrade, change `KITELINE_VERSION`, run `docker compose build`, then `docker compose up -d`. The volume keeps the binding, so no rebinding is needed. Stopping or recreating a container ends the agent's terminal sessions and scheduled-task runs, just like stopping a foreground agent.

- Git authentication: mount the project user's SSH keys, `config` and `known_hosts` at `/home/dev/.ssh`, or mount an SSH agent socket and set `SSH_AUTH_SOCK`. Install any credential helper referenced by `.gitconfig` in the image too. A read-only `known_hosts` mount cannot record new hosts; add them beforehand.
- Linked worktrees: mount the main repository and each worktree at the same absolute paths as on the host, or paths recorded in `.git` files will not exist inside the container.
- Development services: services started inside the container are directly accessible through the workbench. Services in another container must share the agent's network namespace (`network_mode: "service:agent"` in Compose). The host's `localhost` and other containers on the same bridge are not the agent's `localhost`.
