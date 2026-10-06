# Reference

[中文](reference.md)

This reference covers `kiteline-server` and `kiteline-agent` commands, configuration, limits and troubleshooting for deployers. For procedures, see [Deploy the server](server.en.md), [Connect devices](devices.en.md) and [Use the workbench](usage.en.md).

## kiteline-server commands

```text
kiteline-server [serve | setup-token | reset-password] [--data-dir DIR]
kiteline-server --version
```

| Command or option | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `serve`           | Start the server; the default when no subcommand is supplied            |
| `setup-token`     | Generate a new setup token and print only the token                     |
| `reset-password`  | Reset the owner password and invalidate all login sessions              |
| `--data-dir DIR`  | Data directory for this invocation; overrides `KITELINE_DATA_DIR`       |
| `--version`       | Print the version; cannot be combined with a subcommand or `--data-dir` |

`kiteline-server` has no `--help`. Unknown arguments or subcommands print an error and exit with status 1.

- `serve` prints `Kiteline setup token: …` only at first startup, and `Kiteline listening on http://HOST:PORT` after it starts listening. It stops on `SIGINT` or `SIGTERM`.
- `setup-token` replaces the previous token. See [Limits](#limits) for its lifetime. After the owner has set a password, it reports `Already initialized`.
- `reset-password` prompts `New password: `. Terminal input is not echoed; Enter submits. You can also pass one password line on stdin. Before setup it reports `Not initialized`. Success prints `Password updated. All web login sessions have been invalidated.`
- Every command except `--version` sets the data directory's permissions to `0700` and holds its `process.lock`. Running `setup-token` or `reset-password` while the server runs produces `Lock file is already being held`, so stop the server first. See [Reset the setup token or password](server.en.md#reset-the-setup-token-or-password) for Docker and native procedures.

The Docker image's `ENTRYPOINT` is `kiteline-server`, with default argument `serve`, so pass the subcommand after the service name in `docker compose run`. Run in the directory containing `compose.yaml`, with the same `KITELINE_VERSION` and `KITELINE_IMAGE` settings used to start the server.

### Health check

`GET /healthz` returns `{"status":"ok","version":"<version>"}` without sign-in, for monitoring and reverse-proxy health checks.

## kiteline-agent commands

On Linux and macOS, the public launcher is `/usr/local/bin/kiteline-agent`; use this absolute path with `sudo`. On Windows it is `%ProgramData%\kiteline-agent\kiteline-agent.ps1`. PowerShell 7 supports two invocation forms:

```powershell
# Short form
& "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" doctor
# Full form
& "$PSHOME\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" doctor
```

Use the short form for direct interaction in a real console, with an execution policy that allows local scripts. Use the full form for variable capture, PowerShell pipelines or redirection; program output from the short form does not enter the PowerShell object pipeline. The full form's `Bypass` applies only to that process, and Group Policy still takes precedence. Replace `kiteline-agent <subcommand>` in these guides with the form appropriate to its use on Windows.

Running `kiteline-agent` with no arguments or with `--help` prints a subcommand summary; `--version` prints its version. Only `schedule` and its subcommands provide `--help`. Other subcommands have no `--help`; their arguments are listed below.

| Command                   | Options                                                                         | Run as                | Agent process           |
| ------------------------- | ------------------------------------------------------------------------------- | --------------------- | ----------------------- |
| `install`                 | `--user PROJECT_USER`; Windows also accepts `--data-dir PATH`, `--run-dir PATH` | root or administrator | Irrelevant              |
| `upgrade`                 | `--archive FILE` (required), `--yes`                                            | root or administrator | All must be stopped     |
| `uninstall`               | `--purge-state`, `--yes`                                                        | root or administrator | All must be stopped     |
| `check`                   | None                                                                            | Project user          | Irrelevant              |
| `bind`                    | `--server URL` (required), `--if-unbound`                                       | Project user          | Must be stopped         |
| `run`                     | None                                                                            | Project user          | Started by this command |
| `doctor`                  | None                                                                            | Project user          | Optional                |
| `attach SESSION_ID`       | `--run-dir DIR`                                                                 | Project user          | Must be running         |
| `workspace list`          | None                                                                            | Project user          | Must be running         |
| `terminal list`           | `--workspace WORKSPACE_ID`                                                      | Project user          | Must be running         |
| `terminal new`            | `--workspace WORKSPACE_ID` (required), `--shortcut SHORTCUT_ID`, `--no-attach`  | Project user          | Must be running         |
| `terminal end SESSION_ID` | None                                                                            | Project user          | Must be running         |
| `schedule …`              | See [Scheduled tasks: command line](scheduled-tasks.en.md#command-line)         | Project user          | Must be running         |

The project user is the account recorded at installation. Other accounts receive `Use project user PROJECT_USER to run this command` after installation.

### Installation and maintenance

For procedures, prerequisites and data effects, see [Manual installation](devices.en.md#manual-installation), [Upgrade the agent](devices.en.md#upgrade-the-agent) and [Uninstall](devices.en.md#uninstall).

### Binding and running

- `check` checks bundled components, [system prerequisites](devices.en.md#supported-systems-and-prerequisites), data and runtime directory writability, and runtime path length. Success prints `Setup checks passed.` Otherwise it lists failures and exits nonzero.
- `bind --server URL` registers this machine as a device with a single-use binding code. Enter it at `Binding code: ` or supply one line on stdin. `URL` must use `http://` or `https://`; the agent stores only the scheme, host and port. The device name comes from its hostname. `--if-unbound` exits with an error if already bound, preserving the existing identity.
- `run` starts the agent in the foreground, connects to the server and begins scheduled-task execution. Linux/macOS stop on `SIGINT`, `SIGTERM` or `SIGHUP`; Windows stops on Ctrl-C or Ctrl-Break. Normal shutdown ends all terminal sessions and active scheduled-task runs. For persistent background use, see [Run in the background](devices.en.md#run-in-the-background).
- `doctor` reports `[ok]`, `[warn]` and `[error]` checks, exiting with status 1 if any is `[error]`. With an agent running, it reports that agent's actual environment: version, server connection, recorder, scheduled tasks, Git configuration sources and `SSH_AUTH_SOCK`. Without one, it checks only installation and configuration files and reports `Runtime environment has not been checked`.

### Terminals and workspaces

- `workspace list` prints a tab-separated `WORKSPACE_ID`, name and path per line. Workspaces can only be added or removed in the web app.
- `terminal list` prints `SESSION_ID`, `WORKSPACE_ID`, state and name per line. `--workspace` filters to that workspace.
- `terminal new` prints the new `SESSION_ID`, then attaches. `--no-attach` creates without attaching. `--shortcut` starts a shortcut: new devices have IDs `claude`, `codex` and `opencode`. Shortcuts added in "Terminal settings" have random IDs, available under `shortcuts` in the data directory's `agent.json`.
- `terminal end SESSION_ID` ends the session and its programs without confirmation.
- `attach SESSION_ID` attaches in the current terminal; `Ctrl-b d` detaches. It requires an interactive terminal; use `docker exec -it` in containers. `--run-dir` overrides the environment variable. The web app's "Local attach command" already includes the correct launcher and runtime directory. See [Terminal](usage.en.md#terminal).

## Server environment variables

| Variable                     | Default             | Description                                          |
| ---------------------------- | ------------------- | ---------------------------------------------------- |
| `KITELINE_LISTEN_ADDR`       | `127.0.0.1:8080`    | Listen address as `HOST:PORT`; IPv6 uses `[::]:8080` |
| `KITELINE_DATA_DIR`          | `/var/lib/kiteline` | Server data directory                                |
| `KITELINE_TRUST_PROXY_PROTO` | `0`                 | `1` uses the reverse proxy's `X-Forwarded-Proto`     |

- Omitting the port in `KITELINE_LISTEN_ADDR` uses port 80. The Docker image sets `0.0.0.0:8080`; the repository's systemd example sets `127.0.0.1:8080`, overridable in `/etc/kiteline-server.env`.
- `KITELINE_TRUST_PROXY_PROTO` accepts only `0` or `1`. Other values prevent startup with `KITELINE_TRUST_PROXY_PROTO must be 0 or 1`. See [HTTPS and reverse proxies](server.en.md#https-and-reverse-proxies) for when to use `1`.

The repository's original `deploy/compose.yaml` also reads:

| Variable                     | Default                    | Description                                                                                 |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `KITELINE_VERSION`           | None                       | Image tag: release version for official images, `<version>-<architecture>` for local builds |
| `KITELINE_IMAGE`             | `ghcr.io/azure99/kiteline` | Image path; can be local `kiteline-server` or a fork image                                  |
| `KITELINE_HTTP_BIND`         | `127.0.0.1`                | Host address for the published port                                                         |
| `KITELINE_HTTP_PORT`         | `8080`                     | Host port, mapped to container port 8080                                                    |
| `KITELINE_TRUST_PROXY_PROTO` | `0`                        | Passed to the server inside the container                                                   |

`KITELINE_VERSION` is required, or Compose reports `Set KITELINE_VERSION to the release version`. Compose uses `KITELINE_IMAGE:KITELINE_VERSION`, not `KITELINE_ARCH`. Native-package download examples still use `KITELINE_ARCH` to choose the archive.

## Agent environment variables

| Variable                 | Default                                                                                                  | Description          |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------- |
| `KITELINE_AGENT_HOME`    | Linux/macOS: `<project user HOME>/.local/share/kiteline-agent`; Windows: `%LOCALAPPDATA%\kiteline-agent` | Agent data directory |
| `KITELINE_AGENT_RUN_DIR` | `<agent data directory>/run`                                                                             | Runtime directory    |

Directories are resolved in this order, with the first value found taking precedence:

1. Process environment variables `KITELINE_AGENT_HOME` and `KITELINE_AGENT_RUN_DIR`. `attach --run-dir` has higher precedence for the runtime directory.
2. `/etc/kiteline-agent.env` on Linux/macOS; directories written by `install` in `installation.json` on Windows.
3. The defaults above. On Linux/macOS, HOME comes from the project user in the installation record, regardless of the command's `HOME` environment variable.

`run`, local commands and background services must resolve the same directories, or local commands cannot find the agent. Runtime path length is limited (see [Limits](#limits)); exceeding it reports `KITELINE_AGENT_RUN_DIR is too long`.

Unset both variables in the current shell before running the web-generated install command or Windows upgrade command, or it reports `… uses the installation configuration`. Customize directories through the [directory configuration file](#directory-configuration-file) on Linux/macOS, and `install --data-dir`/`--run-dir` on Windows.

### Directory configuration file

`install` creates this file if absent, writing one comment and `KITELINE_AGENT_HOME`; existing content is unchanged. In either case, it sets owner `root`, group to the project user's primary group, and permissions to `0640`. Editing requires root. The agent reads only `KITELINE_AGENT_HOME` and `KITELINE_AGENT_RUN_DIR`, ignoring other lines:

```sh
# Replace with the actual directories
KITELINE_AGENT_HOME="/srv/kiteline/agent"
KITELINE_AGENT_RUN_DIR="/srv/kiteline/run"
```

Each key may appear at most once. The entire line must be `KEY="/absolute/path"`, starting in the first column, without `export`, with a double-quoted path containing no quotes or backslashes and no trailing comment. An invalid format makes agent commands fail with this rule in the error. Set other service environment variables in the service configuration; see [Run in the background](devices.en.md#run-in-the-background).

### Other variables

| Variable                                                                 | Purpose                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` and lowercase forms | Outbound proxies for agent-to-server connections; see [Outbound proxies and certificates](devices.en.md#outbound-proxies-and-certificates)                                         |
| `NODE_EXTRA_CA_CERTS`                                                    | CA certificate file for a server certificate issued by a private CA, on Linux/macOS only; see [Outbound proxies and certificates](devices.en.md#outbound-proxies-and-certificates) |
| `LANG`, `LC_ALL`, `LC_CTYPE`                                             | `check` and `doctor` require UTF-8                                                                                                                                                 |
| `PATH`                                                                   | Used to locate Git, SSH and Windows `pwsh.exe`                                                                                                                                     |
| `SSH_AUTH_SOCK`                                                          | On Linux/macOS, `doctor` checks that it points to an accessible socket; Git uses it for SSH agent access                                                                           |

Terminal sessions and scheduled tasks inherit the agent process's environment. Restart the agent after environment changes.

## Agent configuration file

`config.json` is in the agent data directory and is not created automatically. It is a JSON object with optional `shell` and `limits` keys:

```json
{
  "shell": "/bin/bash",
  "limits": {
    "editorBytes": 4194304,
    "taskRunsPerDevice": 8
  }
}
```

`run` reads it only at startup; restart the agent for changes to take effect. Other commands that read configuration, such as `bind`, `terminal` and `schedule`, also fail if it is invalid. Invalid values report `Invalid <key>`; with no running agent, `doctor` reports a `Configuration on disk` error.

### Shell

`shell` is the shell for terminal sessions and scheduled tasks, and must be an absolute path. Linux/macOS default to the project user's login shell in the system account database, falling back to `/bin/sh` if unavailable. Windows searches `PATH` for `pwsh.exe`; if absent it reports `PowerShell 7 is required; add pwsh.exe to PATH or configure an absolute shell path`.

| Use              | Linux/macOS         | Windows                                             |
| ---------------- | ------------------- | --------------------------------------------------- |
| Terminal session | `SHELL -l`          | `SHELL -NoLogo`                                     |
| Shortcut         | `SHELL -lc COMMAND` | `SHELL -NoLogo -Command COMMAND`                    |
| Scheduled task   | `SHELL -c COMMAND`  | `SHELL -NoProfile -NonInteractive -Command COMMAND` |

On Windows the shell must accept these PowerShell arguments; `check` requires PowerShell 7.4 or later. See [Execution environment](scheduled-tasks.en.md#execution-environment) for scheduled tasks.

### Limit settings

Every `limits` value is an integer of at least 1. Names ending in `Bytes` use bytes; names ending in `Timeout` use milliseconds; `imagePixels` counts pixels; all others are counts. `tasksPerDevice` has a maximum of 300, `rpcTimeout` a maximum of 2147482647, and other `*Timeout` keys a maximum of 2147483647. Other keys have no upper bound. Unlisted keys are ignored. See [Limits](#limits) for available keys, defaults and meanings.

Lowering `tasksPerDevice` restricts only new tasks; existing tasks remain manageable. Lowering output limits affects only subsequently written output.

### Agent-managed files

The agent reads and writes `agent.json`, `connection.json`, `temporary-files.json` and `tasks/`; do not edit them manually. Workspace registrations, shortcuts and "Scrollback lines for new sessions" are in `agent.json`; change them through workspace management and "Terminal settings" in the web app.

## Limits

This section lists limits relevant to configuration, capacity and troubleshooting. The configuration column gives keys under `limits` in `config.json` (see [Agent configuration file](#agent-configuration-file)). Non-configurable entries are marked fixed.

### Sign-in and binding

| Item                       | Value                                                      | Configuration |
| -------------------------- | ---------------------------------------------------------- | ------------- |
| Setup token lifetime       | 30 minutes                                                 | Fixed         |
| Binding code lifetime      | 10 minutes                                                 | Fixed         |
| Login lifetime             | 30 days from sign-in, not extended by use                  | Fixed         |
| Owner password             | 8 to 72 bytes (UTF-8)                                      | Fixed         |
| Sign-in and setup attempts | 10 per source per minute, 30 across all sources per minute | Fixed         |
| Binding attempts           | Same as sign-in, counted separately                        | Fixed         |

A source is the TCP peer address connected to the server. Requests arriving through the same reverse-proxy address share one per-source allowance.

### Terminal

| Item                            | Value                                                   | Configuration               |
| ------------------------------- | ------------------------------------------------------- | --------------------------- |
| Terminal sessions per device    | 32                                                      | `terminalSessionsPerDevice` |
| Single paste and queued input   | 256 KiB                                                 | `terminalInputBytes`        |
| New-session scrollback lines    | Default 10,000; range 0 to 50,000                       | Web "Terminal settings"     |
| Browser stops processing output | Display disconnects after 10 seconds; session continues | `terminalStallTimeout`      |
| Runtime directory path          | 76 bytes (UTF-8)                                        | Fixed                       |

### Files

| Item                               | Value                                                               | Configuration               |
| ---------------------------------- | ------------------------------------------------------------------- | --------------------------- |
| Open, edit and save text           | 2 MiB, measured with the encoding and line endings used when saving | `editorBytes`               |
| Individual upload or download      | 1 GiB                                                               | `transferBytes`             |
| Concurrent file transfers          | 4                                                                   | `transfersPerDevice`        |
| Image preview                      | 20 MiB and at most 20,000,000 pixels                                | `imageBytes`, `imagePixels` |
| Transfer timeout without progress  | 120 seconds                                                         | Fixed                       |
| One copy, move or delete operation | 500 entries                                                         | Fixed                       |
| Search results                     | 1,000 matches                                                       | Fixed                       |
| Search duration                    | 10 seconds; returns matches found before timeout                    | `searchTimeout`             |

Opening text, saving, image previews, uploads and downloads all consume concurrent file-transfer slots.

### Git

| Item                                          | Value                                                           | Configuration     |
| --------------------------------------------- | --------------------------------------------------------------- | ----------------- |
| Paths per stage, unstage or discard operation | 1,000                                                           | Fixed             |
| One diff                                      | Approximately 512 KiB; excess is truncated                      | Fixed             |
| Structured diff display                       | 2,000 lines; beyond this, displays the first 32 KiB of raw text | Fixed             |
| Write deadline                                | 10 minutes                                                      | `gitWriteTimeout` |
| Read deadline                                 | 30 seconds                                                      | `rpcTimeout`      |

Writes include stage, unstage, discard, commit, branch operations, fetch, pull, push, and continuing or aborting an operation in progress.

### Scheduled tasks

| Item                               | Value                                    | Configuration          |
| ---------------------------------- | ---------------------------------------- | ---------------------- |
| Tasks per device                   | 100                                      | `tasksPerDevice`       |
| Concurrent runs per device         | 4; runs needing review also occupy slots | `taskRunsPerDevice`    |
| Finished records retained per task | 20, including skipped records            | `taskHistoryRuns`      |
| Output per run                     | 1 MiB combined stdout and stderr         | `taskOutputBytes`      |
| Total retained output per device   | 128 MiB                                  | `taskOutputTotalBytes` |
| Task name                          | 256 bytes (UTF-8)                        | Fixed                  |
| Command                            | 16 KiB                                   | Fixed                  |
| Cron expression                    | 256 characters                           | Fixed                  |
| Scheduled-time lateness tolerance  | 5 seconds                                | Fixed                  |
| TERM-to-KILL stop grace period     | 5 seconds                                | Fixed                  |

### Connections and requests

| Item                              | Value                                                                            | Configuration |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------- |
| General device-operation deadline | 30 seconds                                                                       | `rpcTimeout`  |
| Concurrent requests per device    | 32                                                                               | Fixed         |
| Data channels per device          | 128 total for terminal displays, file transfers and development-service requests | Fixed         |
| One request or result             | 1 MiB; oversized requests return 413, oversized results are unconfirmed          | Fixed         |

General device operations include file listing and renaming, Git reads, scheduled-task management and local CLI requests. Copy, move and delete have no overall deadline.

## File locations

### Agent on Linux and macOS

| Path                                                | Content                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/opt/kiteline-agent/`                              | Installation directory, owned by root                                                    |
| `/usr/local/bin/kiteline-agent`                     | Public launcher                                                                          |
| `/etc/kiteline-agent.json`                          | Installation record: project user, UID, GID, HOME                                        |
| `/etc/kiteline-agent.env`                           | Directory configuration; see [Agent environment variables](#agent-environment-variables) |
| `/opt/.kiteline-agent-use.lock`                     | Use lock, held by every running `kiteline-agent` command                                 |
| `/opt/.kiteline-agent-install.lock`                 | Mutual-exclusion lock for install, upgrade and uninstall                                 |
| `/opt/kiteline-agent/deploy/kiteline-agent.service` | systemd example (Linux package)                                                          |
| `/opt/kiteline-agent/deploy/kiteline-agent.plist`   | launchd example (macOS package)                                                          |

See [Uninstall](devices.en.md#uninstall) for files retained after removal. If upgrading fails and the old programs cannot be restored automatically, output identifies the backup directory retained under `/opt`.

### Agent on Windows

| Path                                                      | Content                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| `%ProgramFiles%\kiteline-agent\`                          | Installation directory                                      |
| `%ProgramData%\kiteline-agent\kiteline-agent.ps1`         | Public launcher                                             |
| `%ProgramData%\kiteline-agent\installation.json`          | Installation record, including data and runtime directories |
| `%ProgramData%\kiteline-agent\use.lock`                   | Use lock                                                    |
| `%ProgramData%\kiteline-agent\management.lock`            | Mutual-exclusion lock for install, upgrade and uninstall    |
| `%ProgramFiles%\kiteline-agent\deploy\kiteline-agent.xml` | WinSW example                                               |
| `%LOCALAPPDATA%\kiteline-agent\`                          | Default agent data directory                                |

### Agent data directory

| File                               | Content                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `agent.json`                       | Workspaces, shortcuts and terminal settings                                               |
| `connection.json`                  | Server address, device ID and credentials; permissions `0600`                             |
| `config.json`                      | Manually created configuration; see [Agent configuration file](#agent-configuration-file) |
| `temporary-files.json`             | Temporary-file registrations for file writes                                              |
| `tasks/`                           | Scheduled tasks: `TASK_ID.json`, `RUN_ID.stdout`, `RUN_ID.stderr`                         |
| `process.lock`                     | Lock held while running or binding the agent                                              |
| `run/`                             | Default runtime directory                                                                 |
| `launchd.log`, `launchd-error.log` | Logs when using the launchd example                                                       |

Data directory permissions are `0700` (on Windows, only the project user, SYSTEM and administrators have access). Keep `connection.json`, `agent.json`, `config.json` and `tasks/` when backing up a device.

### Runtime directory

| File                   | Content                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `agent.sock`           | Socket used by local commands to reach the agent (Linux/macOS)   |
| `agent.sock.lock`      | Lock allowing only one agent per runtime directory (Linux/macOS) |
| `SESSION_ID/tmux.sock` | Session's tmux socket                                            |
| `SESSION_ID/tmux.conf` | Session's tmux configuration                                     |
| `SESSION_ID/pane.json` | Session startup arguments and environment variables (Windows)    |

The agent deletes a session's `SESSION_ID/` directory when it ends. On Windows the runtime directory contains only session directories; local commands connect through a named pipe.

### Server

| Path                                       | Content                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `/opt/kiteline-server/`                    | Native package installation directory                             |
| `/opt/kiteline-server/bin/kiteline-server` | Native package launcher                                           |
| `/etc/kiteline-server.env`                 | Native deployment environment file                                |
| `/var/lib/kiteline/kiteline.sqlite`        | WAL-mode database; also has `-wal` and `-shm` files while running |
| `/var/lib/kiteline/process.lock`           | Lock held by server and maintenance commands                      |

With Docker, the server data directory is `/var/lib/kiteline` inside the container, backed by Compose volume `kiteline_server-data`. See [Backup and restore](server.en.md#backup-and-restore).

## Troubleshooting

Original errors are in English; this table quotes their key parts.

| Symptom or error                                                                                    | Cause                                                                                                                      | Action                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Device shows "Version mismatch"; agent log says `HTTP 426. agent version … does not match server …` | Agent and server versions differ                                                                                           | [Upgrade the agent](devices.en.md#upgrade-the-agent)                                                                        |
| Web page says "Web … / Server …: remote operations are paused."                                     | The page still has the old version after a server upgrade                                                                  | Copy unsaved content, then click "Reload page"                                                                              |
| Setup or sign-in says "This request is not allowed." `[forbidden] Origin mismatch`                  | `KITELINE_TRUST_PROXY_PROTO=1` is not set, or the proxy rewrites `Host`                                                    | Correct it and restart the server; see [HTTPS and reverse proxies](server.en.md#https-and-reverse-proxies)                  |
| 400 `Invalid X-Forwarded-Proto`                                                                     | Proxy appends instead of replacing the header, or the value is not a single `http` or `https`                              | Have the proxy replace it with `https`; see [HTTPS and reverse proxies](server.en.md#https-and-reverse-proxies)             |
| Web page opens, but terminals cannot connect and devices stay offline                               | Proxy does not forward WebSocket Upgrade                                                                                   | Enable WebSocket forwarding; see [HTTPS and reverse proxies](server.en.md#https-and-reverse-proxies)                        |
| Downloads or development pages do not respond for a long time; large uploads fail                   | Proxy buffers requests/responses or limits upload size                                                                     | Disable buffering and allow upload size; see [HTTPS and reverse proxies](server.en.md#https-and-reverse-proxies)            |
| 400 `Invalid Host header`                                                                           | Multiple Host headers or invalid characters in Host                                                                        | Check the proxy's Host settings                                                                                             |
| `Setup credentials are invalid or expired`                                                          | Token mistyped or expired                                                                                                  | Generate another; see [Reset the setup token or password](server.en.md#reset-the-setup-token-or-password)                   |
| `Already initialized`                                                                               | Owner password already set; `setup-token` is only available beforehand                                                     | Use `reset-password`                                                                                                        |
| `Lock file is already being held`                                                                   | A server or agent already uses the same data directory                                                                     | Stop the running process first                                                                                              |
| 429 `Too many attempts; try again later`                                                            | Attempts exceed the per-minute limit                                                                                       | Wait a minute before retrying                                                                                               |
| `Binding code is invalid, expired, or already used`                                                 | Binding code expired or used                                                                                               | Generate a new command in the web app; see [Connect using the web command](devices.en.md#connect-using-the-web-command)     |
| `This installation is already bound`                                                                | Install command uses `--if-unbound`, but device is already bound                                                           | Run `kiteline-agent run`; to rebind, see [Bind again](devices.en.md#bind-again)                                             |
| `Binding result is unknown`                                                                         | Connection lost after sending the binding request                                                                          | Check the web device list; see [Bind again](devices.en.md#bind-again)                                                       |
| `Device is not bound; run kiteline-agent bind`                                                      | No `connection.json` in the agent data directory                                                                           | Bind, or check that `KITELINE_AGENT_HOME` points to the original directory                                                  |
| Agent logs `HTTP 401. Invalid device credentials`, then `Remote connection stopped`                 | Device deleted in the web app, or credentials belong to another server                                                     | [Bind again](devices.en.md#bind-again)                                                                                      |
| `Remote connection stopped: … (4003: device_deleted)`                                               | Device deleted in the web app                                                                                              | [Bind again](devices.en.md#bind-again)                                                                                      |
| `Remote connection stopped: … (4001: connection_replaced)`                                          | Another agent with the same credentials connected, often from a machine/container with a copied data directory             | See [Bind again](devices.en.md#bind-again)                                                                                  |
| `UTF-8 locale: Character map is …`                                                                  | Startup locale is not UTF-8                                                                                                | Set an installed UTF-8 locale; see [Supported systems and prerequisites](devices.en.md#supported-systems-and-prerequisites) |
| `git: spawn git ENOENT`                                                                             | Git absent from startup `PATH`                                                                                             | Install Git or fix `PATH`; see [Supported systems and prerequisites](devices.en.md#supported-systems-and-prerequisites)     |
| `git: Native executable not found in the current PATH: git`                                         | Git absent from Windows startup `PATH`                                                                                     | Install Git or fix `PATH`                                                                                                   |
| `Agent installation is busy`; Windows: `Installation is busy`                                       | A `kiteline-agent` process still uses the installation during upgrade/uninstall                                            | Stop `run`, `attach` and services, then retry; see [Upgrade the agent](devices.en.md#upgrade-the-agent)                     |
| `… uses the installation configuration`                                                             | Install-command shell has `KITELINE_AGENT_HOME` or `KITELINE_AGENT_RUN_DIR` set                                            | Unset both; see [Agent environment variables](#agent-environment-variables) for customization                               |
| Local command reports `connect ENOENT …/agent.sock` or `connect ECONNREFUSED …/agent.sock`          | Agent stopped (`ECONNREFUSED` indicates a stale socket after abnormal exit), or command resolves another runtime directory | Start the agent; match the user and directories used by `run`                                                               |
| `Device channel limit reached`                                                                      | Simultaneous terminal displays, file transfers and development requests reach the device limit                             | Close unused terminal displays and pages                                                                                    |
| Terminal sessions remain after abnormal agent exit                                                  | Forced termination or crash does not clean up sessions                                                                     | See [Clean up leftover terminal sessions](#clean-up-leftover-terminal-sessions)                                             |
| "Scheduled task storage is unavailable on this device."                                             | Agent cannot read files in `tasks/`                                                                                        | See [Review after an agent restart](scheduled-tasks.en.md#review-after-an-agent-restart)                                    |

With the agent running, `kiteline-agent doctor` shows server connection status and the latest connection error. Start there when diagnosing an offline device.

### Clean up leftover terminal sessions

Forced termination or an agent crash, including directly closing a foreground agent's PowerShell window on Windows, does not clean up terminal sessions:

- Linux/macOS: each session's tmux server is an independent daemon. It and its programs continue after an abnormal agent exit, and a new agent does not take them over. With the example systemd unit, systemd terminates these tmux servers under `KillMode=control-group` as soon as the agent's main process exits, including a crash. They remain with foreground execution, launchd, or a container that keeps running after the agent exits. A container whose main process is the agent, such as the example in [Run in a container](devices.en.md#run-in-a-container), stops entirely when the agent exits, ending its processes too.
- Windows: session programs end with the agent, but session directories remain in the runtime directory. Their `pane.json` contains the agent's complete environment, potentially including sensitive information such as tokens.

Before cleanup, confirm no agent is using this runtime directory: `kiteline-agent terminal list` should report `connect ENOENT` or `connect ECONNREFUSED`.

On Linux/macOS, run as the project user:

```sh
RUN_DIR="$HOME/.local/share/kiteline-agent/run"     # Replace with the actual runtime directory
TMUX_BIN=/opt/kiteline-agent/dist/native/bin/tmux   # If not installed, use dist/native/bin/tmux in the extracted directory
if [ -x "$TMUX_BIN" ]; then
  for socket in "$RUN_DIR"/*/tmux.sock; do
    [ -S "$socket" ] || continue
    "$TMUX_BIN" -S "$socket" kill-server 2>/dev/null
    if "$TMUX_BIN" -S "$socket" list-sessions 2>&1 | grep -q 'no server running'; then
      rm -r -- "$(dirname -- "$socket")"
    fi
  done
else
  echo "tmux not found: $TMUX_BIN" >&2
fi
```

`kill-server` ends the programs in the session. The script removes a session directory only after confirming the server is absent (`no server running`). Session directories without `tmux.sock` can be removed directly. To preserve programs in a session, first attach with `"$TMUX_BIN" -S <socket> attach-session -t kiteline` and handle them, then run the script.

On Windows, run in PowerShell 7 as the project user to delete session directories inside the runtime directory:

```powershell
$RunDir = "$env:LOCALAPPDATA\kiteline-agent\run"   # Replace with the actual runtime directory
Get-ChildItem -LiteralPath $RunDir -Directory |
  Where-Object Name -Match '^[0-9a-f]{16}$' |
  Remove-Item -Recurse -Force
```
