# 文档地图

Kiteline 的文档分为三组：使用与部署、开发与发布、架构与行为契约。项目简介和快速开始见[仓库首页](../README.md)。

## 使用与部署

| 文档                                                                          | 内容                                                                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [部署 server](guide/server.md) · [English](guide/server.en.md)                | Docker 与原生部署、初始化、HTTPS 反向代理、重置密码、备份、升级                    |
| [接入设备](guide/devices.md) · [English](guide/devices.en.md)                 | 各系统的准备、接入命令、手工安装、后台运行、代理与证书、容器、升级、卸载、重新绑定 |
| [使用工作台](guide/usage.md) · [English](guide/usage.en.md)                   | 设备与工作区、终端、文件、Git、访问开发服务                                        |
| [定时任务](guide/scheduled-tasks.md) · [English](guide/scheduled-tasks.en.md) | 创建任务、计划规则、执行环境、运行记录、命令行                                     |
| [参考](guide/reference.md) · [English](guide/reference.en.md)                 | 命令、环境变量、配置文件、限额、文件位置、常见问题                                 |

## 开发与发布

| 文档                                 | 内容                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| [源码开发](development/setup.md)     | 开发环境、本地运行、检查与测试、手工验证                  |
| [构建与发布](development/release.md) | 构建各平台发布包和镜像、CI 与发布流程、产物结构、依赖升级 |
| [构建输入](../release/README.md)     | `release/` 下每个固定输入文件的含义和更新方式             |
| [部署示例](../deploy/README.md)      | `deploy/` 下 Compose、systemd、launchd、WinSW 示例文件    |

## 架构与行为契约

这些文档说明各部分如何工作，以及修改代码时必须保持的行为。界面操作和用户能看到的结果写在使用与部署文档中；限额数值统一列在[参考](guide/reference.md#限额)。

| 文档                                          | 内容                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| [架构](design/architecture.md)                | 组成、仓库结构、状态归属、请求流程、技术选择、扩展清单       |
| [通信契约](design/protocol.md)                | 结果语义、认证、HTTP 接口、WebSocket、RPC、数据通道、IPC     |
| [终端](design/terminal.md)                    | tmux 与 recorder、会话生命周期、历史、附着与恢复、输入与尺寸 |
| [文件](design/files.md)                       | 列表、编辑与保存、整理操作、搜索、传输、变化监听             |
| [Git](design/git.md)                          | 仓库发现、状态与 diff、写操作、同步、冲突、刷新              |
| [开发服务访问](design/http-access.md)         | 代理路径、请求转发、端口建议、错误响应、安全边界             |
| [定时任务](design/scheduled-tasks.md)         | 数据模型、调度、并发、执行、持久化与恢复、留存               |
| [界面交互](design/interaction.md)             | 布局、导航、反馈、输入与焦点、语言、视觉                     |
| [agent 安装与运行](design/agent-lifecycle.md) | 安装布局、锁、安装升级卸载、启动停止、绑定与连接、目录权限   |
| [平台实现](design/platforms.md)               | Linux、macOS、Windows 各自的组件和差异                       |

## 改动代码前阅读

| 改动范围                                                                                                                                                     | 先读                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/protocol/`、`server/src/app.ts`、`http.ts`、`connections.ts`、`channels.ts`，`agent/src/agent.ts`、`local.ts`、`network.ts`                      | [通信契约](design/protocol.md)、[架构](design/architecture.md)                                                                     |
| `server/` 的其他文件、`deploy/compose.yaml`、`deploy/systemd/kiteline-server.service`                                                                        | [架构](design/architecture.md)、[部署 server](guide/server.md)                                                                     |
| `agent/src/terminal/`、`terminal-recorder/`、`shared/src/terminal/`、`web/src/terminal/`                                                                     | [终端](design/terminal.md)、[使用工作台](guide/usage.md#终端)                                                                      |
| `agent/src/files/`、`agent/src/watches.ts`、`web/src/files/`                                                                                                 | [文件](design/files.md)、[使用工作台](guide/usage.md#文件)                                                                         |
| `agent/src/git/`、`web/src/git/`                                                                                                                             | [Git](design/git.md)、[使用工作台](guide/usage.md#git)                                                                             |
| `agent/src/http/`、`server/src/http-proxy.ts`、`proxy-headers.ts`、`web/src/devices/port-dialog.tsx`、`web/src/lib/device-service.ts`                        | [开发服务访问](design/http-access.md)、[使用工作台](guide/usage.md#访问开发服务)                                                   |
| `agent/src/tasks/`、`agent/src/cli/tasks.ts`、`server/src/task-summary.ts`、`web/src/tasks/`                                                                 | [定时任务契约](design/scheduled-tasks.md)、[定时任务使用](guide/scheduled-tasks.md)                                                |
| `agent/src/install/`、`agent/src/cli/`、`agent/src/main.ts`、`agent/src/state-lock.ts`、`installer/`、`scripts/agent-launcher.ts`、`deploy/` 中的 agent 示例 | [agent 安装与运行](design/agent-lifecycle.md)、[接入设备](guide/devices.md)                                                        |
| `native/`、`shared/src/windows/`、`agent/src/process-group.ts`                                                                                               | [平台实现](design/platforms.md)                                                                                                    |
| `web/src/devices/`、`web/src/components/`、`web/src/i18n/`、`web/src/styles.css`                                                                             | [界面交互](design/interaction.md)、[前端约定](design/architecture.md#前端约定)、[本地 UI 组件](../web/src/components/ui/README.md) |
| `scripts/dev/`、`scripts/build-dev-native.mjs`                                                                                                               | [源码开发](development/setup.md)                                                                                                   |
| `scripts/` 的其他文件、`release/`、`.github/workflows/`、`shared/src/version.json`                                                                           | [构建与发布](development/release.md)、[构建输入](../release/README.md)                                                             |
| `server/src/limits.ts`、`agent/src/limits.ts`、`agent/src/config.ts`                                                                                         | [限额](guide/reference.md#限额)、[扩展清单](design/architecture.md#扩展清单)                                                       |
| `agent/src/` 的其他文件                                                                                                                                      | [架构](design/architecture.md)                                                                                                     |
| `web/src/` 的其他文件                                                                                                                                        | [界面交互](design/interaction.md)、[前端约定](design/architecture.md#前端约定)                                                     |

新增 RPC 方法、事件、数据通道、HTTP 路由或限额时，按[扩展清单](design/architecture.md#扩展清单)逐项修改。改动用户可见的行为、命令或配置时，同时更新对应的使用文档。

## 术语

| 术语            | 含义                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| 工作台          | 浏览器中的 Kiteline Web 应用                                                                            |
| server          | `kiteline-server`，提供网页、API、设备连接和开发服务代理的中心服务，运行在 Linux 上                     |
| agent           | `kiteline-agent`，运行在设备上的进程及其命令行，主动连接 server                                         |
| 设备            | 运行 agent 并已绑定到 server 的一台机器或一个容器                                                       |
| 入口            | 访问工作台的“协议 + 主机名 + 端口”组合，例如 `https://kiteline.example.com`；一个 server 可以有多个入口 |
| 公开入口        | 安装后的 `kiteline-agent` 启动脚本；具体路径见[文件位置](guide/reference.md#文件位置)                   |
| recorder        | 终端记录器（`terminal-recorder`），记录终端输出，供网页附着时恢复画面和历史                             |
| 拥有者          | 工作台唯一的用户                                                                                        |
| 项目用户        | 在设备上运行 agent 的操作系统账户；终端、文件和 Git 操作都以它的权限执行                                |
| 工作区          | 在设备上登记的一个项目目录，是切换工作的单位；可以不含 Git 仓库，也可以包含多个仓库                     |
| 工作树          | Git 的工作目录，包括 linked worktree                                                                    |
| 会话            | 一个受管的终端会话，即一个 tmux 会话及其中运行的程序                                                    |
| 登录会话        | 浏览器的登录状态，由登录 Cookie 标识，与终端会话无关                                                    |
| 附着            | 网页或设备本机终端连接到一个存活的会话；断开附着不会结束会话                                            |
| 本机接续        | 在设备本机终端用 `kiteline-agent attach` 附着到会话                                                     |
| 草稿            | 浏览器中某个文件尚未保存的内容，与磁盘内容和 Git 暂存区相互独立                                         |
| 定时任务        | 设备保存的命令计划；每次执行称为一次运行，结果保存为运行记录                                            |
| 绑定、绑定码    | 把 agent 登记为设备的过程，以及网页生成的一次性代码                                                     |
| 接入命令        | 网页生成的一行命令，依次完成检查、安装、绑定并在前台运行 agent                                          |
| 仅绑定命令      | 网页生成的、只检查并绑定的命令，不安装也不启动 agent（界面“已安装，仅绑定”）                            |
| 发布包          | `kiteline-agent-*` 或 `kiteline-server-*` 压缩包，内含运行所需的 Node.js 和组件                         |
| 程序目录        | 发布包安装后的目录，例如 `/opt/kiteline-agent`                                                          |
| server 数据目录 | `KITELINE_DATA_DIR`，保存 server 的 SQLite 数据库，默认 `/var/lib/kiteline`                             |
| agent 数据目录  | `KITELINE_AGENT_HOME`，保存设备身份、配置、工作区和定时任务                                             |
| 运行目录        | `KITELINE_AGENT_RUN_DIR`，保存本机 IPC 端点和终端运行文件                                               |
| 服务管理器      | systemd、launchd、WinSW 等让 agent 在后台常驻的工具，由部署者自行配置                                   |
| 反向代理        | 部署者自己的 HTTPS 代理（nginx、Caddy 等），把请求转发到 server 的 HTTP 端口                            |
| 控制连接        | agent 到 server 的常驻 WebSocket，承载 RPC 和事件                                                       |
| 数据通道        | 为一次文件传输、终端显示或开发服务请求单独建立的 WebSocket                                              |
| 结果未确认      | 写操作已发出，但无法确定是否生效；界面提示先刷新核查，再决定是否重试                                    |
