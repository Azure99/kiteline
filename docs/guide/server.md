# 部署 server

本文面向部署者，说明如何部署和维护 server（`kiteline-server`，提供工作台网页、API、设备连接和开发服务代理）。部署完成后，按[接入设备](devices.md)接入第一台设备。

## 运行环境

- server 运行在 Linux amd64 或 arm64 上，有两种部署方式：
  - Docker 镜像 `ghcr.io/azure99/kiteline:<版本>`，同一标签同时包含 amd64 和 arm64。
  - 原生发布包 `kiteline-server-<版本>-linux-<架构>.tar.gz`，从 [GitHub Releases](https://github.com/Azure99/kiteline/releases) 下载。包内带有官方 Node 运行时（依赖 glibc 的动态链接构建），目标系统是 Ubuntu 24.04。
- server 只提供 HTTP，不处理 TLS 证书。需要 HTTPS 时在前面放一个反向代理，见 [HTTPS 与反向代理](#https-与反向代理)。
- server 默认只在本机地址 `127.0.0.1:8080` 上接受连接。从其他机器访问的设置见[局域网访问与端口](#局域网访问与端口)。
- 拥有者密码、登录会话和设备登记都保存在 server 数据目录中（默认 `/var/lib/kiteline`，数据库文件 `kiteline.sqlite`）。server 每次启动时把该目录权限设为 `0700`。同一个数据目录同时只能由一个 server 进程使用。
- 一个 server 可以同时通过多个入口访问。入口是协议、主机名和端口的组合，例如 `http://192.168.1.10:8080` 和 `https://kiteline.example.com`。server 只能部署在入口的根路径上，不支持 `https://example.com/kiteline/` 这样的子路径。
- server 的发布包和镜像内含全部平台的 agent 发布包。设备接入和升级时从 server 下载与 server 版本相同的 agent，不需要访问 GitHub。

server 的环境变量见[参考](reference.md#server-环境变量)。

## 使用 Docker 部署

需要 Docker Engine 和 Docker Compose v2（`docker compose` 命令）。以下命令在 server 主机上，以能使用 Docker 的用户（root 或 `docker` 组成员）执行。

1. 创建部署目录，从对应版本的仓库 tag 取得 `compose.yaml`，并把版本写入 `.env`：

   ```sh
   KITELINE_VERSION=0.2.5  # 替换为要部署的版本
   mkdir -p ~/kiteline && cd ~/kiteline
   curl -fsSLO "https://raw.githubusercontent.com/Azure99/kiteline/v$KITELINE_VERSION/deploy/compose.yaml"
   sed -i 's|kiteline-server:|ghcr.io/azure99/kiteline:|; s|-${KITELINE_ARCH:-amd64}||' compose.yaml
   printf 'KITELINE_VERSION=%s\n' "$KITELINE_VERSION" > .env
   ```

   Docker Compose 自动读取同一目录下的 `.env`。之后的 `docker compose` 命令都在这个目录中执行。

2. 拉取镜像并启动：

   ```sh
   docker compose up -d
   docker compose logs server
   ```

   日志中 `Kiteline setup token: …` 一行是初始化 token（界面中的“初始化凭据”），下一步要用；`Kiteline listening on http://0.0.0.0:8080` 表示 server 已开始监听。

3. 确认 server 正常响应：

   ```sh
   curl -fsS http://127.0.0.1:8080/healthz
   ```

   输出类似 `{"status":"ok","version":"0.2.5"}`。

4. 打开 `http://127.0.0.1:8080`，按[初始化拥有者](#初始化拥有者)设置密码。

`.env` 中还可以设置 `KITELINE_HTTP_BIND`、`KITELINE_HTTP_PORT` 和 `KITELINE_TRUST_PROXY_PROTO`，用法见[局域网访问与端口](#局域网访问与端口)和 [HTTPS 与反向代理](#https-与反向代理)，默认值见[参考](reference.md#server-环境变量)。修改 `.env` 后再次执行 `docker compose up -d`，Compose 会用新设置重建容器。

使用自己构建的镜像时，改用未作上述 GHCR 替换的仓库原版 `deploy/compose.yaml`，并设置 `KITELINE_VERSION=0.2.5` 和 `KITELINE_ARCH=amd64`（`pnpm images` 生成的本地标签为 `kiteline-server:0.2.5-amd64`，见[构建与发布](../development/release.md#构建-linux-包与镜像)）。

容器内的 server 以 `kiteline` 用户（UID 1000、GID 1000）运行，数据目录 `/var/lib/kiteline` 位于 Compose 卷 `server-data` 中。Compose 项目名是 `kiteline`，所以 Docker 中的实际卷名是 `kiteline_server-data`。`docker compose down` 保留这个卷；`docker compose down -v` 会删除卷和全部 server 数据。把卷换成宿主机目录挂载时，该目录的属主必须是 `1000:1000`。

## 原生部署

原生部署用 systemd 运行 server。以下命令在 server 主机上，以能使用 sudo 的用户在同一个 Shell 中依次执行，后面的步骤会用到第 1 步设置的变量。

1. 安装运行库，下载发布包和校验文件并校验：

   ```sh
   KITELINE_VERSION=0.2.5  # 替换为要部署的版本
   KITELINE_ARCH=amd64     # ARM64 主机改为 arm64
   name="kiteline-server-$KITELINE_VERSION-linux-$KITELINE_ARCH"
   sudo apt-get update && sudo apt-get install -y curl libstdc++6 libatomic1
   curl -fLO "https://github.com/Azure99/kiteline/releases/download/v$KITELINE_VERSION/$name.tar.gz"
   curl -fLO "https://github.com/Azure99/kiteline/releases/download/v$KITELINE_VERSION/$name.tar.gz.sha256"
   sha256sum -c "$name.tar.gz.sha256"
   ```

   校验通过时输出 `kiteline-server-<版本>-linux-<架构>.tar.gz: OK`。

2. 解压到程序目录 `/opt/kiteline-server`。包内有一层顶层目录 `kiteline-server-<版本>-linux-<架构>/`，所以解压时去掉一层：

   ```sh
   sudo mkdir /opt/kiteline-server
   sudo tar -xzf "$name.tar.gz" --no-same-owner --strip-components=1 -C /opt/kiteline-server
   /opt/kiteline-server/bin/kiteline-server --version
   ```

3. 创建专用系统用户 `kiteline` 和归它所有的数据目录：

   ```sh
   sudo useradd --system --user-group --home-dir /var/lib/kiteline --shell /usr/sbin/nologin kiteline
   sudo install -d -o kiteline -g kiteline -m 700 /var/lib/kiteline
   ```

4. 从同一版本的仓库 tag 取得 systemd unit（server 发布包不含这个文件），创建环境文件，然后启动：

   ```sh
   sudo curl -fsSL -o /etc/systemd/system/kiteline-server.service \
     "https://raw.githubusercontent.com/Azure99/kiteline/v$KITELINE_VERSION/deploy/systemd/kiteline-server.service"
   echo 'KITELINE_TRUST_PROXY_PROTO=0' | sudo tee /etc/kiteline-server.env
   sudo systemctl daemon-reload
   sudo systemctl enable --now kiteline-server
   sudo journalctl -u kiteline-server
   ```

   unit 以 `kiteline` 用户运行 `/opt/kiteline-server/bin/kiteline-server serve`，设置 `KITELINE_DATA_DIR=/var/lib/kiteline` 和 `KITELINE_LISTEN_ADDR=127.0.0.1:8080`。`/etc/kiteline-server.env` 必须存在，其中的变量覆盖 unit 里的同名设置。日志中 `Kiteline setup token: …` 一行是初始化 token。

5. 用 `curl -fsS http://127.0.0.1:8080/healthz` 确认 server 正常响应，然后打开 `http://127.0.0.1:8080`，按[初始化拥有者](#初始化拥有者)设置密码。

## 初始化拥有者

工作台只有一个账户，即拥有者，登录时只输入密码。

1. 在浏览器打开任一入口，页面显示“设置拥有者”。
2. 在“初始化凭据”中填入日志里的初始化 token，在“密码”中填入新密码，点击“初始化”。完成后浏览器已登录。

初始化 token 只在 server 第一次启动时打印一次，有效期有限（见[限额](reference.md#限额)）。重启 server 不会再次打印。token 过期或丢失时，按[重置初始化 token 与密码](#重置初始化-token-与密码)生成新 token。

密码长度按 UTF-8 字节计算（一个汉字通常占 3 字节），长度范围和登录有效期见[限额](reference.md#限额)；登录到期后重新登录。主机名或协议不同的入口需要分别登录：同一台电脑先后从 `http://192.168.1.10:8080` 和 `https://kiteline.example.com` 打开工作台，要登录两次。同一主机和协议的不同端口共用登录，但语言等偏好按入口（含端口）分别保存在浏览器中。

server 在远程主机上、又只监听 `127.0.0.1` 时，可以先用 SSH 端口转发完成初始化：在自己的电脑上执行 `ssh -L 8080:127.0.0.1:8080 USER@SERVER_HOST`，然后打开 `http://127.0.0.1:8080`。这个地址只有你的电脑能访问；接入设备时要从设备也能访问的入口打开工作台，见[用网页命令接入](devices.md#用网页命令接入)。

## 局域网访问与端口

让局域网中的其他机器直接通过 HTTP 访问 server：

- Docker：在 `.env` 中加入 `KITELINE_HTTP_BIND=0.0.0.0`，需要换端口时再加入 `KITELINE_HTTP_PORT=9080` 之类的设置，然后执行 `docker compose up -d`。
- 原生：在 `/etc/kiteline-server.env` 中加入 `KITELINE_LISTEN_ADDR=0.0.0.0:8080`，然后执行 `sudo systemctl restart kiteline-server`。

之后从其他机器打开 `http://SERVER_IP:8080`（按实际端口）。

- 原生部署时，主机防火墙需要放行该端口。
- Docker 发布的端口不受 ufw、firewalld 入站规则的限制。主机有公网地址时，把 `KITELINE_HTTP_BIND` 设为局域网地址（例如 `192.168.1.10`），不要用 `0.0.0.0`，否则端口会暴露到公网。

`KITELINE_LISTEN_ADDR` 始终写明端口（格式见[参考](reference.md#server-环境变量)）：省略端口时 server 监听 80 端口，而 `kiteline` 用户没有权限监听 1024 以下的端口，启动会失败。浏览器会拒绝访问少数端口（例如 6000、6665 至 6669），请选用常见的端口。

HTTP 直连时，密码、登录 Cookie、终端内容和文件都以明文传输。经过不可信网络访问时使用 HTTPS。

## HTTPS 与反向代理

HTTPS 由部署者自己的反向代理（nginx、Caddy 等）提供，反向代理把 HTTPS 请求转发到 server 的 HTTP 端口。

先让 server 信任反向代理传来的协议头：

- Docker：在 `.env` 中设置 `KITELINE_TRUST_PROXY_PROTO=1`，执行 `docker compose up -d`。
- 原生：在 `/etc/kiteline-server.env` 中设置 `KITELINE_TRUST_PROXY_PROTO=1`，执行 `sudo systemctl restart kiteline-server`。

设为 `1` 后，server 也信任直接连接的客户端发来的 `X-Forwarded-Proto`，所以 server 的 HTTP 端口应只让反向代理访问（保持 `127.0.0.1` 绑定，或只在反向代理所在的网络中开放）。入口识别和来源检查的规则见[通信契约](../design/protocol.md#请求入口与认证)。

反向代理必须满足以下要求：

1. 把入口的整个根路径 `/` 转发到 server，包括 `/api/`、`/proxy/`、`/absproxy/`、`/downloads/` 和安装脚本，路径和查询参数保持原样。
2. 原样转发 `Host`，包括非默认端口（例如 `kiteline.example.com:8443`）。
3. 用单个值 `https` 覆盖 `X-Forwarded-Proto`，不在已有值后追加。
4. 支持 WebSocket Upgrade。
5. 请求和响应都以流的方式转发，不缓冲：SSE、文件下载和上传都依赖这一点。上传大小不设上限，或不低于 agent 的 `transferBytes`。
6. 读写超时足够长，不短于最长的操作期限（例如 Git 写操作的 `gitWriteTimeout`）。各项数值见[限额](reference.md#限额)。
7. 不自动重试或重放请求，包括复用的上游连接断开后的重试。
8. 原样转发 `Origin`、`Cookie` 和 `Set-Cookie`（反向代理的默认行为即可）。

server 和反向代理不在同一个网络命名空间时，反向代理要能访问 server 的 HTTP 端口：反向代理在另一台主机上时，把 server 绑定到该主机能访问的地址；反向代理是同一 Compose 项目中的另一个容器时，转发到 `http://server:8080`。另一个容器里的 `127.0.0.1` 指向它自己，不是宿主机。

### nginx 示例

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name kiteline.example.com;
    ssl_certificate     /etc/ssl/kiteline.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/kiteline.example.com/privkey.pem;

    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_next_upstream off;
    }
}
```

`map` 放在 `http` 块中（`conf.d` 下的文件默认就在 `http` 块中）。`Host` 使用 `$http_host` 而不是 `$host`，因为 `$host` 不含端口。

### Caddy 示例

```caddyfile
{
	servers {
		enable_full_duplex
	}
}

kiteline.example.com {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval 10ms
		transport http {
			keepalive off
		}
	}
}
```

Caddy 自动申请证书、原样转发 `Host`、用实际协议覆盖 `X-Forwarded-Proto`，并支持 WebSocket。`flush_interval` 让流式响应及时送达；`keepalive off` 使 Caddy 不复用上游连接，避免在复用连接断开时自动重发请求；`enable_full_duplex` 允许 server 在上传完成前返回响应。

示例需要 Caddy 2.7 或更高版本。Ubuntu 24.04 和 Debian 12 软件源中的 Caddy 2.6.2 不支持 `enable_full_duplex`，请从 Caddy 官方软件源安装。

### 多个入口

同一个 server 可以同时有多个入口，例如内网的 `http://192.168.1.10:8080` 和公网的 `https://kiteline.example.com`。给反向代理增加多个站点即可，server 不需要登记入口。登录范围见[初始化拥有者](#初始化拥有者)；设备只连接它绑定时使用的入口。HTTP 到 HTTPS 的重定向只对浏览器有效，设备绑定时要直接使用 `https://` 地址。

### 常见错误

反向代理配置错误时的现象（例如 `Origin mismatch`、`Invalid X-Forwarded-Proto`、终端无法连接、下载没有响应）和处理见[常见问题](reference.md#常见问题)。

## 重置初始化 token 与密码

两个恢复命令都必须在 server 停止后、使用同一个数据目录执行；server 运行时执行会报 `Lock file is already being held`。

- `setup-token`：生成新的初始化 token，替换旧的，有效期与首次打印的 token 相同。只能在设置拥有者之前使用，之后执行会报 `Already initialized`。
- `reset-password`：设置新的拥有者密码。提示 `New password:` 后输入密码，输入内容不回显，按 Enter 提交，按 Ctrl-C 取消。成功后所有浏览器的登录会话都失效，需要用新密码重新登录。设备的绑定不受影响。只能在设置拥有者之后使用，之前执行会报 `Not initialized`。

Docker（在部署目录中执行）：

```sh
docker compose stop server
docker compose run --rm --no-deps server setup-token
docker compose up -d server
```

原生：

```sh
sudo systemctl stop kiteline-server
sudo -u kiteline /opt/kiteline-server/bin/kiteline-server setup-token --data-dir /var/lib/kiteline
sudo systemctl start kiteline-server
```

重置密码时把中间命令里的 `setup-token` 换成 `reset-password`。登录页的“登录恢复”也会显示对应的命令。

## 备份与恢复

server 数据目录保存拥有者密码、设备登记和定时任务摘要。设备的绑定凭据、工作区登记和定时任务保存在各设备的 agent 数据目录中（见[文件位置](reference.md#文件位置)），需要在设备上另行备份；项目文件按你原有的方式备份。

停止 server 后备份整个数据目录，可以得到一致的副本。

Docker（在部署目录中执行）：

```sh
docker compose stop server
docker run --rm -v kiteline_server-data:/data:ro -v "$PWD":/backup ubuntu:24.04 \
  tar -czf /backup/kiteline-server-data.tar.gz -C /data .
docker compose start server
```

恢复：

```sh
docker compose stop server
docker run --rm -v kiteline_server-data:/data -v "$PWD":/backup ubuntu:24.04 \
  sh -c 'find /data -mindepth 1 -delete && tar -xzf /backup/kiteline-server-data.tar.gz -C /data'
docker compose start server
```

原生：

```sh
sudo systemctl stop kiteline-server
sudo tar -czf kiteline-server-data.tar.gz -C /var/lib/kiteline .
sudo systemctl start kiteline-server
```

恢复：

```sh
sudo systemctl stop kiteline-server
sudo find /var/lib/kiteline -mindepth 1 -delete
sudo tar -xzf kiteline-server-data.tar.gz -C /var/lib/kiteline
sudo systemctl start kiteline-server
```

恢复后，设备登记回到备份时的状态：备份之后绑定的设备无法再连接，需要[重新绑定](devices.md#重新绑定)；备份之后删除的设备会重新出现在列表中，可以在网页再次删除。

## 升级 server

先升级 server，再升级各设备的 agent。升级前建议先[备份](#备份与恢复)。停止和重启 server 不影响设备上的终端和定时任务；server 恢复后，版本相同的 agent 自动重新连接。

Docker 部署在部署目录中执行下面的命令。其中的 `curl` 用新版本覆盖 `compose.yaml`；如果你修改过它（例如改用宿主机目录挂载），改为先下载到 `compose.yaml.new`（`curl -fsSL -o compose.yaml.new …`），把修改合并进去后替换 `compose.yaml`，再执行其余命令。直接覆盖时修改会丢失，例如 server 改用命名卷 `server-data` 启动，读不到原来的数据。

```sh
KITELINE_VERSION=0.2.6  # 替换为新版本
curl -fsSLO "https://raw.githubusercontent.com/Azure99/kiteline/v$KITELINE_VERSION/deploy/compose.yaml"
sed -i 's|kiteline-server:|ghcr.io/azure99/kiteline:|; s|-${KITELINE_ARCH:-amd64}||' compose.yaml
sed -i "s/^KITELINE_VERSION=.*/KITELINE_VERSION=$KITELINE_VERSION/" .env
docker compose pull
docker compose up -d
```

原生：

```sh
KITELINE_VERSION=0.2.6  # 替换为新版本
KITELINE_ARCH=amd64     # ARM64 主机改为 arm64
name="kiteline-server-$KITELINE_VERSION-linux-$KITELINE_ARCH"
curl -fLO "https://github.com/Azure99/kiteline/releases/download/v$KITELINE_VERSION/$name.tar.gz"
curl -fLO "https://github.com/Azure99/kiteline/releases/download/v$KITELINE_VERSION/$name.tar.gz.sha256"
sha256sum -c "$name.tar.gz.sha256"
sudo systemctl stop kiteline-server
sudo mv /opt/kiteline-server /opt/kiteline-server.previous
sudo mkdir /opt/kiteline-server
sudo tar -xzf "$name.tar.gz" --no-same-owner --strip-components=1 -C /opt/kiteline-server
sudo systemctl start kiteline-server
curl -fsS http://127.0.0.1:8080/healthz
```

`healthz` 显示新版本后，删除旧程序目录：`sudo rm -rf /opt/kiteline-server.previous`。新版本 tag 中的 `deploy/systemd/kiteline-server.service` 有变化时，同时替换 unit 并执行 `sudo systemctl daemon-reload`。

server 升级后刷新浏览器。agent 版本与 server 不同的设备显示“版本不匹配”，在升级 agent 之前无法连接，设备上的终端和定时任务继续运行。然后按[升级 agent](devices.md#升级-agent) 升级各设备。
