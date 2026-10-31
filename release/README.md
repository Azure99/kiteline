# 构建输入

本文面向维护者，说明本目录中每个固定构建输入（版本、下载地址、SHA-256、基础镜像 digest 和 Dockerfile）的含义和修改方法。构建脚本只读取这些文件，不自动获取新版本；构建和发布步骤见[构建与发布](../docs/development/release.md)。

## 文件

| 文件                                                     | 用途                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`inputs.json`](inputs.json)                             | 按依赖固定 Node 官方五目标及 headers、rg 五目标、共用源码和 Ubuntu 输入。 |
| [`node-static.json`](node-static.json)                   | 固定 Linux agent 和独立 CLI 的静态 Node 组件。                            |
| [`agent-linux.json`](agent-linux.json)                   | 固定 Linux 原生依赖的源码、补丁、许可来源和 Alpine 镜像。                 |
| [`agent-linux-packages.txt`](agent-linux-packages.txt)   | 列出 Linux 原生组件构建时安装的直接依赖。                                 |
| [`agent-macos.json`](agent-macos.json)                   | 固定 macOS 原生组件与最低系统版本。                                       |
| [`agent-windows.json`](agent-windows.json)               | 固定 Windows agent 的 MSYS2、源码、运行文件和许可。                       |
| [`Dockerfile.agent-linux`](Dockerfile.agent-linux)       | 构建 Linux 静态原生组件。                                                 |
| [`Dockerfile.server`](Dockerfile.server)                 | 从 server 发布包构建镜像。                                                |
| [`Dockerfile.windows-native`](Dockerfile.windows-native) | 提供 Windows addon 的交叉编译环境。                                       |
| [`ubuntu.sources`](ubuntu.sources)                       | 固定 Ubuntu apt 快照。                                                    |

`agent-linux-packages.txt` 由 `xargs apk add` 直接读取，每行一个包名，不能写注释。文件的 SHA-256 记录在 Linux 原生组件的构建记录中。包版本不固定，跟随所选 Alpine 版本的软件源；每个 Linux agent 包的 `dist/native/build-packages.txt` 记录构建时安装的包和版本。

独立 CLI 直接使用上述 Node 输入，不需要先构建 agent 的原生组件。

## 更新方法

修改下载地址时，同时填写新文件的 SHA-256；脚本下载后核对 SHA-256，不一致时停止构建。Node 官方归档和 headers 集中在 `inputs.json.node`，rg 归档集中在 `inputs.json.ripgrep`；Linux 静态 Node 的外部构建配方仍由 `node-static.json` 单独固定。配套修改见[升级固定依赖](../docs/development/release.md#升级固定依赖)，组件复用与重建规则见[概览](../docs/development/release.md#概览)。
