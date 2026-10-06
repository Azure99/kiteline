# 部署示例

本目录存放部署 server 和让 agent 后台运行的示例配置。使用步骤见[部署 server](../docs/guide/server.md) 和[接入设备](../docs/guide/devices.md)。

| 文件                              | 用途                                       | 随哪个发布包分发 |
| --------------------------------- | ------------------------------------------ | ---------------- |
| `compose.yaml`                    | 用 Docker Compose 运行 server              | 无               |
| `systemd/kiteline-server.service` | 用 systemd 运行原生部署的 server           | 无               |
| `systemd/kiteline-agent.service`  | 用 systemd 在 Linux 上后台运行 agent       | Linux agent 包   |
| `launchd/kiteline-agent.plist`    | 用 launchd 在 macOS 上后台运行 agent       | macOS agent 包   |
| `winsw/kiteline-agent.xml`        | 用 WinSW 2.12 把 agent 注册为 Windows 服务 | Windows agent 包 |

每个 agent 发布包只含对应平台的一个示例，位于包内和程序目录的 `deploy/` 中（安装后的路径见[文件位置](../docs/guide/reference.md#文件位置)）。

server 发布包和镜像不含本目录的文件。`compose.yaml` 和 server 的 unit 从与部署版本相同的仓库 tag 下载，命令见[部署 server](../docs/guide/server.md)。

示例中的 `YOUR_PROJECT_USER`、`PROJECT_USER` 等占位符需要替换为实际值。agent 的程序目录在升级时整体替换，修改示例前先把它复制到程序目录之外。
