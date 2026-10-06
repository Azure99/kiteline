# 构建输入

本文面向维护者，说明本目录中每个固定构建输入（版本、下载地址、SHA-256、基础镜像 digest 和 Dockerfile）的含义和修改方法。构建脚本只读取这些文件，不自动获取新版本；构建和发布步骤见[构建与发布](../docs/development/release.md)。

## 文件

| 文件                                                     | 用途                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| [`inputs.json`](inputs.json)                             | 固定共用版本与源码、server 的官方 Linux Node 和 Ubuntu 输入。 |
| [`node-static.json`](node-static.json)                   | 固定 Linux agent 的静态 Node 组件。                           |
| [`agent-linux.json`](agent-linux.json)                   | 固定 Linux 原生依赖的源码、补丁、许可来源和 Alpine 镜像。     |
| [`agent-linux-packages.txt`](agent-linux-packages.txt)   | 列出 Linux 原生组件构建时安装的直接依赖。                     |
| [`agent-macos.json`](agent-macos.json)                   | 固定 macOS 平台归档、flock 和最低系统版本。                   |
| [`agent-windows.json`](agent-windows.json)               | 固定 Windows/MSYS2 运行时、对应源码和许可提取信息。           |
| [`Dockerfile.agent-linux`](Dockerfile.agent-linux)       | 构建 Linux 静态原生组件。                                     |
| [`Dockerfile.server`](Dockerfile.server)                 | 从 server 发布包构建镜像。                                    |
| [`Dockerfile.windows-native`](Dockerfile.windows-native) | 提供 Windows addon 的交叉编译环境。                           |
| [`ubuntu.sources`](ubuntu.sources)                       | 固定 Ubuntu apt 快照。                                        |

`agent-linux-packages.txt` 由 `xargs apk add` 直接读取，每行一个包名，不能写注释。文件的 SHA-256 记录在 Linux 原生组件的构建记录中。包版本不固定，跟随所选 Alpine 版本的软件源；每个 Linux agent 包的 `dist/native/build-packages.txt` 记录构建时安装的包和版本。

## 更新方法

修改下载地址时，同时填写新文件的 SHA-256；脚本下载后核对 SHA-256，不一致时停止构建。一个依赖往往分布在多个文件中，配套修改见[升级固定依赖](../docs/development/release.md#升级固定依赖)，组件复用与重建规则见[概览](../docs/development/release.md#概览)。
