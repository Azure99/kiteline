# 构建与发布

完整多平台构建以 [GitHub Actions](#github-actions) 为入口；本机调试见[构建 Linux 包与镜像](#构建-linux-包与镜像)。固定输入的文件入口见[构建输入](../../release/README.md)。

## 概览

一次发布包含 7 个发布包和一个多架构镜像，全部从同一个提交构建：

| 产物          | 文件或标签                                                                               |
| ------------- | ---------------------------------------------------------------------------------------- |
| Linux agent   | `kiteline-agent-<版本>-linux-amd64.tar.gz`、`kiteline-agent-<版本>-linux-arm64.tar.gz`   |
| macOS agent   | `kiteline-agent-<版本>-macos-amd64.tar.gz`、`kiteline-agent-<版本>-macos-arm64.tar.gz`   |
| Windows agent | `kiteline-agent-<版本>-windows-amd64.zip`                                                |
| server        | `kiteline-server-<版本>-linux-amd64.tar.gz`、`kiteline-server-<版本>-linux-arm64.tar.gz` |
| server 镜像   | 本地 `kiteline-server:<版本>-<架构>`，发布为 `ghcr.io/azure99/kiteline:<版本>`           |

- 版本号来自 [`shared/src/version.json`](../../shared/src/version.json)。发布包写入 `dist/releases/`，每个包旁有同名 `.sha256`。
- server 包在 `downloads/` 中携带 agent 包，接入和升级命令从这里下载。因此先构建 agent，再组装 server，最后构建镜像。
- `pnpm package` 和 `pnpm images` 要求工作树和暂存区干净，包括没有未跟踪文件；包与镜像必须匹配当前提交、版本、平台、架构和 Node 版本。新提交后不能复用旧提交的发布包。
- Windows 和 macOS 的组件目录按构建输入摘要检查，输入不变时可跨提交复用。Windows 摘要包含整个 `release/inputs.json`，macOS 只包含实际消费的字段；输入变化后重建相应组件。Linux 原生组件每次组包时在 Docker 中构建，可复用 Docker 层缓存。

## 发布流程

1. 在 PR 中更新 `shared/src/version.json` 的版本和两个 README 快速开始的示例版本，合并到 main。
2. 在该提交建立并推送 tag。tag 必须为 `vX.Y.Z`，与该提交的版本一致，且提交属于 main 历史。在同一个 Shell 中执行：

   ```sh
   KITELINE_VERSION=X.Y.Z # 替换为已合并到 origin/main 的目标版本
   git fetch origin
   git tag "v$KITELINE_VERSION" origin/main
   git push origin "v$KITELINE_VERSION"
   ```

3. 等待 tag 触发的 `CI` 完成。成功后 Release 草稿包含全部附件和 `delivery.json`，GHCR 上有 `candidate-vX.Y.Z-<运行 ID>` 镜像。
4. 用草稿中的包和候选镜像，按[手工验证](setup.md#手工验证)在受影响的目标环境中测试。需要修改时先修复并合并到 main，再按[失败后的处理](#失败后的处理)重新生成候选。
5. 最终候选验证完成后，在草稿现有 Source 和 Build 信息下填写变更说明，列出 `deploy/`、环境变量、配置的变化及升级所需的手工步骤。重新生成候选会重置草稿正文，须重新验证后再填写说明。
6. 在 Actions 页面选择 `CI`，在 main 上运行 `publish`，`tag` 填本次的 `vX.Y.Z`。它发布已有候选，不重新构建。
7. 确认 Release 已公开，并检查镜像：

   ```sh
   docker buildx imagetools inspect "ghcr.io/azure99/kiteline:$KITELINE_VERSION"
   ```

## GitHub Actions

工作流入口为 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)，名称为 `CI`。完整构建、平台产物传递及验证命令见 [`build.yml`](../../.github/workflows/build.yml)；发布操作由 [`scripts/ci-release.mjs`](../../scripts/ci-release.mjs) 执行。

### 触发与模式

| 触发                              | 模式        | 执行内容                                            |
| --------------------------------- | ----------- | --------------------------------------------------- |
| PR、推送到 main、手动 `checks`    | `checks`    | 格式、lint、类型、Web 构建及不需要原生组件的测试。  |
| 手动 `full`，可选择任意分支       | `full`      | 构建并验证五个 agent 包、两个 server 包和两个镜像。 |
| main 上手动 `dev-image`           | `dev-image` | 完整构建后推送开发镜像。                            |
| 推送 `v*` tag                     | `candidate` | 完整构建后建立 Release 草稿并推送候选镜像。         |
| main 上手动 `publish`，填写 `tag` | `publish`   | 发布已有候选。                                      |

手动运行时，在 Actions 的 `CI` 页面点击 “Run workflow”，选择分支和 `mode`；只有 `publish` 使用 `tag`。`candidate` 只由推送 tag 触发。

完整构建会校验归档和解包内容，在对应平台运行 agent 的版本检查及 `check`，检查 server 与镜像的健康响应和正常退出，并在 Linux amd64 上检查绑定和终端输出。它不覆盖安装、升级、卸载、Windows 11 或最低支持系统版本。

### Release 与镜像

镜像仓库为小写的 `ghcr.io/<所有者>/<仓库>`，本仓库是 `ghcr.io/azure99/kiteline`。

| 标签                                                             | 产生方式                               |
| ---------------------------------------------------------------- | -------------------------------------- |
| `candidate-vX.Y.Z-<运行 ID>`，另有 `-amd64`、`-arm64` 单架构标签 | 候选构建。                             |
| `dev-<提交>`，另有 `-amd64`、`-arm64` 单架构标签                 | `dev-image`。                          |
| `dev`                                                            | 仅在 main 仍指向构建提交时更新。       |
| `X.Y.Z`，不带 `v`                                                | `publish`，与候选镜像具有同一 digest。 |

不产生 `latest` 标签。候选草稿包含 7 个包、各自的 `.sha256` 和汇总 `SHA256SUMS`；最后上传的 `delivery.json` 标记候选完成，记录源码、运行 ID、汇总校验文件摘要和镜像 digest。

`publish` 使用 main 当前提交中的脚本，检查候选与 tag 指向同一源码、附件与校验文件一致，再把候选 digest 复制为版本标签，并公开 Release。

### 权限与仓库设置

- 工作流使用 `GITHUB_TOKEN`；分发和发布任务需要 `contents: write`、`packages: write`，仓库或组织的 Actions 设置须允许这些权限。
- GHCR 已有同名 package 时，在 package 设置中授予本仓库的 Actions 访问权限。
- 公开分发镜像时把 package 设为 public，并用未登录的 Docker 确认能拉取。仓库和 package 的可见性分别设置。

### 失败后的处理

| 情况                                               | 处理                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 网络、runner 或权限设置导致失败                    | 修复后选择 “Re-run all jobs”。artifact 只保留 1 天，只重跑失败任务可能缺少其他任务的 artifact。 |
| 草稿缺少 `delivery.json`                           | 候选未完成，不能发布。重跑该 tag 的运行；无法重跑时删除并重新推送尚未发布的 tag。               |
| 候选需要修改源码                                   | 修复合并到 main 后，按下方命令重建 tag。新候选替换草稿附件和正文，须重新验证并填写说明。        |
| `publish` 在复制镜像或公开草稿时失败               | 再次运行 `publish`；版本标签已指向同一 digest 时会继续完成。                                    |
| 版本已经发布，或 `Version image … already differs` | 不覆盖已有版本；修改版本号并发布新版本。                                                        |
| `dev-image` 报 `main advanced`                     | `dev-<提交>` 已推送，`dev` 未更新；在新的 main 上重新运行。                                     |

仅对尚未正式发布的版本，在新提交上重新创建 tag：

```sh
KITELINE_VERSION=X.Y.Z # 替换为尚未正式发布的目标版本
git fetch origin
git push --delete origin "v$KITELINE_VERSION"
git tag -f "v$KITELINE_VERSION" origin/main
git push origin "v$KITELINE_VERSION"
```

server 任务失败时，可在该运行下载 `server-diagnostics-<架构>` 日志 artifact；它也只保留 1 天。

## 构建机准备

本机构建在仓库根目录执行，使用 [`package.json`](../../package.json) 指定的 Node 与 pnpm，通过 `corepack enable pnpm` 启用 pnpm。组包会删除各包的开发编译输出并重新构建，因此先停止 `pnpm dev`。

Linux 本机构建需要 Docker Engine、BuildKit，以及下列工具。Ubuntu 24.04 上以 root 权限安装：

```sh
sudo apt-get update
sudo apt-get install -y git curl xz-utils zstd zip unzip binutils libarchive-tools
```

默认在与目标相同架构的主机上构建。x64 主机构建 arm64 时先注册 QEMU：`docker run --privileged --rm tonistiigi/binfmt --install arm64`；反向构建时改为 `amd64`。模拟执行比原生构建慢。`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 会传入 Docker 构建，curl 下载也使用这些设置。

### 构建 Windows 组件

CI 在 Windows x64 上准备输入并编译 tmux，再传到 Linux x64 编译 addon、组装和打包，步骤见 [`build.yml`](../../.github/workflows/build.yml)，组件入口见 [`build-windows-components.mjs`](../../scripts/build-windows-components.mjs)。Windows 需要匹配版本的 x64 Node、默认位置的 7-Zip 24.06 或更新版本和系统 `tar.exe`；验证最终 ZIP 使用 PowerShell 7。

Windows checkout 前执行 `git config --global core.autocrlf false`，避免换行转换改变配方摘要。需要本机排错时，按工作流运行对应步骤；`tmux`、`addon`、`assemble` 的输出目录必须不存在，父目录必须存在。

### 构建 macOS 组件

CI 在与目标架构一致的 Mac 上完成组件构建和组包，步骤见 [`build.yml`](../../.github/workflows/build.yml)，组件入口见 [`build-macos-components.mjs`](../../scripts/build-macos-components.mjs)。Node 的架构须与目标一致，且必须安装 Command Line Tools for Xcode（`xcode-select --install`）；仅安装 Xcode 不满足脚本检查。组件输出目录必须不存在。

### 缓存与清理

下载缓存位于 `/var/tmp/kiteline-release-cache/`，复用前检查 SHA-256，可按需删除。组件输入目录和 Docker 层缓存会复用已有下载或构建；手动创建的组件、解包和验证目录须自行清理。

镜像上下文包含 `dist/releases/` 下全部 server 归档及其校验文件；需要减小上下文时可删除旧 server 包。独立 agent 包不再进入镜像上下文。

## 构建 Linux 包与镜像

完成[构建机准备](#构建机准备)后，在干净的 Linux x64 checkout 中构建仅携带 Linux amd64 agent 的 server：

```sh
pnpm install --frozen-lockfile
pnpm package agent linux-amd64
pnpm package server amd64 --agent-target=linux-amd64
pnpm images amd64
```

Linux arm64 主机可将上述 `amd64` 改为 `arm64`。完整多平台产物请运行 CI 的 `full`。

`--agent-target` 决定 server 携带哪些 agent；省略时要求全部五个平台。上述局部包不能提供其他平台的安装和升级资源，也不能通过要求五个平台齐全的 `verify-package server`。命令参数以 [`package.mjs`](../../scripts/package.mjs) 为准。

`pnpm images` 使用当前提交的 server 包，只生成本地标签 `kiteline-server:<版本>-<架构>`。用本地镜像部署时，在 Compose 的 `.env` 中设置 `KITELINE_IMAGE=kiteline-server`、`KITELINE_VERSION=<版本>-<架构>`；fork 镜像则使用实际镜像路径和标签。部署步骤见[使用 Docker 部署](../guide/server.md#使用-docker-部署)，镜像配方见 [`Dockerfile.server`](../../release/Dockerfile.server)。

### 常见构建错误

| 报错                                                                    | 原因与处理                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Build agent <目标> first`                                              | 缺少该 agent 包或 `.sha256`。先构建它；局部测试可用 `--agent-target` 只选择已构建的平台。 |
| `Windows component inputs do not match this source; prepare them again` | 输入来自不同配方或 Windows checkout 转换了换行；修正后重新准备输入。                      |
| `Windows component build is stale or damaged: …`                        | tmux 或 addon 输出与输入不符或被改动；重跑对应构建步骤。                                  |

工作树不干净时，先提交或处理改动；组包中途源码变化时，重新构建。

## 验证发布包

以下命令接着本机 Linux amd64 构建执行。需要同一提交的干净 checkout、匹配的锁文件、压缩包旁的 `.sha256`，以及[agent 运行条件](../guide/devices.md#支持的系统与准备)。

```sh
KITELINE_VERSION=$(node -p "require('./shared/src/version.json').version")
CHECK=$(mktemp -d /var/tmp/kiteline-check-XXXXXX)
tar -xzf "dist/releases/kiteline-agent-$KITELINE_VERSION-linux-amd64.tar.gz" -C "$CHECK"
tar -xzf "dist/releases/kiteline-server-$KITELINE_VERSION-linux-amd64.tar.gz" -C "$CHECK"
node scripts/verify-package.mjs agent linux-amd64 \
  "dist/releases/kiteline-agent-$KITELINE_VERSION-linux-amd64.tar.gz" "$CHECK/kiteline-agent-$KITELINE_VERSION-linux-amd64"
"$CHECK/kiteline-agent-$KITELINE_VERSION-linux-amd64/bin/kiteline-agent" --version
KITELINE_AGENT_HOME="$CHECK/agent-state" KITELINE_AGENT_RUN_DIR="$CHECK/agent-run" \
  "$CHECK/kiteline-agent-$KITELINE_VERSION-linux-amd64/bin/kiteline-agent" check
node scripts/verify-server.mjs "$CHECK/kiteline-server-$KITELINE_VERSION-linux-amd64" "$CHECK/server-run" \
  --agent="$CHECK/kiteline-agent-$KITELINE_VERSION-linux-amd64"
node scripts/verify-server.mjs "$CHECK/kiteline-server-$KITELINE_VERSION-linux-amd64" "$CHECK/image-run" \
  --image="kiteline-server:$KITELINE_VERSION-amd64"
```

[`verify-package.mjs`](../../scripts/verify-package.mjs) 校验归档、解包内容、来源、权限和链接，不运行包中的程序；解包目录须保留归档中的根目录名。完整 server 包还要求 `dist/releases/` 中有与包内相同的五个 agent 包，CI 的 [`build.yml`](../../.github/workflows/build.yml) 包含该验证。

[`verify-server.mjs`](../../scripts/verify-server.mjs) 启动包或镜像并检查健康响应和正常退出；`--agent` 另检查绑定和终端输出。两种选项不能同时使用，运行目录必须是父目录已存在的新目录；使用镜像时也需要已解开的 server 包用于核对身份。日志保存在验证目录内，直接运行包时主机架构须与包一致。其他平台的校验和运行命令见 [`build.yml`](../../.github/workflows/build.yml)。

## 产物结构

### 发布包

| 路径                                      | 内容                                                                      | 所在包 |
| ----------------------------------------- | ------------------------------------------------------------------------- | ------ |
| `LICENSE`、`release.json`、`SHA256SUMS`   | 项目许可、包身份及文件摘要。                                              | 全部   |
| `bin/`                                    | agent 或 server 启动脚本；agent 另含安装后的启动入口，Windows 为 `.ps1`。 | 全部   |
| `runtime/`                                | Node 运行时及其许可。                                                     | 全部   |
| `shared/`、`agent/`、`terminal-recorder/` | 编译后的 JS 与生产依赖。                                                  | agent  |
| `deploy/`                                 | 本平台的服务管理器示例。                                                  | agent  |
| `dist/native/`                            | 原生组件、来源记录和许可，Windows 另含 `sources/`。                       | agent  |
| `shared/`、`server/`、`web/dist/`         | server 程序、生产依赖和工作台。                                           | server |
| `installer/`、`downloads/`                | 接入和升级模板、agent 包及校验文件、安装脚本。                            | server |

包根目录为 `kiteline-<agent|server>-<版本>-<平台>-<架构>/`。Linux 和 macOS 包的目录及可执行文件权限为 `0755`，其他文件为 `0644`。Windows ZIP 没有符号链接，解压和安装不需要 Windows 开发者模式。

Linux agent 使用静态 Node，其余包使用官方 Node。精确组件集合由包内 `SHA256SUMS` 和 `dist/native/identity.json` 记录；平台差异见[平台实现](../design/platforms.md)。

### 清单文件

- `release.json` 记录包身份、源码提交、锁文件摘要和构建来源，供安装、升级和发布检查使用。
- `dist/native/identity.json` 记录原生组件来源与摘要，以及组包时写入的 xterm.js 配套版本和终端 profile。
- 包内 `SHA256SUMS` 用于逐文件核验；包旁的 `<包名>.sha256` 用于核验归档。

### 第三方许可

- 包根 `LICENSE` 是项目许可；`runtime/LICENSE` 是 Node 许可；生产依赖在 `node_modules` 中保留自己的许可文件。
- server 的 `web/dist/licenses/` 包含 `dependencies.md`、`project.txt`、`tailwindcss.txt`、`vite.txt` 和 `xterm-css.txt`。
- agent 的 `dist/native/licenses/` 保留原生组件许可：Linux 为 libevent、ncurses、tmux、musl 和 rg；macOS 为 libevent、tmux、flock 和 rg；Windows 为 tmux、rg、mingw-w64、bash、readline、coreutils、util-linux、gettext、libiconv、libevent、ncurses 和 msys2-runtime。
- Windows 的 `dist/native/sources/` 还包含 bash、coreutils、util-linux、gettext、libiconv、readline 和 msys2-runtime 的 MSYS2 源码包，含构建配方和补丁。

### 镜像

镜像从已构建的 server 包和固定 Ubuntu 输入生成，配方见 [`Dockerfile.server`](../../release/Dockerfile.server)。运行用户、挂载权限和端口见[使用 Docker 部署](../guide/server.md#使用-docker-部署)。

## 升级固定依赖

升级时更新下列关联位置，完整运行 CI 构建，并按[手工验证](setup.md#手工验证)测试受影响的平台。下载地址变化时同步更新 SHA-256，可使用上游校验文件或下载后运行 `sha256sum`；输入文件的职责见[构建输入](../../release/README.md)。

### Node

一起更新 `package.json` 的 `engines.node` 和匹配的 `@types/node` 主版本、`release/inputs.json` 的 `node` 与官方 Linux 归档摘要、`release/agent-windows.json` 的 Node 归档和头文件摘要，以及 `release/agent-macos.json` 两个架构的 Node 摘要。

Linux agent 还需先在 [Azure99/node-static-builds](https://github.com/Azure99/node-static-builds) 发布新静态组件，再更新 `release/node-static.json` 的摘要和 `recipeRevision`。

`package.json` 的 `engines.node` 与 `release/inputs.json` 的 `node` 必须是同一精确版本，否则组包失败。Node 22 的官方维护期到 2027-04-30 结束，应在此之前升级到新的 LTS；升级后重新验证[代理行为](#undici-与代理)。

### pnpm

更新 `package.json` 的 `packageManager` 并运行 `pnpm install` 更新锁文件。`pnpm deploy` 决定生产依赖的包内布局，升级后须由 CI 检查各平台的最终包。

### rg

更新 `release/inputs.json` 的 `ripgrep.version`，配套更新同文件的 Linux 归档、`release/agent-macos.json` 两架构和 `release/agent-windows.json` 的归档摘要，然后重新运行 `pnpm native:build`。

### tmux 与 libevent

更新 `release/inputs.json` 的 tmux/libevent 及 `release/agent-macos.json` 的 `libeventVersion` 标签；Linux 的 libevent/ncurses Ubuntu 补丁在 `release/agent-linux.json`，Windows 的库和 DLL 集合在 `release/agent-windows.json` 的 MSYS2 包及 `runtimeFiles`。

确认 `native/tmux/paste.patch` 和 `native/tmux/cygwin-outfd.patch` 仍可应用，并验证终端输入、粘贴、恢复和本机接续。tmux 变化后重新运行 `pnpm native:build`；开发构建使用系统 libevent。

### Ubuntu 镜像与快照

更新 `release/inputs.json` 的 `ubuntu` digest 和 `release/ubuntu.sources` 的快照。快照日期还出现在 `inputs.json` 的 `caCertificates`、`libevent` 及 `agent-linux.json` 源码地址中，需配套更新地址和摘要。

### Alpine 与 Linux 工具链

更新 `release/agent-linux.json` 的 `alpine` digest 或 `release/agent-linux-packages.txt` 后，对比包内 `dist/native/build-packages.txt` 的实际包版本。包表格式见[构建输入](../../release/README.md#文件)。

### MSYS2

更新 `release/agent-windows.json` 的输入。源码包变化时，连同 `sources` 条目的地址、摘要和 `notice` 中的上游归档名、目录及许可路径一起修改；[`prepare-windows-notices.mjs`](../../scripts/prepare-windows-notices.mjs) 据此提取许可和复制源码。libevent、ncurses 和 msys2-runtime 的许可从对应安装包提取。

### macOS 组件

最低系统版本以 `release/agent-macos.json` 的 `deploymentTarget` 为准。改变支持范围时同步更新两个 README、[接入设备](../guide/devices.md#支持的系统与准备)及其[英文版](../guide/devices.en.md#supported-systems-and-prerequisites)、[平台实现](../design/platforms.md#macos)，并验证受影响的平台。

### xterm.js

固定版本见 [`web/package.json`](../../web/package.json)、[`terminal-recorder/package.json`](../../terminal-recorder/package.json) 和 [`shared/package.json`](../../shared/package.json)。当前浏览器与 headless 版本来自同一上游源码提交，升级须联合核对两端和 addons。私有成员访问以 [`TerminalCore` 和 `core()`](../../shared/src/terminal/index.ts) 为检查入口，另须核对 [`auxiliary-input.ts`](../../web/src/terminal/auxiliary-input.ts) 使用的私有键盘编码。

工作台直接编译 xterm 的 TypeScript 入口。现有补丁由 [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) 的 `patchedDependencies` 指向 `web/patches/`：`DomRenderer.ts` 和 `WidthCache.ts` 按设备像素比测量字形，修复 Windows 页面缩放后的中文选区错位；`Event.ts` 的非空断言适配项目的 `noUncheckedIndexedAccess`，不改变 DPR 行为。

维护当前版本的补丁时，在仓库根目录执行：

```sh
XTERM_VERSION=$(node -p "require('./web/package.json').dependencies['@xterm/xterm']")
pnpm patch "@xterm/xterm@$XTERM_VERSION"
# 在输出的 EDIT_DIR 中修改 src/ 下的 TypeScript，然后执行：
pnpm patch-commit --patches-dir web/patches EDIT_DIR
```

`pnpm patch` 默认在已有补丁之上编辑；`--ignore-existing` 从原始包开始。`patch-commit` 会重新安装依赖，一起提交补丁、`pnpm-workspace.yaml` 和锁文件。

升级版本时，先更新相关依赖并删除旧版本补丁登记，再运行 `pnpm install`，避免 `ERR_PNPM_UNUSED_PATCH`；核对上游修复后按需移植补丁，删除不再使用的旧文件。生产构建和开发预优化都需要 legacy 参数装饰器转换，应分别启动完整应用验证显示、选择、恢复和输入，并在 Windows 页面缩放下检查中文拖选及复制。

### Undici 与代理

升级 Node、`undici`、`proxy-from-env` 或 `https-proxy-agent` 后，在直连、HTTP 代理和需要认证的代理下验证绑定和连接；`undici` 的 dispatcher 须兼容 Node 内置 `fetch`。实现见 [`agent/src/network.ts`](../../agent/src/network.ts)，配置见[出站代理与证书](../guide/devices.md#出站代理与证书)。

`https-proxy-agent` 的现有补丁在 [`agent/patches/`](../../agent/patches/) 中，修复 CONNECT 后 TLS 丢失目标 host、导致可信 IP-only 证书被误按 localhost 校验的问题。升级时核对上游是否修复，据此迁移或删除补丁及 `pnpm-workspace.yaml` 的旧登记，保留可信 IP-only 目标的连接验证。

### Tailwind 与 CodeMirror

这些依赖的升级验证见[浏览器兼容](../design/architecture.md#浏览器兼容)。

### 工作流中的 action

action 按提交 SHA 固定，升级时同时更新 SHA 和行尾版本注释。
