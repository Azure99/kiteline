# 源码开发

本文面向贡献者，说明如何从源码运行 Kiteline，以及提交前要做的检查。构建发布包见[构建与发布](release.md)。

## 环境要求

源码开发使用 Linux（x64 或 arm64）。原生组件的开发构建 `pnpm native:build` 只支持 Linux，源码运行的 agent 和完整的测试都依赖它的输出。

| 工具             | 要求                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| Node             | 使用 [`package.json`](../../package.json) 的 `engines.node` 指定版本。                  |
| pnpm             | 使用 `package.json` 的 `packageManager` 指定版本，通过 Corepack 启用。                  |
| 原生组件构建     | C 编译器、`make`、`pkg-config`、libevent 与 ncurses 开发文件、`tic`、bison、curl、patch |
| 源码运行的 agent | 与设备相同的前置条件，见[支持的系统与准备](../guide/devices.md#支持的系统与准备)        |
| Docker           | 只在[本地 HTTPS](#本地-https) 和构建发布包时使用                                        |

在 Ubuntu 上安装原生组件构建所需的软件包（需要 root 权限）：

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libevent-dev libncurses-dev ncurses-bin bison curl patch
```

启用 `package.json` 指定的 pnpm 版本：

```sh
corepack enable pnpm
```

Node 安装在系统目录（如 `/usr/bin`、`/usr/local/bin`）时，以 root 权限执行该命令。

本机 Node 版本与 `engines.node` 不同时，pnpm 只打印 `Unsupported engine` 警告并继续执行。CI 使用 `package.json` 中的 Node 版本，本机使用相同版本可以得到一致的结果。

## 安装依赖与构建

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm native:build
pnpm build
```

`pnpm install --frozen-lockfile` 按锁文件安装依赖，并应用 `pnpm-workspace.yaml` 中 `patchedDependencies` 登记的补丁。`pnpm native:build` 生成源码 agent 和测试所需的 `dist/native/`；开发构建动态链接系统的 libevent 和 ncurses。`pnpm build` 编译各包并构建工作台。

修改原生源码、tmux 补丁、terminfo 或固定的 tmux/rg 输入后，重新运行 `pnpm native:build`。它每次重新下载并编译 tmux；rg 归档缓存在 `/var/tmp/kiteline-release-cache/ripgrep/`。

## 本地运行

server 的默认数据目录 `/var/lib/kiteline` 通常不可写，开发时用 `KITELINE_DATA_DIR` 指定一个目录，在仓库根目录执行：

```sh
KITELINE_DATA_DIR=/var/tmp/kiteline-dev/server pnpm dev
```

`pnpm dev` 先编译一次，再持续编译源码、自动重启 `127.0.0.1:8080` 的 server，并在 `http://localhost:5173` 提供工作台热更新和 server 请求代理，入口见 [`scripts/dev/run.mjs`](../../scripts/dev/run.mjs)。本机的 8080 和 5173 端口需要空闲。按 Ctrl-C 或任一子进程退出都会结束整个开发环境。

server 首次启动时在输出中打印 `Kiteline setup token: …`。打开 `http://localhost:5173`，输入该 token 并设置密码。token 过期或丢失时，先停止 `pnpm dev`，再生成新的 token：

```sh
KITELINE_DATA_DIR=/var/tmp/kiteline-dev/server pnpm server setup-token
```

忘记密码时把 `setup-token` 换成 `reset-password`。两个命令的使用条件和效果见[重置初始化 token 与密码](../guide/server.md#重置初始化-token-与密码)。

### 运行源码中的 agent

源码运行的 server 没有发布包中的 `downloads/` 目录，网页上的“复制接入命令”和升级命令无法下载 agent。开发时直接运行源码中的 agent：

1. 在工作台点击“绑定设备”，平台选择 Linux，展开“已安装，仅绑定”。命令中 `printf '%s\n'` 后面引号内的值就是绑定码。
2. 另开一个终端，以当前用户在仓库根目录执行：

   ```sh
   export KITELINE_AGENT_HOME=/var/tmp/kiteline-dev/agent
   pnpm agent check
   pnpm agent bind --server http://localhost:5173
   pnpm agent run
   ```

   `bind` 显示 `Binding code:` 时输入绑定码。`run` 在前台运行 agent，按 Ctrl-C 停止。

`pnpm agent` 运行 `agent/dist/main.js`，并从仓库根目录的 `dist/native/` 读取 tmux、rg 等组件。修改 agent 代码后，等 `tsc -b --watch` 完成编译，再重新执行 `pnpm agent run`。

不设置 `KITELINE_AGENT_HOME` 时，agent 使用 `~/.local/share/kiteline-agent`，与同一用户安装的 agent 的默认数据目录相同。开发时设置单独的目录，避免两者共用设备身份和工作区登记。

## 本地 HTTPS

用 Caddy 在本机提供 `https://localhost:8443`，可以检查工作台经过 HTTPS 反向代理时的行为，例如 `X-Forwarded-Proto` 的处理、带 `Secure` 属性的 Cookie、WebSocket 和流式响应。[`scripts/dev/Caddyfile`](../../scripts/dev/Caddyfile) 把 server 的路径直接转发到 `127.0.0.1:8080`，其余请求转发到 Vite。

1. 启动开发环境时增加 `KITELINE_TRUST_PROXY_PROTO=1`：

   ```sh
   KITELINE_TRUST_PROXY_PROTO=1 KITELINE_DATA_DIR=/var/tmp/kiteline-dev/server pnpm dev
   ```

   请求没有 `X-Forwarded-Proto` 时，server 按 HTTP 处理，所以 `http://localhost:5173` 入口照常可用。

2. 另开一个终端，在仓库根目录运行 Caddy：

   ```sh
   docker run --rm --name kiteline-dev-caddy --network host \
     -v "$PWD/scripts/dev/Caddyfile:/etc/caddy/Caddyfile:ro" \
     -v /var/tmp/kiteline-dev/caddy:/data caddy:2.10.2
   ```

3. Caddy 启动后在 `/var/tmp/kiteline-dev/caddy/caddy/pki/authorities/local/root.crt` 生成本地根证书。该文件由容器内的 root 用户创建，复制一份当前用户可读的副本：

   ```sh
   sudo install -m 0644 /var/tmp/kiteline-dev/caddy/caddy/pki/authorities/local/root.crt /var/tmp/kiteline-dev/caddy-root.crt
   ```

4. 把 `/var/tmp/kiteline-dev/caddy-root.crt` 导入浏览器或操作系统的受信任根证书，然后打开 `https://localhost:8443`。

5. agent 通过 HTTPS 入口绑定时，Node 也要信任这张根证书。使用单独的 agent 数据目录：

   ```sh
   export KITELINE_AGENT_HOME=/var/tmp/kiteline-dev/agent-https
   export NODE_EXTRA_CA_CERTS=/var/tmp/kiteline-dev/caddy-root.crt
   pnpm agent bind --server https://localhost:8443
   pnpm agent run
   ```

正式部署的反向代理要求见 [HTTPS 与反向代理](../guide/server.md#https-与反向代理)。

## 检查与测试

| 命令                | 内容                               |
| ------------------- | ---------------------------------- |
| `pnpm format:check` | 检查格式；`pnpm format` 会改写文件 |
| `pnpm lint`         | 运行 ESLint                        |
| `pnpm typecheck`    | 检查源码、测试和工作台的类型       |
| `pnpm test`         | 运行自动测试                       |
| `pnpm build`        | 编译各包并构建工作台               |

完整的 `pnpm test` 有三个前提：

- 已运行 `pnpm build`。部分测试启动编译后的 `server/dist`、`agent/dist` 和 `terminal-recorder/dist`。
- 已运行 `pnpm native:build`。文件、搜索、终端和 recorder 的测试使用真实文件系统，以及 `dist/native/` 中的 tmux、rg 和 `rename-noreplace`。
- 系统 Git 为 2.23.0 及以上版本。Git 测试在临时仓库中执行真实的 Git 命令。

只运行部分测试时，把文件或目录传给 `pnpm test`，例如 `pnpm test agent/test/git-read.test.ts`。

CI 的检查范围见[GitHub Actions](release.md#github-actions)。

## 手工验证

按改动范围在下表的环境中验证：

| 改动范围                               | 验证环境                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| 工作台界面                             | 当前版本的桌面 Chrome 和 Chromium 97；分别检查桌面布局和手机布局，并完整走一遍涉及的操作流程 |
| 终端输入、输入法、软键盘、剪贴板、全屏 | Android 手机上的 Chrome                                                                      |
| Windows 上的文件操作与安装流程         | Windows 11，工作区位于本地 NTFS 卷，使用最终发布包                                           |
| 安装、升级、卸载、原生组件或构建输入   | 每个受影响的平台，使用最终发布包                                                             |

最终发布包指 `pnpm package` 或 CI 完整构建产生的压缩包，构建方法见[构建与发布](release.md)。支持的浏览器见[浏览器与界面](../guide/usage.md#浏览器与界面)，Chromium 97 兼容的实现见[浏览器兼容](../design/architecture.md#浏览器兼容)；各平台支持的系统版本见[支持的系统与准备](../guide/devices.md#支持的系统与准备)。
