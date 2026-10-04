# 构建输入

本文面向维护者，说明本目录中每个固定构建输入（版本、下载地址、SHA-256、基础镜像 digest 和 Dockerfile）的含义和修改方法。构建脚本只读取这些文件，不自动获取新版本；构建和发布步骤见[构建与发布](../docs/development/release.md)。

## 文件

| 文件                                                     | 固定的内容                                                                                                                                              | 使用者                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`inputs.json`](inputs.json)                             | 各平台共用的输入：Node 版本、server 使用的官方 Linux Node 归档、tmux 和 libevent 源码、rg 版本与 Linux 归档、Ubuntu 镜像 digest、ca-certificates 软件包 | 全部组包和组件构建脚本、`pnpm native:build`                                                                 |
| [`node-static.json`](node-static.json)                   | Linux agent 的静态 Node 组件：两个架构的下载地址、SHA-256 和 `recipeRevision`                                                                           | `scripts/build-linux-components.mjs`、`scripts/verify-package.mjs`                                          |
| [`agent-linux.json`](agent-linux.json)                   | Linux 原生组件构建所用的 Alpine 镜像 digest、ncurses 源码、libevent 与 ncurses 的 Ubuntu 补丁包、musl 许可文件                                          | `scripts/build-linux-components.mjs`                                                                        |
| [`agent-linux-packages.txt`](agent-linux-packages.txt)   | Linux 原生组件构建容器中 `apk add` 安装的包名                                                                                                           | `Dockerfile.agent-linux`                                                                                    |
| [`agent-macos.json`](agent-macos.json)                   | macOS 最低系统版本、flock 源码、两个架构的 Node 和 rg 归档                                                                                              | `scripts/build-macos-components.mjs`                                                                        |
| [`agent-windows.json`](agent-windows.json)               | Windows 的 Node 归档与头文件、rg、MSYS2 引导归档和软件包、GPL 与 LGPL 组件的源码包、组件文件清单                                                        | `scripts/build-windows-components.mjs`、`scripts/prepare-windows-notices.mjs`、`scripts/verify-package.mjs` |
| [`Dockerfile.agent-linux`](Dockerfile.agent-linux)       | Linux 原生组件的构建步骤：安装工具链、静态编译、汇总 SHA-256                                                                                            | `scripts/build-linux-components.mjs`                                                                        |
| [`Dockerfile.server`](Dockerfile.server)                 | server 镜像的内容：系统软件包、程序位置、运行用户、环境变量和入口                                                                                       | `pnpm images`                                                                                               |
| [`Dockerfile.windows-native`](Dockerfile.windows-native) | 编译 Windows 原生 addon 的 Ubuntu + mingw-w64 环境                                                                                                      | `build-windows-components.mjs addon`                                                                        |
| [`ubuntu.sources`](ubuntu.sources)                       | apt 软件源，指向 `snapshot.ubuntu.com` 的固定快照                                                                                                       | `Dockerfile.server`、`Dockerfile.windows-native`                                                            |

`agent-linux-packages.txt` 由 `xargs apk add` 直接读取，每行一个包名，不能写注释。文件的 SHA-256 记录在 Linux 原生组件的构建记录中。包版本不固定，跟随所选 Alpine 版本的软件源；每个 Linux agent 包的 `dist/native/build-packages.txt` 记录构建时安装的包和版本。

## 修改后的重建

每个发布包都记录构建它的提交，新提交之后所有发布包都要重新构建（见[概览](../docs/development/release.md#概览)）。下表列出修改各文件后还需要额外重建的部分：

| 修改的文件                                                          | 额外重建                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `inputs.json`                                                       | Windows 组件目录；部分字段还影响两个 macOS 组件目录；修改 `tmux` 或 `ripgrep` 后重新运行 `pnpm native:build` |
| `agent-windows.json`、`Dockerfile.windows-native`、`ubuntu.sources` | Windows 组件目录                                                                                             |
| `agent-macos.json`                                                  | 两个 macOS 组件目录                                                                                          |
| 其他文件                                                            | 无。Linux 原生组件在每次组包时于 Docker 中重新构建，变化的步骤不使用缓存                                     |

使组件目录过期的完整输入列表见[构建 Windows 组件](../docs/development/release.md#构建-windows-组件)和[构建 macOS 组件](../docs/development/release.md#构建-macos-组件)中的“何时重建”。

## 更新方法

修改下载地址时，同时填写新文件的 SHA-256；脚本下载后核对 SHA-256，不一致时停止构建。一个依赖往往分布在多个文件中，要一起修改。下表列出各文件对应[升级固定依赖](../docs/development/release.md#升级固定依赖)中的哪些小节：

| 文件                       | 对应小节                                                    |
| -------------------------- | ----------------------------------------------------------- |
| `inputs.json`              | Node、rg、tmux 与 libevent、Ubuntu 镜像与快照               |
| `node-static.json`         | Node                                                        |
| `agent-linux.json`         | Alpine 与 Linux 工具链、tmux 与 libevent、Ubuntu 镜像与快照 |
| `agent-linux-packages.txt` | Alpine 与 Linux 工具链                                      |
| `agent-macos.json`         | Node、rg、tmux 与 libevent、macOS 组件                      |
| `agent-windows.json`       | Node、rg、tmux 与 libevent、MSYS2                           |
| `ubuntu.sources`           | Ubuntu 镜像与快照                                           |

三个 Dockerfile 直接修改，修改后按上一节重建。
