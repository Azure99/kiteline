# 安装与运行

首版面向 Linux amd64/arm64。这里集中给出实际命令。源码开发见[仓库入口](../README.md)。

## 生成交付物

在已安装依赖的源码目录执行；构建机需要 Docker BuildKit（Dockerfile 1.6+）及binutils的readelf，可通过 binfmt/QEMU 构建另一架构。用户运行发布包不需要 npm 或编译器。基础镜像、Node、amd64 rg官方归档及用于引导系统CA的Ubuntu证书包身份集中在[release.json](release.json)，构建不使用反代镜像。rg与适用许可证随包归档，不参与Node重编。

```sh
pnpm install --frozen-lockfile
pnpm package agent amd64
pnpm package server amd64 --agent-arch=amd64
pnpm images amd64
```

上述单平台构建命令只打amd64，并在server中提供配套amd64接入包。需要完整双架构发布时，先构建两种agent，再省略server的`--agent-arch`；ARM64 server另执行`pnpm package server arm64`、`pnpm images arm64`，串行控制内存。包及对应`.sha256`在`dist/releases/`；产品版本来自[version.json](../shared/src/version.json)，镜像名为`kiteline-server:<版本>-<amd64|arm64>`。本仓库不自动发布镜像，跨机器可用`docker save/load`搬运。清单记录commit、dirty、实际输入sourceDigest、Node/native与校验；组装server发现来源不一致时要求重建agent。

`package agent amd64`自动构建/复用静态组件；也可单独用 `node scripts/build-agent-static.mjs` 预构建到`dist/agent-static-amd64/`。来源与SHA在[agent-static.json](agent-static.json)，工具链版本在[agent-static-packages.txt](agent-static-packages.txt)；固定官方Node源码，无Node补丁。首次构建需数GiB内存和较长编译时间，Node固定3个编译任务，8GiB构建机避免同时运行其他重负载。Docker分别缓存Node/native阶段，业务JS变更不触发Node重编；工具链清单变更会使两者重编，验证时不能用旧缓存命中替代冷构建。源下载缓存在`/var/tmp/kiteline-release-cache`并核验SHA。输出携带许可证、实际工具包清单、输入身份和文件校验，ELF检查拒绝动态加载器或库依赖。组件升级需同步来源/工具链和代表环境验收，不能只替换二进制。

## Server 部署

镜像按前节构建或导入后，启动 server。默认只发布宿主 `127.0.0.1:8080`，管理数据保存在 `server-data` 卷；不占用 80/443、不管理证书。

```sh
export KITELINE_VERSION=$(node -p 'require("./shared/src/version.json").version')
export KITELINE_HTTP_PORT=8443
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml logs server
```

打开 http://localhost:8443。上述版本读取命令在源码根目录执行；仅导入镜像时，直接将 `KITELINE_VERSION` 设置为导入的发布版本。局域网访问时在启动前另设 `KITELINE_HTTP_BIND=0.0.0.0`，然后打开 `http://主机IP:8443`；端口可按需更改。

使用已有 HTTPS 反代时，设置 `KITELINE_TRUST_PROXY_PROTO=1` 后运行同一 Compose 命令。反代将 HTTPS 入口转到发布的 HTTP 端口，保留原 Host（含端口）、覆盖 `X-Forwarded-Proto`，普通请求与 WebSocket Upgrade 都要处理。反代必须允许 WebSocket、SSE、流式响应与上传，不缓冲流式正文、不自动重放写请求，并为长连接设置合适期限。同一实例可同时使用多个域名和 HTTP 地址，各入口分别登录；不配置单一公开 URL。

反代在另一主机/容器时，可设置 `KITELINE_HTTP_BIND` 为可达的宿主地址，或将反代接入 Compose 网络、使用 `http://server:8080`。另一容器的 `127.0.0.1` 不是宿主机。ARM64 镜像另设 `KITELINE_ARCH=arm64`。

从所选入口打开网页，输入首次日志中的 setup token 并设置拥有者密码。需要新 token 时，先停止 server，在同一卷执行命令后重新启动：

```sh
docker compose -f deploy/compose.yaml stop server
docker compose -f deploy/compose.yaml run --rm --no-deps server setup-token
docker compose -f deploy/compose.yaml up -d server
```

已初始化后的密码恢复将中间命令换成 `reset-password`，按提示输入新密码。不要换空卷；原登录会话会失效。备份可停止 server 后备份整个 `server-data` 卷，agent 登记和凭据单独备份，项目文件沿原方式备份。

原生 server：校验并解压完整 server 包到 `/opt/kiteline-server`，创建专用 `kiteline` 用户及其可写的 `/var/lib/kiteline`，将 [unit](kiteline-server.service) 安装为 `/etc/systemd/system/kiteline-server.service`。创建 `/etc/kiteline-server.env`，默认可只写 `KITELINE_TRUST_PROXY_PROTO=0`；接 HTTPS 反代时改为1，需要局域网直连或自定义端口时设置 `KITELINE_LISTEN_ADDR=0.0.0.0:8443`。执行 `systemctl daemon-reload`、`systemctl enable --now kiteline-server`，查看 `journalctl -u kiteline-server` 取得初始化 token。恢复时停止 unit，用 `sudo -u kiteline env KITELINE_DATA_DIR=/var/lib/kiteline /opt/kiteline-server/bin/kiteline-server reset-password`，再启动 unit。

## 原生 Agent

在网页设备列表点击“绑定设备”，生成并复制接入命令，在目标 Linux 机器以日常项目用户执行。命令从当前 server 下载配套包并校验，安装时需要 sudo，绑定与运行仍属于该用户。默认前台运行，Ctrl-C 停止；以后直接 `kiteline-agent run`，无需重新绑定。选择“后台常驻”才安装并启动 systemd 服务，需要非 root 用户与运行中的 systemd。

网页自动生成当前访问地址的 `curl .../connect.sh | sh -s -- 'CODE'` 命令，后台方式只追加 `--service`。实际命令含下载协议限制：HTTPS不降级，HTTP可用HTTP/HTTPS；绑定码保留为 shell 参数，不进入下载 URL。目标设备必须能够访问该地址，不能从手机的 localhost 地址给另一台机器绑定。

amd64目标机需要 curl、Git 2.23.0+、SSH、flock（util-linux）、有效的 UTF-8 locale 和项目使用的 Shell/CLI，rg已随包提供。缺项时命令停止并给出安装建议，不自动修改系统依赖。ARM工具要求见[运行基线](#平台要求)。下面的基础依赖命令以 root 执行，普通用户加 sudo：

```sh
# Ubuntu 24.04 / Debian 12
apt-get update
apt-get install -y curl ca-certificates tar gzip coreutils git openssh-client ncurses-bin locales util-linux
# Alpine 3.23
apk add curl ca-certificates tar gzip coreutils musl-utils git openssh-client ncurses musl-locales util-linux
# CentOS 7.9：另外提供 Git 2.23.0+，默认仓库版本不足。
yum install -y curl ca-certificates tar gzip coreutils openssh-clients ncurses glibc-common util-linux
```

用 `locale -a` 确认已安装的 UTF-8 locale，`locale charmap` 应输出 UTF-8。CentOS 7 可使用已安装的 `en_US.UTF-8`；若该 locale 已安装，可在运行接入命令的 Shell 中执行 `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`。`LC_ALL` 优先于 `LC_CTYPE` 和 `LANG`。后台模式还需在首次接入前将相同设置写入 `/etc/kiteline-agent.env`；服务默认的 `LANG=C.UTF-8` 不能代替该系统实际安装的 locale。保留该文件原有内容；前台只读取其中的目录项，locale 沿用启动 Shell。

Node、recorder、固定 tmux、terminfo 和文件 helper 已随包提供，无需 npm/编译器。安装失败后先处理具体原因，再执行命令；绑定码已过期则在网页重新生成。程序已安装但绑定失败时不重复替换安装；已有身份或不同版本会停止，不自动重绑/升级。若已登记但未在线，先核对本地凭据和 `kiteline-agent run` 输出；凭据丢失在网页撤销残留身份并重新生成绑定码，不能把未知结果当成普通过期重试。

也可手工取得完整包及 `.sha256`，校验、解压、安装，再用网页“已安装，仅绑定”命令绑定：

```sh
# KITELINE_VERSION 设为下载的版本；ARM64 将 amd64 换成 arm64。
kiteline_package="kiteline-agent-${KITELINE_VERSION}-linux-amd64"
sha256sum -c "$kiteline_package.tar.gz.sha256"
tar -xzf "$kiteline_package.tar.gz"
"./$kiteline_package/bin/kiteline-agent" check
sudo "./$kiteline_package/bin/kiteline-agent" install --user YOUR_USER
# 执行网页提供的绑定命令后：
kiteline-agent run
```

设备上线后，先在网页为该设备添加 workspace，选择项目目录；再获取 `WORKSPACE_ID` 创建终端：

```sh
kiteline-agent workspace list
kiteline-agent terminal new --workspace WORKSPACE_ID
kiteline-agent terminal attach SESSION_ID
```

CLI 与运行进程共用 `/etc/kiteline-agent.env` 中的目录。`KITELINE_AGENT_HOME` 和 `KITELINE_AGENT_RUN_DIR` 使用单行双引号绝对路径，不使用转义或尾部注释；新安装默认状态在项目用户的 `~/.local/share/kiteline-agent`，socket 在该目录下的 `run/`。其他服务环境如 PATH、SSH_AUTH_SOCK、LANG 也在该文件配置，重启后生效。`kiteline-agent doctor` 检查实际进程环境；仓库认证是否成功仍以实际 Git 同步为准。

前台转常驻：先 Ctrl-C 停止，再执行 `sudo kiteline-agent service install --user YOUR_USER` 和 `sudo kiteline-agent service start`。常驻转前台：先 `sudo kiteline-agent service stop`、`sudo kiteline-agent service disable`，再 `kiteline-agent run`。两者保留身份和 workspace，但停止会结束终端任务。默认共用状态目录下的 `run/`。

```sh
kiteline-agent service status
sudo kiteline-agent service logs --follow
sudo kiteline-agent service stop
sudo kiteline-agent service upgrade --archive "/path/to/kiteline-agent-${KITELINE_VERSION}-linux-amd64.tar.gz"
sudo kiteline-agent service uninstall
```

更新server后，刷新网页；设备版本不匹配时，在设备详情动作中选“升级agent”，复制命令到该设备的独立终端或SSH执行。命令从当前网页入口下载配套包和`.sha256`，调用上述upgrade，无需重新绑定；换入口下载不会更改agent已保存的连接地址。前台先自行停止，完成后再运行`kiteline-agent run`；systemd沿原方式重启。卸载默认保留状态与环境文件，`--purge-state`只移除agent自己的状态JSON，保留目录和项目文件。

### Agent 出站代理

绑定及控制/数据 WS/WSS 共用环境代理。前台 `bind`/`run` 使用当前 Shell 的环境，例如：

```sh
export HTTPS_PROXY=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1,.internal.example
kiteline-agent run
```

HTTP/WS使用HTTP代理变量，HTTPS/WSS使用HTTPS代理变量；上例HTTP选小写`http_proxy`，也供安装下载的curl使用。systemd 将相同的 `KEY=value` 写入 `/etc/kiteline-agent.env`，不带 `export`，在维护窗口停止/启动服务后生效；只在执行 `systemctl` 的 Shell 中 export 不会改变服务环境。停止会结束终端任务。前台只共用该文件的安装目录项，不自动加载其中的代理变量。

设备本地 HTTP 服务始终直连。新 Shell/AI CLI 继承 agent 的环境，但程序是否使用代理由自身决定；现有任务不会自动更新。同名非空小写变量优先；未配置协议代理时回退 ALL_PROXY，HTTPS 不回退 HTTP_PROXY。NO_PROXY 指定直连目标，仅支持 HTTP(S) 代理。

### 运行与维护补充

Linux 的 Unix socket 完整路径限 103 字节。显式使用 `/run` 等易失运行目录时，启动前及系统重启后需准备属于运行用户的可写目录。

维护需明确确认，停止会结束终端任务，保留配置、绑定和 workspace。新服务未就绪时恢复旧安装并报告结果；前台升级后保持停止。

短接入命令的外层 curl 失败时，POSIX 管道退出状态未必非零；以实际绑定和设备在线状态确认完成。

开启 `KITELINE_TRUST_PROXY_PROTO` 后，只将 HTTP 端口交给可信客户端或反代；环境代理须允许 CONNECT，包括目标为 HTTP 的连接。

## 自行准备的容器

先创建自己的 Linux 容器并准备上述基础依赖、项目工具和挂载，再在容器内执行同一网页前台命令。没有 systemd 不影响前台运行，root 容器也可使用；容器的常驻和重建由你自行管理，工作台不提供容器创建入口。

项目目录与 agent 状态要持久化，运行用户的 UID/GID、HOME 与挂载权限一致。在网页选择容器内项目路径；本机接续用 `docker exec -it CONTAINER kiteline-agent terminal attach SESSION_ID`，保持同一用户及状态目录。容器停止会结束任务，重建时须保留安装或重新安装；不要删除身份卷后误当原设备接续。

SSH 挂载该用户的 key、config、known_hosts，或可达的 SSH agent socket 并设置 SSH_AUTH_SOCK。`.gitconfig` 引用的 credential helper 也须在容器安装；只读 known_hosts 不会自动记录新主机。先在工作台终端验证实际认证，再使用 Git 界面同步。

linked worktree 同时挂载工作目录、gitDir 和 commonDir；`.git` 指向宿主绝对路径时保持相关目录的同一绝对路径，否则 Git 元数据不可达。

### 开发服务

同容器终端启动的服务可直接从端口入口访问，无需发布宿主端口。独立服务容器可使用 `network_mode: service:agent` 明确共享网络；普通 bridge 的其他容器和宿主 localhost 不属于 agent 的 localhost。原生 agent 则能访问已发布到宿主本地端口的容器服务。

普通路径代理尽力兼容相对地址；Vite 使用“保留路径”并设置对应 `base`、实际域名 `server.allowedHosts`，HMR 沿相同入口使用 WS/WSS。应用写死的根相对 API/登录回调仍需项目配置。

## 平台要求

| 组件                         | 运行前提                                                             |
| ---------------------------- | -------------------------------------------------------------------- |
| Linux agent amd64            | Ubuntu 24.04、Debian 12、Alpine 3.23、CentOS 7.9；静态 musl，rg 随包 |
| Linux agent arm64            | Ubuntu 24.04；另需 rg 14+                                            |
| server 包及镜像 amd64、arm64 | Ubuntu 24.04                                                         |

设备还需 Git 2.23+、SSH、有效 UTF-8 locale 和项目使用的 Shell/CLI。Linux 静态包不替代这些外部程序的系统依赖，也不加载 glibc NSS 插件或动态 Node addon。Linux 文件发布要求内核与文件系统支持 `renameat2(RENAME_NOREPLACE)`；CentOS 7.9 amd64 基线为含此回移植的 `3.10.0-1160.el7.x86_64`。
