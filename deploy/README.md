# 安装与运行

首版面向 Linux amd64/arm64。这里集中给出实际命令。源码开发见[仓库入口](../README.md)。

## 生成交付物

在已安装依赖的源码目录执行；构建机需要 Docker BuildKit（Dockerfile 1.6+），可通过 binfmt/QEMU 构建另一架构。用户运行发布包不需要 npm 或编译器。基础镜像、Node 和用于引导系统 CA 的 Ubuntu 证书包身份集中在 [release.json](release.json)，构建不使用反代镜像。

```sh
pnpm install --frozen-lockfile
pnpm package agent amd64
pnpm package agent arm64
pnpm package server amd64
pnpm images amd64
```

每个server都携带两架构agent；两份agent须先构建。ARM64 server再执行`pnpm package server arm64`、`pnpm images arm64`，串行控制内存。包及对应`.sha256`在`dist/releases/`；server镜像为`kiteline-server:0.1.0-amd64`/`arm64`。本仓库不自动发布镜像，跨机器可用`docker save/load`搬运。清单记录commit、dirty、实际输入sourceDigest、Node/native与校验；组装server发现来源不一致时要求重建agent。

## Server 与已有 HTTPS 反代

镜像按前节构建或导入后，启动 server。默认只发布宿主 `127.0.0.1:8080`，管理数据保存在 `server-data` 卷；不占用 80/443、不管理证书。

```sh
export KITELINE_PUBLIC_URL=https://kiteline.example.com
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml logs server
```

已有反代将 `https://kiteline.example.com` 转发到 `http://127.0.0.1:8080`，透传 Host、Origin、Cookie 和 Upgrade，允许长连接及流式正文，关闭正文缓冲和写请求重放。`KITELINE_PUBLIC_URL` 填最终 HTTPS origin（含实际非默认端口），浏览器和 agent 都使用它，不填内部 HTTP upstream。

端口不同可设置 `KITELINE_HTTP_PORT=18080`；反代在另一主机/容器时，可设置 `KITELINE_HTTP_BIND` 为可达的宿主地址，或将反代接入 Compose 网络、使用 `http://server:8080`。另一容器的 `127.0.0.1` 不是宿主机。ARM64 镜像另设 `KITELINE_ARCH=arm64`。

打开 `https://kiteline.example.com`，输入首次日志中的 setup token 并设置拥有者密码。需要新 token 时，先停止 server，在同一卷执行命令后重新启动：

```sh
docker compose -f deploy/compose.yaml stop server
docker compose -f deploy/compose.yaml run --rm --no-deps server setup-token
docker compose -f deploy/compose.yaml up -d server
```

已初始化后的密码恢复将中间命令换成 `reset-password`，按提示输入新密码。不要换空卷；原登录会话会失效。备份可停止 server 后备份整个 `server-data` 卷，agent 登记和凭据单独备份，项目文件沿原方式备份。

原生 server：校验并解压完整 server 包到 `/opt/kiteline-server`，创建专用 `kiteline` 用户及其可写的 `/var/lib/kiteline`，将 [unit](kiteline-server.service) 安装为 `/etc/systemd/system/kiteline-server.service`。`/etc/kiteline-server.env` 设置 `KITELINE_PUBLIC_URL=https://kiteline.example.com`，执行 `systemctl daemon-reload`、`systemctl enable --now kiteline-server`。已有反代转到 `http://127.0.0.1:8080`。查看 `journalctl -u kiteline-server` 取得初始化 token。恢复时停止 unit，用 `sudo -u kiteline env KITELINE_DATA_DIR=/var/lib/kiteline /opt/kiteline-server/bin/kiteline-server reset-password`，再启动 unit。

## 原生 Agent

在网页设备列表点击“绑定设备”，生成并复制接入命令，在目标 Linux 机器以日常项目用户执行。命令从当前 server 下载配套包并校验，安装时需要 sudo，绑定与运行仍属于该用户。默认前台运行，Ctrl-C 停止；以后直接 `kiteline-agent run`，无需重新绑定。选择“后台常驻”才安装并启动 systemd 服务，需要非 root 用户与运行中的 systemd。

目标机需要 curl、Git 2.43+、ripgrep 14+、SSH 和项目使用的 Shell/CLI。缺项时命令停止并给出安装建议，不自动修改系统依赖；Ubuntu 24.04 可执行：

```sh
sudo apt-get update
sudo apt-get install -y curl ca-certificates git ripgrep openssh-client ncurses-bin locales
```

Node、recorder、固定 tmux、terminfo 和文件 helper 已随包提供，无需 npm/编译器。安装失败后先处理具体原因，再执行命令；绑定码已过期则在网页重新生成。程序已安装但绑定失败时不重复替换安装；已有身份或不同版本会停止，不自动重绑/升级。若已登记但未在线，先核对本地凭据和 `kiteline-agent run` 输出；凭据丢失在网页撤销残留身份并重新生成绑定码，不能把未知结果当成普通过期重试。

也可手工取得完整包及 `.sha256`，校验、解压、安装，再用网页“已安装，仅绑定”命令绑定：

```sh
sha256sum --check kiteline-agent-0.1.0-linux-amd64.tar.gz.sha256
tar -xzf kiteline-agent-0.1.0-linux-amd64.tar.gz
./kiteline-agent-0.1.0-linux-amd64/bin/kiteline-agent check
sudo ./kiteline-agent-0.1.0-linux-amd64/bin/kiteline-agent install --user YOUR_USER
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

前台转常驻：先 Ctrl-C 停止，再执行 `sudo kiteline-agent service install --user YOUR_USER` 和 `sudo kiteline-agent service start`。常驻转前台：先 `sudo kiteline-agent service stop`、`sudo kiteline-agent service disable`，再 `kiteline-agent run`。两者保留身份和 workspace，但停止会结束终端任务。旧安装仍使用 `/run/kiteline-agent` 时，转前台前先在环境文件改成项目用户可写的稳定目录。

```sh
kiteline-agent service status
sudo kiteline-agent service logs --follow
sudo kiteline-agent service stop
sudo kiteline-agent service upgrade --archive /path/to/kiteline-agent-0.1.0-linux-amd64.tar.gz
sudo kiteline-agent service uninstall
```

升级需要旁边的 `.sha256` 文件并明确确认，会结束当前终端，保留绑定、workspace 和配置；新服务未就绪时恢复旧安装并报告结果。前台方式须先停止，升级后仍保持停止；卸载默认保留状态与环境文件，`--purge-state` 只移除 agent 自己的状态 JSON，保留目录和项目文件。

## 自行准备的容器

先创建自己的 Linux 容器并准备上述基础依赖、项目工具和挂载，再在容器内执行同一网页前台命令。没有 systemd 不影响前台运行，root 容器也可使用；容器的常驻和重建由你自行管理，工作台不提供容器创建入口。

项目目录与 agent 状态要持久化，运行用户的 UID/GID、HOME 与挂载权限一致。在网页选择容器内项目路径；本机接续用 `docker exec -it CONTAINER kiteline-agent terminal attach SESSION_ID`，保持同一用户及状态目录。容器停止会结束任务，重建时须保留安装或重新安装；不要删除身份卷后误当原设备接续。

SSH 挂载该用户的 key、config、known_hosts，或可达的 SSH agent socket 并设置 SSH_AUTH_SOCK。`.gitconfig` 引用的 credential helper 也须在容器安装；只读 known_hosts 不会自动记录新主机。先在工作台终端验证实际认证，再使用 Git 界面同步。

linked worktree 同时挂载工作目录、gitDir 和 commonDir；`.git` 指向宿主绝对路径时保持相关目录的同一绝对路径，否则 Git 元数据不可达。

### 开发服务

同容器终端启动的服务可直接从端口入口访问，无需发布宿主端口。独立服务容器可使用 `network_mode: service:agent` 明确共享网络；普通 bridge 的其他容器和宿主 localhost 不属于 agent 的 localhost。原生 agent 则能访问已发布到宿主本地端口的容器服务。

普通路径代理尽力兼容相对地址；Vite 使用“保留路径”并设置对应 `base`、实际域名 `server.allowedHosts`，HMR 沿相同入口使用 WSS。应用写死的根相对 API/登录回调仍需项目配置。

## 平台要求

| 组件                         | 运行前提                                               |
| ---------------------------- | ------------------------------------------------------ |
| Linux agent amd64、arm64     | Ubuntu 24.04；另需 Git 2.43+、rg 14+、SSH 和项目 Shell |
| server 包及镜像 amd64、arm64 | Ubuntu 24.04                                           |
