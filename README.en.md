# Kiteline

[中文](README.md)

Kiteline is a self-hosted workbench for coding agents. Claude Code, Codex, and any other command-line tools run with their native TUIs on your own machines. Manage multiple machines and projects from your browser, and move seamlessly between desktop and phone in the same terminal session.

<p align="center">
  <a href="docs/assets/readme-desktop.png"><img src="docs/assets/readme-desktop.png" width="820" alt="Desktop: the Lantern API project, three machines, ten workspaces, terminal groups, and one pane on the left with two stacked on the right"></a>
</p>

<p align="center">
  <a href="docs/assets/readme-mobile-terminal.png"><img src="docs/assets/readme-mobile-terminal.png" width="270" alt="Opening the same running Lantern API Codex session on a phone"></a>
  <a href="docs/assets/readme-mobile-files.png"><img src="docs/assets/readme-mobile-files.png" width="270" alt="Browsing Lantern API files on a phone"></a>
  <a href="docs/assets/readme-mobile-git.png"><img src="docs/assets/readme-mobile-git.png" width="270" alt="Viewing the Lantern API Git diff on a phone"></a>
</p>

- **Native TUIs**: agents run in real terminals, preserving their original interfaces and interactions. Any command-line tool works without adaptation.
- **Seamless switching**: open the same terminal session on your computer, phone, and the machine's local terminal at the same time. Output stays in sync, and tasks keep running as you switch devices.
- **Multiple machines and workspaces**: connect Linux, Windows, and macOS machines, switch between projects, and keep using each machine's existing toolchain and environment.
- **Terminals, files, and Git**: group and split terminals; the agent session keeps running while you inspect code changes and edit files.
- **Development previews**: access Web services running on your machines directly in the browser, with support for WebSocket and hot reload.
- **Scheduled tasks**: run scripts or agents on a cron schedule and keep a record of each run. Agents can also create tasks themselves.

## Get Started

Kiteline is for one developer. Use a Linux host with Docker for the server. On each development machine, install Git 2.23+, the shells your projects need, and a coding CLI you have signed in to. [System requirements](docs/guide/devices.en.md#supported-systems-and-prerequisites)

```sh
mkdir kiteline && cd kiteline
KITELINE_VERSION=0.2.5
curl -fsSLO "https://raw.githubusercontent.com/Azure99/kiteline/v$KITELINE_VERSION/deploy/compose.yaml"
printf 'KITELINE_VERSION=%s\n' "$KITELINE_VERSION" > .env
docker compose up -d
docker compose logs server
```

1. Open `http://127.0.0.1:8080` and set your password with the setup token from the log, valid for 30 minutes. The default address is local to the host; before connecting other machines or phones, configure a reachable address and HTTPS using the [deployment guide](docs/guide/server.en.md).
2. Get the install command from "Connect device" and run it as your usual account on the development machine. Both browsers and devices must be able to reach the server address used to generate the command.
3. Add a project directory as a workspace and start your coding CLI in a terminal. Connect other machines and projects the same way.

The install command runs the agent in the foreground. For continued use, configure a background service using the [device guide](docs/guide/devices.en.md#run-in-the-background). The signed-in owner has the file and command permissions of the account running the agent.

## Documentation

[Workbench](docs/guide/usage.en.md) · [Device maintenance](docs/guide/devices.en.md) · [Scheduled tasks](docs/guide/scheduled-tasks.en.md) · [Commands and configuration](docs/guide/reference.en.md) · [Development docs (Chinese)](docs/README.md)

## License

[Apache-2.0](LICENSE). See [artifact layout (Chinese)](docs/development/release.md#产物结构) for third-party licenses and sources.
