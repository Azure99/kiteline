# 接入设备：高级场景

[English](devices-advanced.en.md)

本文收录接入设备时少数情况才需要的做法：手工下载安装（包括不经系统安装直接运行）、通过代理或私有 CA 连接 server、在容器中运行 agent。常规接入流程见[接入设备](devices.md)。

## 手工安装

手工下载、校验并解包完整发布包后，可以以项目用户直接前台运行，也可以由管理员安装到系统目录。两种方式都使用网页上的[仅绑定命令](devices.md#仅绑定命令)。

直接运行时，数据目录和运行目录使用 [agent 环境变量](reference.md#agent-环境变量)所列的默认值。需要自定义时，在执行 `check`、绑定和 `run` 的同一 Shell 中设置 `KITELINE_AGENT_HOME` 和 `KITELINE_AGENT_RUN_DIR`。数据目录和运行目录都放在程序目录外，换包时沿用原来的目录设置。

agent 版本必须与 server 版本相同，否则设备无法连接。用 `curl -fsS https://YOUR_SERVER/healthz` 查看 server 版本。发布包可以从 server 下载（`https://YOUR_SERVER/downloads/agent/<版本>/<文件名>`，不需要登录），也可以从 [GitHub Releases](https://github.com/Azure99/kiteline/releases) 下载。每个发布包都有同名的 `.sha256` 校验文件。

### Linux 和 macOS

以项目用户在自己拥有的新目录中执行：

```sh
KITELINE_SERVER=https://YOUR_SERVER  # 替换为工作台地址
KITELINE_VERSION=X.Y.Z               # 替换为 server 的版本
KITELINE_PLATFORM=linux              # macOS 改为 macos
KITELINE_ARCH=amd64                  # ARM64 和 Apple 芯片改为 arm64
name="kiteline-agent-$KITELINE_VERSION-$KITELINE_PLATFORM-$KITELINE_ARCH"
curl -fLO "$KITELINE_SERVER/downloads/agent/$KITELINE_VERSION/$name.tar.gz"
curl -fLO "$KITELINE_SERVER/downloads/agent/$KITELINE_VERSION/$name.tar.gz.sha256"
sha256sum -c "$name.tar.gz.sha256"            # Linux
# shasum -a 256 -c "$name.tar.gz.sha256"      # macOS 用这一行代替上一行
tar -xpzf "$name.tar.gz" --no-same-owner
"./$name/bin/kiteline-agent" check
```

随包的 tmux、`flock` 等程序没有经过 Apple 公证。macOS 上用浏览器下载的发布包带有隔离属性 `com.apple.quarantine`，运行随包程序时可能被拒绝；用上面的 curl 命令下载的文件不带这个属性。已经用浏览器下载时，核对 SHA-256 后对解包目录执行 `xattr -dr com.apple.quarantine "./$name"`，再运行 `check`；已经安装的程序目录执行 `sudo xattr -dr com.apple.quarantine /opt/kiteline-agent`。

无需系统安装时，展开网页上的[仅绑定命令](devices.md#仅绑定命令)，把其中两处 `kiteline-agent` 改成 `"./$name/bin/kiteline-agent"`，在当前 Shell 中执行；绑定后执行：

```sh
"./$name/bin/kiteline-agent" run
```

保留整个解包目录，后续命令也使用这个入口。

需要安装到系统目录时，执行：

```sh
sudo "./$name/bin/kiteline-agent" install --user "$(id -un)"
```

由管理员替其他账户安装时，管理员执行这条命令并把 `"$(id -un)"` 换成项目用户名，`check` 仍由项目用户执行。

`install` 在 `/etc/kiteline-agent.env` 中记录 agent 数据目录，默认为项目用户的 `~/.local/share/kiteline-agent`，运行目录默认为其中的 `run`。需要使用其他目录时，在绑定前修改这个文件中的 `KITELINE_AGENT_HOME`，需要时添加 `KITELINE_AGENT_RUN_DIR`，格式见[目录配置文件](reference.md#目录配置文件)。运行目录的路径长度有上限（见[限额](reference.md#限额)）。

然后以项目用户执行网页上的[仅绑定命令](devices.md#仅绑定命令)，再执行 `kiteline-agent run`。

同一用户重复安装同一版本时，`install` 提示已经安装，不改动程序、绑定和任务；已安装其他版本时，`install` 拒绝执行，改用[升级 agent](devices.md#升级-agent)。

### Windows

在项目用户的普通 PowerShell 窗口中下载、校验并检查：

```powershell
$server = 'https://YOUR_SERVER'  # 替换为工作台地址
$version = 'X.Y.Z'               # 替换为 server 的版本
$package = "kiteline-agent-$version-windows-amd64"
Set-Location 'C:\Users\PROJECT_USER\AGENT_PACKAGE_DIR'  # 替换为自己创建的新目录
Invoke-WebRequest -UseBasicParsing "$server/downloads/agent/$version/$package.zip" -OutFile "$package.zip"
Invoke-WebRequest -UseBasicParsing "$server/downloads/agent/$version/$package.zip.sha256" -OutFile "$package.zip.sha256"
$expected = (Get-Content "$package.zip.sha256" -Raw).Trim().Split(' ')[0]
if ((Get-FileHash "$package.zip" -Algorithm SHA256).Hash -ine $expected) { throw 'Checksum mismatch' }
Expand-Archive -LiteralPath "$package.zip" -DestinationPath .
& (Join-Path $PSHOME $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'powershell.exe' } else { 'pwsh.exe' })) -NoProfile -ExecutionPolicy Bypass -File ".\$package\bin\kiteline-agent.ps1" check
```

无需系统安装时，展开网页上的[仅绑定命令](devices.md#仅绑定命令)，把其中两处 `-File` 后的脚本路径改成 `".\$package\bin\kiteline-agent.ps1"`，在当前窗口执行；绑定后执行：

```powershell
& (Join-Path $PSHOME $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'powershell.exe' } else { 'pwsh.exe' })) -NoProfile -ExecutionPolicy Bypass -File ".\$package\bin\kiteline-agent.ps1" run
```

保留整个解包目录，后续命令也使用这个入口。

需要安装到系统目录时，先在当前窗口执行 `whoami`，记下项目用户的账户名，例如 `desktop-1234\alice`。然后以管理员身份打开 PowerShell（右键“以管理员身份运行”），进入同一个下载目录安装，`--user` 填这个账户名：

```powershell
# 把 X.Y.Z 换成上一步下载的版本
Set-Location 'C:\Users\PROJECT_USER\AGENT_PACKAGE_DIR'
& (Join-Path $PSHOME $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'powershell.exe' } else { 'pwsh.exe' })) -NoProfile -ExecutionPolicy Bypass -File '.\kiteline-agent-X.Y.Z-windows-amd64\bin\kiteline-agent.ps1' install --user 'COMPUTER\PROJECT_USER'
```

agent 数据目录默认为项目用户的 `%LOCALAPPDATA%\kiteline-agent`，运行目录默认为其中的 `run`。安装时可以用 `--data-dir` 和 `--run-dir` 指定其他绝对路径；安装程序无法确定项目用户的 LocalAppData 时（例如该用户当前没有登录），必须显式指定 `--data-dir`。

安装完成后关闭管理员窗口，从开始菜单新开项目用户的普通 PowerShell 窗口，执行网页上的[仅绑定命令](devices.md#仅绑定命令)，再执行 `kiteline-agent run`。

### 恢复 Windows 仓库所有者

曾提权运行 agent 后，本人仓库的根目录可能属于 `Administrators`。恢复普通权限后，即使文件仍能读写，Git 也可能报 `dubious ownership`。仅当这是你本人的仓库、根目录 owner 确为 `Administrators`，且本人已拥有该目录的 `FullControl` 权限时，在本人的普通 PowerShell 中进入该仓库根目录，恢复根目录 owner：

```powershell
icacls . /setowner ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
```

这不会递归更改子文件 owner，也不新增访问权限或 Git 信任例外。

## 出站代理与证书

agent 访问 server 的流量（绑定请求，以及控制和数据 WebSocket 连接）按环境变量使用代理。agent 访问设备本机开发服务时总是直连。终端中启动的程序继承 agent 的环境变量，是否使用代理由程序自己决定。

| 变量                         | 作用                                  |
| ---------------------------- | ------------------------------------- |
| `https_proxy`、`HTTPS_PROXY` | server 地址是 `https://` 时使用的代理 |
| `http_proxy`、`HTTP_PROXY`   | server 地址是 `http://` 时使用的代理  |
| `all_proxy`、`ALL_PROXY`     | 以上变量都未设置时使用的代理          |
| `no_proxy`、`NO_PROXY`       | 直连的主机列表                        |

- Linux 和 macOS 上，小写变量优先于大写变量：残留的 `https_proxy` 会覆盖你新设置的 `HTTPS_PROXY`。Windows 的环境变量名不区分大小写。
- 代理地址必须以 `http://` 或 `https://` 开头，其他协议（例如 `socks5://`）会报 `Agent environment proxy must use HTTP or HTTPS`。省略协议时，agent 按 server 地址的协议补全，例如 `HTTPS_PROXY=proxy.example.com:3128` 会被当作 `https://proxy.example.com:3128`，通常连接失败，所以始终写明 `http://`。
- 代理必须允许 CONNECT 到 server 的主机和端口；server 地址是 `http://` 时也使用 CONNECT。有些代理默认只允许 CONNECT 到 443 端口，server 使用其他端口时要调整代理设置。
- `no_proxy` 用逗号或空格分隔；`*` 表示全部直连；以 `.` 或 `*` 开头的项按后缀匹配（`.example.com` 匹配 `kiteline.example.com`）；可以带 `:端口`；不支持 CIDR 网段。server 地址使用 `localhost`、`127.0.0.1` 或 `[::1]` 时也按代理变量连接；需要直连时，把对应主机（IPv6 项保留方括号，例如 `[::1]`）加入 `no_proxy`，否则绑定、控制和数据连接也会经过代理。

前台运行时，在执行接入命令或 `kiteline-agent run` 的同一个 Shell 中设置变量：

```sh
export HTTPS_PROXY=http://proxy.example.com:3128
export http_proxy=http://proxy.example.com:3128
export NO_PROXY=localhost,127.0.0.1,.internal.example.com
kiteline-agent run
```

```powershell
$env:HTTPS_PROXY = 'http://proxy.example.com:3128'
kiteline-agent run
```

接入和升级命令中的下载由 curl（Windows 上由 PowerShell）完成。curl 只识别小写的 `http_proxy`，所以 HTTP 入口要设置小写变量，上例两种都设置了。Windows 上 agent 只读取环境变量，不使用系统的代理设置。

作为服务运行时，在服务配置中设置这些变量（见[后台运行](devices.md#后台运行)），然后重启服务；重启会结束当前的终端会话和定时任务运行。

server 使用私有 CA 签发的证书时：

- Linux 和 macOS：把 CA 证书加入系统信任库，供接入命令中的 curl 使用；再用 `NODE_EXTRA_CA_CERTS` 指向该 CA 证书的 PEM 文件，供 agent 使用。前台运行时在 Shell 中 `export NODE_EXTRA_CA_CERTS=/path/to/ca.pem`，作为服务运行时写入服务配置。
- Windows：`NODE_EXTRA_CA_CERTS` 对 agent 自身的连接不起作用。Windows 设备连接的入口要使用不依赖该变量就能被信任的证书，例如公共 CA 签发的证书。

## 在容器中运行

agent 可以运行在你自己准备的 Linux 容器中，此时工作区、终端和开发服务都在容器内。容器需要 `kiteline-agent check` 检查的工具（Git、SSH、`flock`、`infocmp`、UTF-8 locale）和项目使用的工具。agent 的安装（`/opt/kiteline-agent`、`/usr/local/bin/kiteline-agent`、`/etc/kiteline-agent.*`）位于容器文件系统中，重建容器后会丢失，所以在构建镜像时以 root 安装，容器中不需要 sudo；agent 数据目录和项目目录放在卷或挂载目录中，重建容器后绑定、工作区和定时任务仍在。容器中没有 systemd，让 `kiteline-agent run` 作为容器的主进程运行。

下面的示例在构建镜像时从 server 下载并安装 agent。在一个空目录中创建 `Dockerfile`：

```dockerfile
FROM debian:12
ARG KITELINE_SERVER
ARG KITELINE_VERSION
ENV LANG=C.UTF-8
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash dev
RUN cd /var/tmp \
    && name="kiteline-agent-$KITELINE_VERSION-linux-$(dpkg --print-architecture)" \
    && curl -fsSLO "$KITELINE_SERVER/downloads/agent/$KITELINE_VERSION/$name.tar.gz" \
    && curl -fsSLO "$KITELINE_SERVER/downloads/agent/$KITELINE_VERSION/$name.tar.gz.sha256" \
    && sha256sum -c "$name.tar.gz.sha256" \
    && tar -xpzf "$name.tar.gz" --no-same-owner \
    && "./$name/bin/kiteline-agent" install --user dev \
    && rm -rf "$name" "$name.tar.gz" "$name.tar.gz.sha256"
USER dev
WORKDIR /home/dev
RUN mkdir -p /home/dev/.local/share/kiteline-agent /home/dev/projects
CMD ["/usr/local/bin/kiteline-agent", "run"]
```

和 `compose.yaml`：

```yaml
services:
  agent:
    hostname: dev-container
    build:
      context: .
      args:
        KITELINE_SERVER: https://YOUR_SERVER
        KITELINE_VERSION: "X.Y.Z"
    init: true
    restart: unless-stopped
    stop_grace_period: 45s
    volumes:
      - agent-data:/home/dev/.local/share/kiteline-agent
      - ./projects:/home/dev/projects
volumes:
  agent-data:
```

`KITELINE_VERSION` 必须与 server 版本相同。`./projects` 是宿主机上的项目目录，属主应与容器中的 `dev` 用户一致（UID 1000）。设备名取绑定时的主机名，`hostname` 固定容器的主机名，否则设备名是随机的容器 ID；绑定后也可以在“设备操作”菜单中点击“重命名”。`init: true` 让 init 进程回收子进程，`stop_grace_period` 给 agent 留出结束终端会话和定时任务运行的时间。构建镜像并绑定一次：

```sh
mkdir -p projects
docker compose build
docker compose run --rm agent sh
```

在容器的 Shell 中粘贴网页上的[仅绑定命令](devices.md#仅绑定命令)执行，然后 `exit`。绑定凭据保存在 `agent-data` 卷中。启动 agent：

```sh
docker compose up -d
docker compose logs -f agent
```

在网页添加工作区时选择 `/home/dev/projects` 下的目录。

升级时把 `KITELINE_VERSION` 改为新版本，执行 `docker compose build` 和 `docker compose up -d`；绑定保留在卷中，不需要重新绑定。停止或重建容器会结束 agent 管理的终端会话和定时任务运行，与停止前台 agent 相同。

- Git 认证：把项目用户的 SSH 密钥、`config` 和 `known_hosts` 挂载到 `/home/dev/.ssh`，或挂载一个 SSH agent socket 并设置 `SSH_AUTH_SOCK`；`.gitconfig` 引用的 credential helper 也要安装在镜像中。只读挂载的 `known_hosts` 无法记录新主机，要事先写入。
- linked worktree：把主仓库和各个工作树按宿主机上相同的绝对路径挂载，否则 `.git` 文件中记录的路径在容器中不存在。
- 开发服务：容器内启动的服务可以直接通过工作台访问。另一个容器中的服务需要与 agent 共享网络命名空间（Compose 中设置 `network_mode: "service:agent"`）；宿主机的 `localhost` 和同一网桥上的其他容器不是 agent 的 `localhost`。
