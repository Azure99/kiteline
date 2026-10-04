# Kiteline

[English](README.en.md)

Kiteline 是一个单人自托管的远程工作台。在桌面或手机浏览器里，你可以使用多台 Linux、Windows 和 macOS 设备上的终端、文件、Git 和本地开发服务，并管理设备上的定时任务。

## 功能

- **终端**：真实 Shell 运行在设备上。关闭浏览器、断网或切换页面都不会结束会话；同一会话可以同时在网页和设备本机终端里使用。桌面支持分组和分屏，手机提供触控与按键辅助。
- **文件**：浏览工作区目录，编辑文本，预览图片，按文件名或内容搜索，上传下载，复制、移动、重命名和删除。
- **Git**：查看状态和 diff，暂存、提交、切换分支、查看历史，fetch、pull、push，处理冲突。使用设备上已有的 Git 配置和凭据。
- **开发服务**：在浏览器中打开设备上监听本地端口的 HTTP 服务，支持 WebSocket 和热更新。
- **定时任务**：在设备上按 cron 计划运行命令，在网页或命令行中管理。
- **多设备、多工作区**：一个工作台管理多台设备；每台设备可以登记多个项目目录作为工作区。
- **界面语言**：简体中文和英文。

## 工作方式

```text
浏览器 ──HTTP(S)/WebSocket──▶ server ◀──WebSocket（设备主动连接）── agent ── 设备上的 Shell、文件、Git
```

- **server**（`kiteline-server`）运行在 Linux 上，提供网页、API 和设备连接。它只保存拥有者密码、登录会话、设备登记和定时任务摘要等管理信息；文件内容、终端输出和 Git 数据在设备上处理，经 server 转发但不保存。
- **agent**（`kiteline-agent`）以你指定的操作系统账户运行在每台设备上，主动连接 server，设备不需要开放入站端口。
- 工作台只有一个拥有者。登录后，拥有者能以 agent 运行账户（项目用户）的权限在设备上执行任何操作；工作区只是登记的目录，不是隔离边界。server 本身只提供 HTTP，公网访问时请放在 HTTPS 反向代理之后。

## 支持的平台

| 组件   | 平台                                                                   |
| ------ | ---------------------------------------------------------------------- |
| server | Linux amd64、arm64（Docker 镜像或原生发布包）                          |
| agent  | Linux amd64、arm64（Ubuntu 24.04、Debian 12、Alpine 3.23、CentOS 7.9） |
| agent  | Windows 11 x64                                                         |
| agent  | macOS 14 及以上（Intel、Apple Silicon）                                |
| 浏览器 | 桌面 Chrome、Android Chrome；最低 Chromium 97                          |

设备需要自备 Git 2.23.0 及以上版本和项目使用的 Shell；Node.js、tmux、ripgrep 等运行组件已随 agent 发布包提供。各系统的完整要求见[接入设备](docs/guide/devices.md#支持的系统与准备)。

## 快速开始

1. 在一台 Linux 主机上用 Docker 启动 server（把 `0.2.5` 换成要部署的版本）：

   ```sh
   mkdir kiteline && cd kiteline
   curl -fsSLO https://raw.githubusercontent.com/Azure99/kiteline/v0.2.5/deploy/compose.yaml
   sed -i 's|kiteline-server:|ghcr.io/azure99/kiteline:|; s|-${KITELINE_ARCH:-amd64}||' compose.yaml
   echo KITELINE_VERSION=0.2.5 > .env
   docker compose up -d
   docker compose logs server
   ```

   server 默认只监听本机的 `127.0.0.1:8080`。要从局域网中的其他机器访问，在 `.env` 中再加一行 `KITELINE_HTTP_BIND=0.0.0.0` 后重新执行 `docker compose up -d`。这会以明文 HTTP 开放端口，Docker 发布的端口也不受 ufw、firewalld 等主机防火墙限制，只在可信网络中这样做；HTTPS 和原生部署见[部署 server](docs/guide/server.md)。

2. 在浏览器中打开 server 的地址（在 server 主机上是 `http://127.0.0.1:8080`），输入日志中的初始化 token（30 分钟内有效），设置拥有者密码。
3. 在工作台点击“绑定设备”，选择设备的系统，点击“复制接入命令”，在设备上以日常使用的账户执行。命令会检查环境、安装 agent、完成绑定并在前台运行 agent。设备必须能访问你打开工作台时使用的地址：从 `127.0.0.1` 或 `localhost` 打开时生成的命令只能在 server 主机上使用。详见[接入设备](docs/guide/devices.md)。
4. 设备上线后添加工作区，即可使用终端、文件和 Git。功能说明见[使用工作台](docs/guide/usage.md)。

前台运行的 agent 会随终端关闭而停止，并结束它的终端会话。长期使用时按[后台运行](docs/guide/devices.md#后台运行)把 agent 配置为服务。

## 文档

| 我想……                       | 阅读                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| 部署和维护 server            | [部署 server](docs/guide/server.md)                                          |
| 接入设备、后台运行、升级卸载 | [接入设备](docs/guide/devices.md)                                            |
| 了解各项功能                 | [使用工作台](docs/guide/usage.md)、[定时任务](docs/guide/scheduled-tasks.md) |
| 查命令、配置、限额和报错     | [参考](docs/guide/reference.md)                                              |
| 从源码开发                   | [源码开发](docs/development/setup.md)                                        |
| 构建发布包                   | [构建与发布](docs/development/release.md)                                    |
| 理解架构和行为契约           | [文档地图](docs/README.md)                                                   |

## 参与开发

开发环境、本地运行和提交前检查见[源码开发](docs/development/setup.md)。改动某个模块前，先阅读[文档地图](docs/README.md#改动代码前阅读)中对应的设计文档。

## 许可证

Kiteline 使用 [Apache-2.0](LICENSE) 许可证。发布包中的第三方组件保留各自的许可证，位置见[产物结构](docs/development/release.md#产物结构)。
