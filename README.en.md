# Kiteline

[中文](README.md)

Kiteline is a self-hosted workbench for coding agents. Claude Code, Codex, and other command-line tools run with their native TUIs on your own machines. Manage multiple machines and projects from your browser, and continue the same terminal session on desktop, phone, or the remote CLI.

<p align="center">
  <a href="docs/assets/readme-desktop.png"><img src="docs/assets/readme-desktop.png" width="820" alt="Desktop: Codex, development preview server, and tests in three panes for Lantern Studio, with a workspace notification in the sidebar"></a>
</p>

<table align="center">
  <tr>
    <td nowrap>
      <a href="docs/assets/readme-mobile-terminal.png"><img src="docs/assets/readme-mobile-terminal.png" width="260" alt="Continuing the same Lantern Studio Codex session on a phone, with the task title in the toolbar"></a>
      <a href="docs/assets/readme-mobile-files.png"><img src="docs/assets/readme-mobile-files.png" width="260" alt="Mobile file manager showing file type icons and expanded workspace notifications, with devices without notifications collapsed"></a>
      <a href="docs/assets/readme-mobile-git.png"><img src="docs/assets/readme-mobile-git.png" width="260" alt="Viewing the Git diff for gallery.test.js in Lantern Studio on a phone"></a>
    </td>
  </tr>
</table>

- **Native TUIs**: agents run in real terminals, preserving their original interfaces and interactions and using each machine's existing toolchain and environment.
- **Devices and workspaces**: connect Linux, Windows, and macOS machines and switch between project workspaces. Sessions keep running as you move between desktop and phone.
- **Remote CLI**: attach to the same session from your local terminal, or use short commands to send input, inspect output, and upload or download files.
- **Terminal notifications**: see notifications and waiting reports sent by programs in the workspace list, and return to the source terminal with a click.
- **Terminals, files, and Git**: group and split terminals, edit files, preview images and Markdown/HTML drafts, and inspect Git changes while agent sessions keep running.
- **Development previews**: access Web services on your machines from the browser, with WebSocket and hot reload support.
- **Scheduled tasks**: run scripts or agents on a cron schedule with a record of each run. Agents can also create scheduled tasks themselves.

## Get Started

Kiteline is for one developer. Use a Linux host with Docker for the server. On each development machine, install Git 2.23+, the shells your projects need, and a coding CLI you have signed in to. [System requirements](docs/guide/devices.en.md#supported-systems-and-prerequisites)

```sh
mkdir kiteline && cd kiteline
curl -fsSLO https://github.com/Azure99/kiteline/releases/latest/download/compose.yaml
docker compose up -d
docker compose logs server
```

1. Open `http://127.0.0.1:8080` and set your password with the setup token from the log, valid for 30 minutes. The default address is local to the host; before connecting other machines or phones, configure a reachable address and HTTPS using the [deployment guide](docs/guide/server.en.md).
2. Get the install command from "Connect device" and run it as your usual account on the development machine. Both browsers and devices must be able to reach the server address used to generate the command.
3. Add a project directory as a workspace and start your coding CLI in a terminal. Connect other machines and projects the same way.

The install command runs the agent in the foreground. For continued use, configure a background service using the [device guide](docs/guide/devices.en.md#run-in-the-background). The signed-in owner has the file and command permissions of the account running the agent.

## Documentation

[Workbench](docs/guide/usage.en.md) · [Device maintenance](docs/guide/devices.en.md) · [Scheduled tasks](docs/guide/scheduled-tasks.en.md) · [Remote CLI](docs/guide/cli.en.md) · [Commands and configuration](docs/guide/reference.en.md) · [Development docs (Chinese)](docs/README.md)

## License

[Apache-2.0](LICENSE). See [artifact layout (Chinese)](docs/development/release.md#产物结构) for third-party licenses and sources.
