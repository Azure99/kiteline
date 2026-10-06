# 构建与发布

本文面向维护者，说明如何构建、验证和发布 Kiteline 的发布包与镜像。每个构建输入文件的含义见[构建输入](../../release/README.md)。

## 概览

一次发布包含 7 个发布包和一个多架构镜像，全部从同一个提交构建：

| 产物          | 文件或标签                                                                               |
| ------------- | ---------------------------------------------------------------------------------------- |
| Linux agent   | `kiteline-agent-<版本>-linux-amd64.tar.gz`、`kiteline-agent-<版本>-linux-arm64.tar.gz`   |
| macOS agent   | `kiteline-agent-<版本>-macos-amd64.tar.gz`、`kiteline-agent-<版本>-macos-arm64.tar.gz`   |
| Windows agent | `kiteline-agent-<版本>-windows-amd64.zip`                                                |
| server        | `kiteline-server-<版本>-linux-amd64.tar.gz`、`kiteline-server-<版本>-linux-arm64.tar.gz` |
| server 镜像   | 本地 `kiteline-server:<版本>-<架构>`，发布为 `ghcr.io/azure99/kiteline:<版本>`           |

- 版本号来自 [`shared/src/version.json`](../../shared/src/version.json)，包名、包内 `release.json` 和镜像标签都使用它。
- 构建结果写入仓库的 `dist/releases/`，每个压缩包旁有一个同名的 `.sha256` 文件。
- server 包在 `downloads/` 中携带 agent 发布包，网页生成的接入命令和升级命令从这里下载。所以先构建 agent 包，再构建 server 包，最后构建镜像。
- `pnpm package` 和 `pnpm images` 只在 Git 工作树干净（没有改动，也没有未跟踪文件）时运行，并把当前提交写入 `release.json` 的 `sourceCommit`。组装 server 包时，每个 agent 包的提交、版本、平台、架构和 Node 版本都必须与当前源码一致；构建镜像时对 server 包做同样的检查。因此任何新提交（包括只改文档的提交）之后，都要重新构建全部发布包。
- Windows 和 macOS 的原生组件先构建成组件目录（含 `runtime/` 和 `native/`），再由 `pnpm package` 打进发布包。组件目录按构建输入的 SHA-256 检查，输入不变时可以跨提交复用。Windows 将整个 `release/inputs.json` 计入摘要，macOS 只计入实际消费的字段；完整输入以 [Windows 构建脚本](../../scripts/build-windows-components.mjs)和 [macOS 构建脚本](../../scripts/build-macos-components.mjs)为准。输入变化后，重新执行对应的[Windows](#构建-windows-组件)或[macOS](#构建-macos-组件)构建步骤。Linux 的原生组件在每次组包时于 Docker 中重新构建，未变化的步骤直接使用 Docker 层缓存。

## 发布流程

1. 在 PR 中把 `shared/src/version.json` 的 `version` 设为新版本，同时更新 `README.md` 和 `README.en.md` 快速开始中的示例版本，合并到 main。
2. 在 main 的该提交上建立并推送 tag。tag 必须是 `vX.Y.Z` 形式，与该提交的 `version.json` 一致，且提交属于 main 的历史。以下命令在同一个 Shell 中执行：

   ```sh
   KITELINE_VERSION=X.Y.Z # 替换为已合并到 origin/main 的目标版本
   git fetch origin
   git tag "v$KITELINE_VERSION" origin/main
   git push origin "v$KITELINE_VERSION"
   ```

3. 等待 tag 触发的 `CI` 运行完成。成功后 Release 草稿包含全部附件和 `delivery.json`，GHCR 上有 `candidate-vX.Y.Z-<运行 ID>` 镜像。
4. 用草稿中的发布包和候选镜像，按[手工验证](setup.md#手工验证)在受影响的目标环境中测试。发现问题时修复并提交，然后按[失败后的处理](#失败后的处理)重新生成候选（tag 需要指向新的提交）。
5. 最终候选验证完成后，在 Release 草稿现有的 Source 和 Build 信息下填写本版本的变更说明，至少列出 `deploy/` 文件、环境变量、配置的变化，以及升级需要的手工步骤。重新生成候选会重置草稿正文；重新验证后再填写说明。
6. 在 Actions 页面对 main 运行 `CI`，`mode` 选 `publish`，`tag` 填本次的 `vX.Y.Z`。运行成功即完成发布。
7. 确认 Release 已公开，并检查镜像：

   ```sh
   docker buildx imagetools inspect "ghcr.io/azure99/kiteline:$KITELINE_VERSION"
   ```

## 构建机准备

| 构建机      | 构建内容                                                                                |
| ----------- | --------------------------------------------------------------------------------------- |
| Linux x64   | Linux agent、server 包和镜像（arm64 需要 QEMU）；Windows 组件中的 addon、组装和最终 ZIP |
| Linux arm64 | arm64 的 Linux agent、server 包和镜像                                                   |
| Windows x64 | Windows 组件中的 tmux                                                                   |
| Mac         | macOS 组件和 macOS agent 包；Intel Mac 构建 amd64，Apple Silicon 构建 arm64             |

每台运行 `pnpm package` 的构建机按[环境要求](setup.md#环境要求)准备 Node 和 pnpm，并在仓库根目录执行过 `pnpm install --frozen-lockfile`。

### Linux

在 Ubuntu 24.04 上安装构建工具（需要 root 权限）：

```sh
sudo apt-get update
sudo apt-get install -y git curl xz-utils zstd zip unzip binutils libarchive-tools
```

这些软件包提供 `readelf`、`objdump`（检查 Linux agent 的程序都是静态链接、Windows 组件只依赖系统 DLL）、`bsdtar`（组装 server 包时读取 agent 压缩包），以及下载、解开和打包用的 `curl`、`tar`、`zip`、`unzip`、`zstd`。另外安装 Docker Engine：Linux 原生组件、server 镜像和 Windows addon 都在 Docker 中构建，需要 BuildKit（`Dockerfile.server` 使用 `ADD --checksum` 和 `RUN --mount`）。

在 x64 构建机上构建 arm64 的包和镜像时，Docker 需要 QEMU 用户态模拟。注册 binfmt（在 arm64 构建机上构建 amd64 时，把参数换成 `amd64`）：

```sh
docker run --privileged --rm tonistiigi/binfmt --install arm64
```

构建时设置的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 会传给 Docker 构建，curl 下载也使用它们。

### Windows

只有 Windows 组件中的 tmux 步骤需要 Windows x64 主机：

- x64 版 Node，版本使用 [`package.json`](../../package.json) 的 `engines.node`。
- 7-Zip，安装在默认位置 `%ProgramFiles%\7-Zip\7z.exe`，用于解开 MSYS2 引导归档的 XZ 压缩层。
- 系统自带的 `%SystemRoot%\System32\tar.exe`，用于解开归档。

在 Windows 上 checkout 仓库（在 Windows 上准备输入，或运行 `verify-package`）前，执行 `git config --global core.autocrlf false`。换行转换会改变配方文件的 SHA-256，使后续检查失败。测试最终 ZIP 需要 PowerShell 7。

### macOS

- Command Line Tools for Xcode：`xcode-select --install`。构建脚本检查 `com.apple.pkg.CLTools_Executables` 安装记录，只安装 Xcode 时构建失败。
- 与目标架构一致的 Node（Apple Silicon 上使用 arm64 版），版本使用 [`package.json`](../../package.json) 的 `engines.node`；另需 pnpm 和 Git。

### 缓存与清理

- `/var/tmp/kiteline-release-cache/` 缓存 server 的 Node 归档、Linux 静态 Node 与源码（`static-sources/`）和 rg（`ripgrep/`）。复用前按 SHA-256 检查，可以随时删除。
- Windows 和 macOS 的下载保存在你指定的输入目录中，已有文件的 SHA-256 正确时直接复用。
- 脚本自己创建的临时目录在退出时删除；本文命令使用的输入、输出和检查目录（`/var/tmp/kiteline-win-*`、`/var/tmp/kiteline-mac-*`、`/var/tmp/kiteline-check-*`）需要手动删除。
- Docker 保留层缓存和 Windows addon 构建镜像 `kiteline-windows-native-builder`。
- `dist/releases/` 不会自动清理。`pnpm images` 把其中全部 `*.tar.gz` 和 `*.sha256` 作为 Docker 构建上下文，旧版本的包会增加上下文大小，需要手动删除。

## 构建 Linux 包与镜像

只构建 Linux amd64 的 agent、server 和镜像，在 Linux x64 构建机的仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm package agent linux-amd64
pnpm package server amd64 --agent-target=linux-amd64
pnpm images amd64
```

### pnpm package

```text
pnpm package agent linux-amd64|linux-arm64
pnpm package agent windows-amd64 --windows-components=PATH
pnpm package agent macos-amd64|macos-arm64 --macos-components=PATH
pnpm package server amd64|arm64 [--agent-target=TARGET,...]
```

`pnpm package` 删除 `shared`、`server`、`agent`、`terminal-recorder` 的 `dist/` 并重新运行完整的 `pnpm build`，所以组包前先停止 `pnpm dev`。写入 `dist/releases/` 前，脚本再次核对 `HEAD`，组包期间源码有变化时报错并要求重新运行。

`--agent-target` 只用于 server，取值为逗号分隔的 `linux-amd64`、`linux-arm64`、`windows-amd64`、`macos-amd64`、`macos-arm64`，省略时携带全部五个。下载未携带平台的 agent 时，server 返回错误 `This server does not include the matching installation resources; check the release package`。只携带部分 agent 的 server 包不能通过 `verify-package server`，该检查要求五个 agent 包齐全。

### pnpm images

`pnpm images amd64|arm64` 确认 `dist/releases/kiteline-server-<版本>-linux-<架构>.tar.gz` 来自当前提交，然后用 [`release/Dockerfile.server`](../../release/Dockerfile.server) 构建镜像，只打本地标签 `kiteline-server:<版本>-<架构>`。

把镜像复制到另一台机器：

```sh
KITELINE_VERSION=$(node -p "require('./shared/src/version.json').version")
docker save --output "kiteline-server-$KITELINE_VERSION-amd64.tar" "kiteline-server:$KITELINE_VERSION-amd64"
# 在目标机器上，将 X.Y.Z 换成归档版本：
docker load --input kiteline-server-X.Y.Z-amd64.tar
```

用 Compose 运行本地镜像时，使用 `deploy/compose.yaml`，设置 `KITELINE_IMAGE=kiteline-server` 和 `KITELINE_VERSION=<版本>-<架构>`，见[使用 Docker 部署](../guide/server.md#使用-docker-部署)。

### 单独构建 Linux 组件

```sh
node scripts/build-linux-components.mjs arm64
```

参数省略时构建 amd64。结果写入 `dist/agent-linux-<架构>/`，设置 `KITELINE_LINUX_OUTPUT` 可以指定其他目录。该命令只用于检查组件内容，`pnpm package` 每次都在临时目录中重新构建，不读取这个输出。

## 构建 Windows 组件

Windows 组件目录包含 Node、Windows 原生 addon `kiteline-windows.node`、rg 和 MSYS2 提供的程序（见[产物结构](#产物结构)），文件清单定义在 [`scripts/windows-components.ts`](../../scripts/windows-components.ts) 和 [`release/agent-windows.json`](../../release/agent-windows.json) 的 `runtimeFiles` 中。构建分三段，在 Linux x64 和 Windows x64 之间传递目录：

| 步骤                                | 主机        | 作用                                                                     |
| ----------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `prepare INPUTS`                    | 任意        | 下载并校验全部固定输入，复制配方文件，写入 `INPUTS/inputs.json`          |
| `addon INPUTS OUTPUT`               | Linux x64   | 在无网络的 Ubuntu + mingw-w64 容器中编译 `kiteline-windows.node`         |
| `tmux INPUTS OUTPUT`                | Windows x64 | 用输入目录中的 MSYS2 归档建立私有 MSYS2 环境并编译 tmux                  |
| `assemble INPUTS TMUX ADDON OUTPUT` | Linux       | 组装组件目录，检查 DLL 依赖，写入许可、源码归档和 `native/identity.json` |
| `verify OUTPUT`                     | 任意        | 检查组件目录与当前源码的构建输入一致                                     |

`tmux`、`addon` 和 `assemble` 的 `OUTPUT` 目录必须不存在，其父目录必须存在。

1. 在 Linux x64 构建机的仓库根目录准备输入并编译 addon，再把输入目录打包：

   ```sh
   node scripts/build-windows-components.mjs prepare /var/tmp/kiteline-win-inputs
   node scripts/build-windows-components.mjs addon /var/tmp/kiteline-win-inputs /var/tmp/kiteline-win-addon
   tar -cf /var/tmp/kiteline-win-inputs.tar -C /var/tmp kiteline-win-inputs
   ```

2. 把 `kiteline-win-inputs.tar` 复制到 Windows x64 主机的 `C:\kiteline-build\`，在 PowerShell 中编译 tmux。tmux 步骤运行输入目录中的脚本副本，Windows 主机不需要 checkout 仓库：

   ```powershell
   tar.exe -xf C:\kiteline-build\kiteline-win-inputs.tar -C C:\kiteline-build
   node.exe C:\kiteline-build\kiteline-win-inputs\scripts\build-windows-components.mjs tmux C:\kiteline-build\kiteline-win-inputs C:\kiteline-build\kiteline-win-tmux
   tar.exe -cf C:\kiteline-build\kiteline-win-tmux.tar -C C:\kiteline-build kiteline-win-tmux
   ```

3. 把 `kiteline-win-tmux.tar` 复制回 Linux 构建机的 `/var/tmp/`，组装、检查并打包：

   ```sh
   tar -xf /var/tmp/kiteline-win-tmux.tar -C /var/tmp
   node scripts/build-windows-components.mjs assemble /var/tmp/kiteline-win-inputs /var/tmp/kiteline-win-tmux /var/tmp/kiteline-win-addon /var/tmp/kiteline-win-components
   node scripts/build-windows-components.mjs verify /var/tmp/kiteline-win-components
   pnpm package agent windows-amd64 --windows-components=/var/tmp/kiteline-win-components
   ```

`verify` 可以单独检查已有的组件目录，`pnpm package` 也会执行同样的检查。`assemble` 按 `tmux` 和 `addon` 输出目录中的 `build.json` 拒绝过期或被改动的输出。

最终 ZIP 不含符号链接（依赖以平铺的 `node_modules` 安装），解压和安装不需要开启 Windows 开发者模式。

## 构建 macOS 组件

macOS 组件目录包含官方 Node 和原生组件（见[产物结构](#产物结构)），tmux 静态链接 libevent，最低系统版本为 `release/agent-macos.json` 的 `deploymentTarget`（14.0）。构建检查每个 Mach-O 文件的架构和最低系统版本，并要求它只依赖 `/usr/lib` 或 `/System/Library` 下的系统库。

在与目标架构一致的 Mac 上，于同一提交的干净 checkout 中执行（CI 也在一台 Mac 上完成全部步骤）：

```sh
ARCH=arm64 # Apple Silicon；Intel Mac 使用 amd64
pnpm install --frozen-lockfile
node scripts/build-macos-components.mjs prepare "$ARCH" "/var/tmp/kiteline-mac-inputs-$ARCH"
node "/var/tmp/kiteline-mac-inputs-$ARCH/scripts/build-macos-components.mjs" build "$ARCH" \
  "/var/tmp/kiteline-mac-inputs-$ARCH" "/var/tmp/kiteline-mac-components-$ARCH"
pnpm package agent "macos-$ARCH" --macos-components="/var/tmp/kiteline-mac-components-$ARCH"
```

- `prepare` 可以在任意主机上运行，再把整个输入目录复制到 Mac。
- `build` 要求 Darwin 主机且 Node 的架构与目标一致，输出目录必须不存在。下载或配方文件与输入记录不符时，它要求重新 `prepare`。
- `node scripts/build-macos-components.mjs verify "$ARCH" DIRECTORY` 单独检查组件目录，`pnpm package` 也会执行同样的检查。

把 `dist/releases/kiteline-agent-<版本>-macos-<架构>.tar.gz` 和对应的 `.sha256` 复制到 Linux 构建机的 `dist/releases/`，用于组装 server。

## 完整发布构建

完整发布从同一个干净提交构建五个 agent 包，再组装两个 server 包和两个镜像：

1. 按[构建 Windows 组件](#构建-windows-组件)准备 `/var/tmp/kiteline-win-components`。
2. 在两台 Mac 上按[构建 macOS 组件](#构建-macos-组件)构建两个 macOS 包，复制到 Linux 构建机的 `dist/releases/`。
3. 在 Linux 构建机的仓库根目录执行：

   ```sh
   pnpm install --frozen-lockfile
   pnpm package agent linux-amd64
   pnpm package agent linux-arm64
   pnpm package agent windows-amd64 --windows-components=/var/tmp/kiteline-win-components
   pnpm package server amd64
   pnpm package server arm64
   pnpm images amd64
   pnpm images arm64
   ```

4. 按[验证发布包](#验证发布包)检查结果。

arm64 的命令可以在注册了 QEMU 的 x64 构建机上运行，但模拟执行明显慢于原生构建；也可以在 arm64 构建机上执行，再把包和 `.sha256` 复制到同一个 `dist/releases/`。

### 常见构建错误

下表只列原因不明显的报错，其他报错信息本身写明了处理方法。

| 报错                                                                    | 原因与处理                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Release builds require a clean Git worktree and index`                 | 工作树有改动或未跟踪文件。提交或清理后重试                                               |
| `Build agent <目标> first`                                              | `dist/releases/` 缺少该 agent 包或 `.sha256`。先构建它，或用 `--agent-target` 去掉该目标 |
| `Windows component inputs do not match this source; prepare them again` | 输入目录按其他源码准备，或 Windows checkout 转换了换行。重新 `prepare`                   |
| `Windows component build is stale or damaged: …`                        | `tmux` 或 `addon` 的输出与输入目录不符或被改动。重新执行该步骤                           |

## 验证发布包

`scripts/verify-package.mjs` 检查一个已解开的发布包，`scripts/verify-server.mjs` 运行 server 包或镜像。

完整发布构建之后，在 Linux amd64 构建机的仓库根目录验证本机构建的包：

```sh
KITELINE_VERSION=$(node -p "require('./shared/src/version.json').version")
CHECK=$(mktemp -d /var/tmp/kiteline-check-XXXXXX)
tar -xzf "dist/releases/kiteline-agent-$KITELINE_VERSION-linux-amd64.tar.gz" -C "$CHECK"
tar -xzf "dist/releases/kiteline-server-$KITELINE_VERSION-linux-amd64.tar.gz" -C "$CHECK"
node scripts/verify-package.mjs agent linux-amd64 \
  "dist/releases/kiteline-agent-$KITELINE_VERSION-linux-amd64.tar.gz" "$CHECK/kiteline-agent-$KITELINE_VERSION-linux-amd64"
node scripts/verify-package.mjs server linux-amd64 \
  "dist/releases/kiteline-server-$KITELINE_VERSION-linux-amd64.tar.gz" "$CHECK/kiteline-server-$KITELINE_VERSION-linux-amd64"
"$CHECK/kiteline-agent-$KITELINE_VERSION-linux-amd64/bin/kiteline-agent" --version
KITELINE_AGENT_HOME="$CHECK/agent-state" KITELINE_AGENT_RUN_DIR="$CHECK/agent-run" \
  "$CHECK/kiteline-agent-$KITELINE_VERSION-linux-amd64/bin/kiteline-agent" check
node scripts/verify-server.mjs "$CHECK/kiteline-server-$KITELINE_VERSION-linux-amd64" "$CHECK/server-run" \
  --agent="$CHECK/kiteline-agent-$KITELINE_VERSION-linux-amd64"
node scripts/verify-server.mjs "$CHECK/kiteline-server-$KITELINE_VERSION-linux-amd64" "$CHECK/image-run" \
  --image="kiteline-server:$KITELINE_VERSION-amd64"
```

### verify-package

```text
node scripts/verify-package.mjs agent|server PLATFORM-ARCH ARCHIVE DIRECTORY
```

- 从仓库根目录运行，工作树必须干净，`HEAD` 和 `pnpm-lock.yaml` 必须与包的 `release.json` 一致。`ARCHIVE` 旁边必须有对应的 `.sha256`。
- 脚本不解压文件。`DIRECTORY` 是已解开的包目录，目录名必须是 `kiteline-<agent|server>-<版本>-<平台>-<架构>`。
- 脚本检查压缩包与 `.sha256`、`release.json`、包内文件与 `SHA256SUMS`、可执行权限、链接、`LICENSE`、Node 架构和原生组件记录；server 包还要求 `downloads/` 中的五个 agent 包与 `dist/releases/` 中的相同。成功时输出一行 JSON，脚本不运行包中的程序。

### verify-server

```text
node scripts/verify-server.mjs PACKAGE WORK [--image=TAG | --agent=PACKAGE]
```

- `PACKAGE` 是已解开的 server 包目录，使用 `--image` 时也需要它。`WORK` 必须是不存在的新目录，其父目录必须存在；日志写入 `WORK/*.log`。
- 不带选项时，在本机启动包中的 server，检查 `/healthz` 返回的版本和收到 SIGTERM 后的正常退出。
- `--agent=PACKAGE` 另外完成初始化，用已解开的 agent 包绑定并运行 agent，创建一个终端会话并检查输出。它需要能在本机运行的 Linux 或 macOS agent 包，本机也要满足 agent 的运行条件。
- `--image=TAG` 改用镜像启动容器，同样检查 `/healthz` 和正常退出，并核对镜像的架构以及容器内的 `release.json`、`SHA256SUMS` 与 `PACKAGE` 一致。
- `--image` 和 `--agent` 不能同时使用。不带选项和 `--agent` 模式直接运行包中的程序，需要与包架构相同的主机。

### 其他平台的 agent 包

macOS 包在构建它的 Mac 上验证，命令与 Linux agent 相同（`tar -xzf`、`verify-package agent macos-<架构>`、`kiteline-agent --version` 和 `check`）。

Windows ZIP 在 Windows 上验证。在已关闭换行转换的同一提交 checkout 中，把 ZIP 及其 `.sha256` 放入 `dist\releases\`，用 PowerShell 7 在仓库根目录执行：

```powershell
$Version = (Get-Content shared/src/version.json -Raw | ConvertFrom-Json).version
$Name = "kiteline-agent-$Version-windows-amd64"
Expand-Archive -LiteralPath "dist/releases/$Name.zip" -DestinationPath C:\kiteline-check
node scripts/verify-package.mjs agent windows-amd64 "dist/releases/$Name.zip" "C:\kiteline-check\$Name"
$env:KITELINE_AGENT_HOME = 'C:\kiteline-check\agent-state'
$env:KITELINE_AGENT_RUN_DIR = 'C:\kiteline-check\agent-run'
& "$PSHOME\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\kiteline-check\$Name\bin\kiteline-agent.ps1" --version
& "$PSHOME\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\kiteline-check\$Name\bin\kiteline-agent.ps1" check
```

这些检查不覆盖安装、升级和真实使用，发布前还需要按[手工验证](setup.md#手工验证)在目标环境中测试。

## GitHub Actions

工作流入口是 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)（名称 `CI`），构建任务在 `build.yml`、`build-agent.yml`、`build-server.yml` 中，Release 和镜像操作由 `scripts/ci-release.mjs` 完成（只在 CI 中使用）。

### 触发与模式

| 触发                              | 模式        | 执行内容                                                                          |
| --------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| PR、推送到 main、手动 `checks`    | `checks`    | 格式、lint、类型检查、Web 构建和部分单元测试，见[检查与测试](setup.md#检查与测试) |
| 手动 `full`（任意分支）           | `full`      | 检查之后构建并验证五个 agent 包、两个 server 包和两个镜像                         |
| main 上手动 `dev-image`           | `dev-image` | 完整构建，然后推送开发镜像                                                        |
| 推送 `v*` tag                     | `candidate` | 完整构建，然后建立 Release 草稿并推送候选镜像                                     |
| main 上手动 `publish`，填写 `tag` | `publish`   | 发布已有的候选，不重新构建                                                        |

手动运行在仓库的 Actions 页面选择 `CI`，点击 “Run workflow”，选择分支、`mode` 和 `tag`（只有 `publish` 使用）。`candidate` 不能手动选择，只由推送 tag 触发。同一 PR 或推送到 main 的新运行会取消同类的较早运行；手动运行和 tag 触发的运行不会被取消。同一 tag 的 `distribute` 与 `publish` 任务排队执行。

构建任务及依赖关系见 [`build.yml`](../../.github/workflows/build.yml)。server 任务失败时上传日志 artifact `server-diagnostics-<架构>`，重跑注意下文的 artifact 保留期限。

### Release 与镜像

镜像仓库由仓库名得出：`ghcr.io/<所有者>/<仓库>`（小写），本仓库为 `ghcr.io/azure99/kiteline`。

| 标签                                                                     | 产生方式                                  |
| ------------------------------------------------------------------------ | ----------------------------------------- |
| `candidate-vX.Y.Z-<运行 ID>`，以及带 `-amd64`、`-arm64` 后缀的单架构标签 | 推送 tag 后的候选构建                     |
| `dev-<提交>`，以及带 `-amd64`、`-arm64` 后缀的单架构标签                 | `dev-image`                               |
| `dev`                                                                    | `dev-image`，只在 main 仍指向该提交时更新 |
| `X.Y.Z`（不带 `v`）                                                      | `publish`，指向候选镜像的同一个 digest    |

不产生 `latest` 标签。

候选构建在 GitHub 上建立或更新 tag 对应的 Release 草稿，上传 7 个发布包、各自的 `.sha256`、汇总的 `SHA256SUMS`，最后上传 `delivery.json`。`delivery.json` 是候选完成的标记，记录源码提交、运行 ID、`SHA256SUMS` 的 SHA-256 和候选镜像的 digest。

`publish` 使用 main 当前提交中的脚本，确认 `delivery.json` 的提交等于 tag 指向的提交、每个附件与 `.sha256` 和 `SHA256SUMS` 一致，然后把候选镜像的 digest 复制为 `X.Y.Z` 标签，并把草稿发布为正式 Release。

### 权限与仓库设置

- 工作流使用 `GITHUB_TOKEN`。`distribute` 和 `publish` 任务申请 `contents: write` 和 `packages: write`，仓库或组织的 Actions 设置需要允许这些权限。
- GHCR 上已有同名 package 时，在 package 设置中授予本仓库的 Actions 访问权限。
- 公开分发镜像时，把 package 设为 public，并用未登录的 Docker 确认可以拉取。仓库和 package 的可见性分别设置。

### 失败后的处理

| 情况                                                     | 处理                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 运行因网络、runner 或权限设置失败                        | 在该运行页面选择 “Re-run all jobs”。artifact 只保留 1 天，只重跑失败任务可能找不到其他任务的 artifact            |
| 候选运行失败，草稿缺少 `delivery.json`                   | `publish` 会拒绝该候选。重跑该 tag 的运行；无法重跑时，删除并重新推送 tag，产生新的运行 ID 和候选标签            |
| 需要修改代码才能修复，或测试候选时发现问题               | 修复合并到 main 后，删除远端 tag，在新提交上重新创建并推送（见下方命令）。草稿未发布时，新的候选替换草稿中的附件 |
| `publish` 在复制镜像或发布草稿时失败                     | 重新运行 `publish`。`X.Y.Z` 已指向同一 digest 时会继续完成                                                       |
| `Release vX.Y.Z is already published; cannot rebuild it` | 已发布的版本不能重建。修改版本号，发布一个新版本                                                                 |
| `Version image … already differs`                        | `X.Y.Z` 镜像标签已指向其他 digest，`publish` 停止。不要覆盖已发布的标签，发布一个新版本                          |
| `dev-image` 报 `main advanced`                           | `dev-<提交>` 已推送，`dev` 未更新。在新的 main 上再运行一次 `dev-image`                                          |

在新提交上重新创建 tag（版本号不变）：

```sh
KITELINE_VERSION=X.Y.Z # 替换为尚未正式发布的目标版本
git fetch origin
git push --delete origin "v$KITELINE_VERSION"
git tag -f "v$KITELINE_VERSION" origin/main
git push origin "v$KITELINE_VERSION"
```

## 产物结构

### 发布包

| 路径                                      | 内容                                                                                                            | 所在包 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| `LICENSE`                                 | 项目的 Apache-2.0 许可                                                                                          | 全部   |
| `release.json`                            | 包清单，见下文                                                                                                  | 全部   |
| `SHA256SUMS`                              | 包内除自身外每个文件的 SHA-256                                                                                  | 全部   |
| `bin/`                                    | 启动脚本：`kiteline-agent` 与安装后使用的 `kiteline-agent-installed`（Windows 为 `.ps1`），或 `kiteline-server` | 全部   |
| `runtime/`                                | Node 运行时及其 `LICENSE`                                                                                       | 全部   |
| `shared/`、`agent/`、`terminal-recorder/` | 编译后的 JS 和生产依赖                                                                                          | agent  |
| `shared/`、`server/`                      | 编译后的 JS 和生产依赖                                                                                          | server |
| `deploy/`                                 | 服务管理器示例：`kiteline-agent.service`、`kiteline-agent.plist` 或 `kiteline-agent.xml`                        | agent  |
| `dist/native/`                            | 原生组件，见下表                                                                                                | agent  |
| `web/dist/`                               | 工作台静态文件                                                                                                  | server |
| `installer/`                              | 接入和升级命令的模板                                                                                            | server |
| `downloads/`                              | 五个 agent 发布包及 `.sha256`、`install.sh`、`install.ps1`                                                      | server |

每个包的根目录是 `kiteline-<agent|server>-<版本>-<平台>-<架构>/`。Linux 和 macOS 包中，目录权限和可执行文件为 `0755`，其他文件为 `0644`。

| 平台    | `runtime/`                                                           | `dist/native/`                                                                                                                                                               |
| ------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | `node-static-builds` 的静态 Node 组件，含 `bin/node` 和 `build.json` | `bin/tmux`、`bin/rename-noreplace`、`bin/rg`（全部静态链接）；`share/terminfo/`、`share/terminfo-legacy/`；`build-packages.txt`（构建所用的 Alpine 包及版本）；`inputs.json` |
| macOS   | 官方 Node 的 `bin/node`                                              | `bin/tmux`、`bin/rg`、`bin/flock`、`bin/rename-noreplace`、`bin/entry-name`；`share/terminfo/`                                                                               |
| Windows | 官方 Node 的 `bin/node.exe`                                          | `kiteline-windows.node`、`bin/rg.exe`；`msys/`（tmux、bash、sh、script、stty、console helper、5 个 DLL 和 terminfo）                                                         |
| server  | 官方 Node 的 `bin/node`（glibc 动态链接）                            | —                                                                                                                                                                            |

各平台的 `dist/native/` 还包含 `licenses/` 和 `identity.json`，Windows 另有 `sources/`。

### 清单文件

- `release.json`：包的版本、种类、平台、架构、Node 版本、源码提交和 `pnpm-lock.yaml` 的 SHA-256，以及构建来源记录。安装、升级和发布检查都读取它。
- `dist/native/identity.json`：原生组件的版本、来源和文件摘要，以及组包时写入的 xterm.js 相关依赖版本和终端 profile。
- 包内 `SHA256SUMS`：agent 安装和升级时按它逐个核对文件。
- `<包名>.sha256`：一行 `<sha256>  <文件名>`。server 组包、镜像构建和安装脚本用它核对压缩包。

### 第三方许可

- 每个发布包根目录的 `LICENSE` 是项目许可。
- `runtime/LICENSE` 是 Node 的许可。
- `node_modules` 中的每个生产依赖保留自己的许可文件。
- server 包的 `web/dist/licenses/` 包含 `dependencies.md`（打包进工作台的依赖及其许可）、`project.txt`、`tailwindcss.txt`、`vite.txt` 和 `xterm-css.txt`。
- agent 包的 `dist/native/licenses/` 包含原生组件的许可：Linux 为 libevent、ncurses、tmux、musl 和 rg；macOS 为 libevent、tmux、flock 和 rg；Windows 为 tmux、rg、mingw-w64、bash、readline、coreutils、util-linux、gettext、libiconv、libevent、ncurses 和 msys2-runtime。
- 只有 Windows 包含 GPL 和 LGPL 组件的对应源码：`dist/native/sources/` 中有 bash、coreutils、util-linux、gettext、libiconv、readline 和 msys2-runtime 的 MSYS2 源码包（`*.src.tar.zst`，含构建配方和补丁）。

### 镜像

- 基于 `release/inputs.json` 固定 digest 的 Ubuntu 24.04，从固定的 Ubuntu 快照安装 `ca-certificates`、`libstdc++6`、`libatomic1`。
- server 包解开在 `/opt/kiteline-server`，`kiteline-server` 链接到 `/usr/local/bin/`。
- 以用户 `kiteline`（UID 和 GID 1000）运行；`KITELINE_DATA_DIR=/var/lib/kiteline`，`KITELINE_LISTEN_ADDR=0.0.0.0:8080`，`LANG=C.UTF-8`；暴露 8080 端口。
- `ENTRYPOINT ["kiteline-server"]`，`CMD ["serve"]`。

## 升级固定依赖

依赖版本和下载地址都固定在仓库中，构建时不会自动取新版本。升级某个依赖时，一起修改下列位置，然后完整构建并按[手工验证](setup.md#手工验证)测试受影响的平台。下载文件的 SHA-256 从上游发布的校验文件取得，或下载后用 `sha256sum` 计算。

### Node

- `package.json` 的 `engines.node`，以及 `@types/node` 的主版本。
- `release/inputs.json` 的 `node`，以及 `nodeArchives` 中 server 使用的官方 Linux `.tar.xz` 的 SHA-256。
- Linux agent 还需先在 [Azure99/node-static-builds](https://github.com/Azure99/node-static-builds) 发布新静态组件，再更新 `release/node-static.json` 的摘要和 `recipeRevision`。
- `release/agent-windows.json` 的 `nodeArchiveSha256`（`win-x64.zip`）和 `nodeHeadersSha256`（`headers.tar.gz`）。
- `release/agent-macos.json` 中两个架构的 `nodeArchiveSha256`（`darwin-*.tar.xz`）。

`pnpm package` 在创建临时目录和开始构建前检查 `package.json` 的 `engines.node` 与 `release/inputs.json` 的 `node` 是同一精确版本，不一致时直接失败。Node 22 的官方维护期到 2027-04-30 结束，在此之前把运行时升级到新的 LTS 版本，并按本节修改全部位置。升级 Node 后同时重新测试代理行为（见 [Undici 与代理](#undici-与代理)）。

### pnpm

修改 `package.json` 的 `packageManager`，运行 `pnpm install` 更新 `pnpm-lock.yaml`。CI 通过 Corepack 使用同一版本。`pnpm package` 用 `pnpm deploy` 复制生产依赖，它的输出布局决定包内 `node_modules` 和 `@kiteline/shared` 的位置，所以升级后完整构建，并用 `verify-package` 检查 Linux、macOS 和 Windows 的 agent 包。

### rg

更新 `release/inputs.json` 的 `ripgrep.version`，配套更新同文件的 Linux 归档、`release/agent-macos.json` 两架构和 `release/agent-windows.json` 的归档摘要，然后重新运行 `pnpm native:build`。

### tmux 与 libevent

- `release/inputs.json` 的 `tmux` 供全部平台和 `pnpm native:build` 使用，`libevent` 只供 Linux 和 macOS 组件构建使用（开发构建链接系统的 libevent）；`release/agent-macos.json` 的 `libeventVersion` 是写入 `identity.json` 的版本标签。
- Linux 构建使用的 libevent 和 ncurses 的 Ubuntu 补丁包在 `release/agent-linux.json` 中。
- Windows 的 tmux 用 `inputs.json` 的源码在 MSYS2 中编译，libevent 和 ncurses 来自 MSYS2 包；运行库的 DLL 名称在 `agent-windows.json` 的 `runtimeFiles` 中维护，组件提取和所需文件清单共用它。
- `native/tmux/paste.patch` 和 `native/tmux/cygwin-outfd.patch` 必须能应用到新版本。终端机制见[终端](../design/terminal.md)，升级后重新测试终端的输入、粘贴、恢复和本机接续。

修改 `release/inputs.json` 中的 `tmux` 后，重新运行 `pnpm native:build`。

### Ubuntu 镜像与快照

- `release/inputs.json` 的 `ubuntu` 是 server 镜像和 Windows addon 构建所用的 Ubuntu 镜像 digest。
- `release/ubuntu.sources` 指向 `snapshot.ubuntu.com` 的一个快照时间点，镜像中的 apt 软件包从这里安装。
- 同一快照日期也出现在 `inputs.json` 的 `caCertificates`、`libevent` 地址和 `agent-linux.json` 的源码地址中。更换快照时一起更新这些地址和 SHA-256。

### Alpine 与 Linux 工具链

`release/agent-linux.json` 的 `alpine` 固定 Linux 原生组件构建所用的 Alpine 镜像 digest，`release/agent-linux-packages.txt` 列出安装的包（格式见[构建输入](../../release/README.md#文件)）。升级前后对比 Linux agent 包中的 `dist/native/build-packages.txt`。

### MSYS2

`release/agent-windows.json` 固定 MSYS2 引导归档（`bootstrap`）、软件包（`packages`）和 GPL 与 LGPL 组件的源码包（`sources`）。升级源码包时，在对应 `sources` 条目中一起更新归档地址、SHA-256 和 `notice` 中的上游归档名、目录及许可路径；[`scripts/prepare-windows-notices.mjs`](../../scripts/prepare-windows-notices.mjs) 从这些条目提取许可和复制源码包。libevent、ncurses 和 msys2-runtime 的许可仍从对应安装包提取。

### macOS 组件

`release/agent-macos.json` 固定 flock 的源码和最低系统版本 `deploymentTarget`。修改最低系统版本时，同时更新两个 README、[接入设备](../guide/devices.md#支持的系统与准备)及其[英文版](../guide/devices.en.md#supported-systems-and-prerequisites)、[平台实现](../design/platforms.md#macos)，以及本文[构建 macOS 组件](#构建-macos-组件)中的系统版本。

### xterm.js

工作台的 Vite 配置直接编译 `@xterm/xterm` 的 TypeScript 入口，补丁 `web/patches/@xterm__xterm@6.1.0-beta.304.patch` 只维护源码修改，在 `pnpm-workspace.yaml` 的 `patchedDependencies` 中登记。recorder 使用 `@xterm/headless` 和 `@xterm/addon-serialize`，`shared` 使用 `@xterm/addon-unicode11`，这些版本在组包时写入 agent 的 `identity.json`。

当前 `@xterm/xterm@6.1.0-beta.304` 与 `@xterm/headless@6.1.0-beta.303` 来自同一上游源码提交。升级时联合核对两端及 addon 的配套，并检查 [`shared/src/terminal/index.ts`](../../shared/src/terminal/index.ts) 使用的 `_core`、buffer、输入处理器、解析器和鼠标状态成员，以及 [`web/src/terminal/auxiliary-input.ts`](../../web/src/terminal/auxiliary-input.ts) 引用的私有键盘编码；具体适配见[终端组件](../design/terminal.md#组件)。

补丁中的 `DomRenderer.ts` 和 `WidthCache.ts` 按设备像素比测量字形宽度，修正 Windows 页面缩放后中文字形和选区边界错位。`Event.ts` 的非空断言只用于类型检查：辅助输入导入 xterm 私有源码后，项目的 `noUncheckedIndexedAccess` 也会检查这些源码；它与 DPR 的运行时修改是两项独立内容。

维护现有补丁时，在仓库根目录运行 `pnpm patch @xterm/xterm@6.1.0-beta.304`。它输出一个已应用现有补丁的编辑目录（加 `--ignore-existing` 从未修补的包开始）。在该目录的 `src/` 中修改 TypeScript，然后运行：

```sh
pnpm patch-commit --patches-dir web/patches EDIT_DIR
```

`pnpm patch-commit` 写入补丁并重新安装依赖。一起提交补丁、`pnpm-workspace.yaml` 和记录补丁哈希的 `pnpm-lock.yaml`。Vite 的生产编译和开发预优化都需要 legacy 参数装饰器转换；修改后分别启动完整应用验证显示、选择、恢复和输入，并在 Windows 页面缩放下核对中文拖选和复制。

升级到新的 xterm.js 版本时：

1. 在各 `package.json` 中把 xterm.js 相关的包改到新版本，删除 `pnpm-workspace.yaml` 中旧版本的 `patchedDependencies` 条目（否则 `pnpm install` 报 `ERR_PNPM_UNUSED_PATCH`），然后运行 `pnpm install`。
2. 用新版本号执行上述步骤。这时 `pnpm patch` 从未修补的包开始，参照旧补丁文件在新版本上重新修改，并完成生产与开发模式验证。
3. 提交新补丁后删除旧补丁文件。

### Undici 与代理

升级 Node、`undici`、`proxy-from-env` 或 `https-proxy-agent` 后，分别在直连、HTTP 代理和需要认证的代理下测试绑定和连接（实现见 [`agent/src/network.ts`](../../agent/src/network.ts)，代理设置见[出站代理与证书](../guide/devices.md#出站代理与证书)）。`undici` 包的 dispatcher 必须与 Node 内置的 `fetch` 兼容。

### Tailwind 与 CodeMirror

升级 Tailwind CSS、`@csstools/postcss-cascade-layers` 或 CodeMirror 后，按[浏览器兼容](../design/architecture.md#浏览器兼容)中的清单在当前 Chrome 和 Chromium 97 中重新检查。

### 工作流中的 action

工作流中的 action 按提交 SHA 固定，并在行尾注释版本（如 `actions/checkout@<sha> # v7.0.1`）。升级时同时修改 SHA 和注释。
