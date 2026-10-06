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

| 文档                                 | 内容                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| [源码开发](development/setup.md)     | 开发环境、本地运行、检查与测试、手工验证               |
| [构建与发布](development/release.md) | CI 完整构建与发布、本机验证、产物结构、依赖升级        |
| [构建输入](../release/README.md)     | `release/` 下每个固定输入文件的含义和更新方式          |
| [部署示例](../deploy/README.md)      | `deploy/` 下 Compose、systemd、launchd、WinSW 示例文件 |

## 架构与行为契约

这些文档说明各部分如何工作，以及修改代码时必须保持的行为。界面操作和用户能看到的结果写在使用与部署文档中；配置、容量和排错所需的限额见[参考](guide/reference.md#限额)。

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
