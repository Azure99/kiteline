# Kiteline

[English](README.en.md)

Kiteline 是一个自托管的 coding agent 工作台。Claude Code、Codex 等命令行工具以原生 TUI 运行在你自己的设备上，通过浏览器即可管理多台设备和项目；同一个终端会话可在电脑、手机与远程 CLI 之间接续。

<p align="center">
  <a href="docs/assets/readme-desktop.png"><img src="docs/assets/readme-desktop.png" width="820" alt="桌面端：Lantern Studio 的 Codex、开发预览服务与测试三分屏，侧栏展示工作区通知"></a>
</p>

<table align="center">
  <tr>
    <td nowrap>
      <a href="docs/assets/readme-mobile-terminal.png"><img src="docs/assets/readme-mobile-terminal.png" width="260" alt="手机端接续 Lantern Studio 的同一 Codex 会话，工具栏显示任务标题"></a>
      <a href="docs/assets/readme-mobile-files.png"><img src="docs/assets/readme-mobile-files.png" width="260" alt="手机端文件管理器展示多种文件类型图标，展开工作区通知并折叠无通知设备"></a>
      <a href="docs/assets/readme-mobile-git.png"><img src="docs/assets/readme-mobile-git.png" width="260" alt="手机端查看 Lantern Studio 中 gallery.test.js 的 Git diff"></a>
    </td>
  </tr>
</table>

- **原生 TUI**：agent 运行在真实终端中，保留其原有界面与交互，沿用设备已有的工具链与环境。
- **多设备与工作区**：接入 Linux、Windows 和 macOS 设备，按项目切换工作区；切换电脑或手机时，会话继续运行。
- **远程 CLI**：在本机终端接续同一个会话，也可用短命令发送输入、查看输出和上传下载文件。
- **终端通知**：在工作区列表查看程序主动发出的通知与等待报告，点击来源回到对应终端。
- **终端、文件与 Git**：终端分组和分屏，编辑文件、预览图片与 Markdown/HTML 草稿，查看 Git 改动；agent 会话保持运行。
- **开发预览**：在浏览器中访问设备上的 Web 服务，支持 WebSocket 与热更新。
- **定时任务**：按 cron 计划在设备上运行脚本或 agent，并保留运行记录；agent 也可自行创建任务。

## 开始使用

Kiteline 面向个人使用。准备一台安装了 Docker 的 Linux 主机部署 server；开发设备需安装 Git 2.23+、所需 Shell，以及已登录的 coding CLI。[系统要求](docs/guide/devices.md#支持的系统与准备)

```sh
mkdir kiteline && cd kiteline
curl -fsSLO https://github.com/Azure99/kiteline/releases/latest/download/compose.yaml
docker compose up -d
docker compose logs server
```

1. 打开 `http://127.0.0.1:8080`，用日志中的初始化 token（30 分钟内有效）设置密码。默认只监听本机；连接其他设备或手机前，按[部署指南](docs/guide/server.md)配置可达地址和 HTTPS。
2. 从“绑定设备”获取安装命令，在开发设备上以日常账户执行。浏览器和设备都需能访问生成命令时使用的 server 地址。
3. 添加项目目录为工作区，打开终端启动 coding CLI。其他设备和项目同样接入。

安装命令会在前台运行 agent；长期使用按[设备指南](docs/guide/devices.md#后台运行)配置后台服务。登录者拥有 agent 运行账户的文件和命令权限。

## 文档

[工作台使用](docs/guide/usage.md) · [设备维护](docs/guide/devices.md) · [定时任务](docs/guide/scheduled-tasks.md) · [远程 CLI](docs/guide/cli.md) · [命令与配置](docs/guide/reference.md) · [开发文档](docs/README.md)

## 许可证

[Apache-2.0](LICENSE)。第三方组件的许可与来源见[产物结构](docs/development/release.md#产物结构)。
