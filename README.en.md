# Kiteline

[中文](README.md)

Kiteline is a self-hosted, single-user remote workbench. From a desktop or phone browser, you can use the terminals, files, Git repositories and local development servers on several Linux, Windows and macOS machines, and manage scheduled commands on them.

Deployment and usage guides, including the command and troubleshooting reference, are available in English and Chinese. Design and development documents remain in Chinese.

## Features

- **Terminal**: real shells run on the device. Closing the browser, losing the network or switching pages does not end a session, and the same session can be used from the web and from a local terminal on the device at the same time. Desktop layouts support grouped and split terminals; phones get touch and key helpers.
- **Files**: browse workspace directories, edit text, preview images, search by name or content, upload and download, and copy, move, rename or delete.
- **Git**: view status and diffs, stage, commit, switch branches, read history, fetch, pull and push, and resolve conflicts, using the Git configuration and credentials already on the device.
- **Development servers**: open HTTP services listening on a device's local ports in the browser, including WebSocket and hot reload.
- **Scheduled tasks**: run commands on a device on a cron schedule, managed from the web or the command line.
- **Multiple devices and workspaces**: one workbench manages many devices; each device can register several project directories as workspaces.
- **Languages**: the interface is available in English and Simplified Chinese.

## How it works

```text
browser ──HTTP(S)/WebSocket──▶ server ◀──WebSocket (opened by the device)── agent ── shell, files, Git on the device
```

- The **server** (`kiteline-server`) runs on Linux and serves the web app, the API and device connections. It stores only management data: the owner password, login sessions, registered devices and scheduled-task summaries. File contents, terminal output and Git data are handled on the device; they pass through the server but are not stored there.
- The **agent** (`kiteline-agent`) runs on each device under the **project user**, the operating-system account you normally use that owns your project files. It connects out to the server, so devices need no inbound ports.
- The workbench has a single owner. Once logged in, the owner can do anything the project user can do on that device; a workspace is a registered directory, not an isolation boundary. The server speaks plain HTTP; put it behind an HTTPS reverse proxy for access over the internet.

## Supported platforms

| Component | Platforms                                                             |
| --------- | --------------------------------------------------------------------- |
| server    | Linux amd64, arm64 (Docker image or native package)                   |
| agent     | Linux amd64, arm64 (Ubuntu 24.04, Debian 12, Alpine 3.23, CentOS 7.9) |
| agent     | Windows 11 x64                                                        |
| agent     | macOS 14 or later (Intel, Apple Silicon)                              |
| browser   | Desktop Chrome, Android Chrome; Chromium 97 or later                  |

Devices must provide Git 2.23.0 or later and the shells your projects use. Node.js, tmux, ripgrep and the other runtime components ship with the agent package. Per-system requirements are in [Connect devices](docs/guide/devices.en.md#supported-systems-and-prerequisites).

## Quick start

1. Start the server with Docker on a Linux host:

   ```sh
   mkdir kiteline && cd kiteline
   KITELINE_VERSION=0.2.5 # Replace with the version you deploy
   curl -fsSLO "https://raw.githubusercontent.com/Azure99/kiteline/v$KITELINE_VERSION/deploy/compose.yaml"
   printf 'KITELINE_VERSION=%s\n' "$KITELINE_VERSION" > .env
   docker compose up -d
   docker compose logs server
   ```

   By default the server listens only on `127.0.0.1:8080`. To reach it from other machines on your network, add the line `KITELINE_HTTP_BIND=0.0.0.0` to `.env` and run `docker compose up -d` again. This exposes plain HTTP, and ports published by Docker bypass host firewalls such as ufw and firewalld, so do this only on a trusted network. For HTTPS or a native installation, see [Deploy the server](docs/guide/server.en.md).

2. Open the server's address in a browser (`http://127.0.0.1:8080` on the server host), enter the setup token from the log (valid for 30 minutes) and set the owner password.
3. In the workbench, click “Connect device”, choose the device's operating system, click “Copy install command” and run the command on the device as the project user. It checks the environment, installs the agent, binds it and runs it in the foreground. The device must be able to reach the address you opened the workbench with: a command generated from `127.0.0.1` or `localhost` works only on the server host. See [Connect devices](docs/guide/devices.en.md).
4. When the device is online, add a workspace and start using the terminal, files and Git. See [Use the workbench](docs/guide/usage.en.md).

An agent running in the foreground stops when its terminal closes, which also ends its terminal sessions. For long-term use, run it as a service; see [Run in the background](docs/guide/devices.en.md#run-in-the-background).

## Documentation

| Task                                                | Document                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Deploy and maintain the server                      | [Deploy the server](docs/guide/server.en.md)                                                     |
| Connect devices, run in the background, upgrade     | [Connect devices](docs/guide/devices.en.md)                                                      |
| Learn the features                                  | [Use the workbench](docs/guide/usage.en.md), [Scheduled tasks](docs/guide/scheduled-tasks.en.md) |
| Look up commands, settings, limits and errors       | [Reference](docs/guide/reference.en.md)                                                          |
| Develop from source                                 | [Development setup (Chinese)](docs/development/setup.md)                                         |
| Build release packages                              | [Build and release (Chinese)](docs/development/release.md)                                       |
| Understand the architecture and behaviour contracts | [Documentation map (Chinese)](docs/README.md)                                                    |

## Contributing

Development setup, running locally and the checks to run before submitting are described in [Development setup (Chinese)](docs/development/setup.md). Before changing a module, read the matching design document listed in the [documentation map (Chinese)](docs/README.md#改动代码前阅读).

## License

Kiteline is licensed under [Apache-2.0](LICENSE). Third-party components in the release packages keep their own licenses; their locations are listed in [Artifacts (Chinese)](docs/development/release.md#产物结构).
