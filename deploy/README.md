# 安装与运行

设备端提供Linux amd64/arm64、Windows amd64及macOS amd64/arm64包，server提供Linux amd64/arm64包及镜像。系统与工具要求见[运行基线](#平台要求)，源码开发见[仓库入口](../README.md)。

## 生成交付物

使用[package.json](../package.json)固定的Node和pnpm。Linux构建机需要Docker BuildKit、binutils的readelf、libarchive-tools的bsdtar，以及Windows组包所需zip；可通过binfmt/QEMU执行另一架构的native构建。基础镜像、Node版本、rg和Ubuntu证书包身份集中在[release.json](release.json)，Linux静态Node归档固定于[node-static.json](node-static.json)。用户运行发布包无需npm或编译器。

只构建Linux amd64及对应server的命令：

```sh
pnpm install --frozen-lockfile
pnpm package agent amd64
pnpm package server amd64 --agent-target=linux-amd64
pnpm images amd64
```

`--agent-target`选择server携带的agent，可用逗号分隔多个目标；省略时携带全部五个目标。Windows先按[固定组件构建](windows-components.md)生成并验证组件；其ZIP不含符号链接，目标机无需Developer Mode。macOS构建步骤见下文。

包及对应`.sha256`位于`dist/releases/`；产品版本来自[version.json](../shared/src/version.json)，镜像名为`kiteline-server:<版本>-<amd64|arm64>`。跨机器可用`docker save/load`搬运镜像。构建从干净commit开始，结束时再次核HEAD和工作区/index；清单记录sourceCommit、sourceDirty=false、平台及组件身份。组装server和构建镜像时核对当前来源、版本和目标，来源不一致须重建相应包；原生组件仍按实际输入闭包复用。

`package agent amd64`和`package agent arm64`下载对应静态Node并构建/复用native；也可单独用`node scripts/build-agent-static.mjs amd64`或`arm64`输出到`dist/agent-static-<架构>/`，省略架构时使用amd64。Node归档及SHA固定于[node-static.json](node-static.json)；Node版本与配方修订变更时，先在[node-static-builds](https://github.com/Azure99/node-static-builds)构建验证新组件，再更新本仓引用。native来源与SHA见[agent-static.json](agent-static.json)，工具链包名见[agent-static-packages.txt](agent-static-packages.txt)，实际版本随输出记录。下载缓存位于`/var/tmp/kiteline-release-cache`并核验SHA，native编译沿Docker缓存复用。产物记录及静态边界见[运行基线](#平台要求)。

macOS原生组件使用[固定输入](agent-macos.json)及对应架构的macOS构建环境，需要 Command Line Tools 和 SDK，部署目标 14.0。分别对amd64、arm64执行以下步骤：先在源码目录准备输入，再将完整输入目录传至相应构建机；使用固定Node运行其中同一脚本，输出目录须不存在：

```sh
kiteline_arch=arm64 # Intel构建机使用amd64。
node scripts/build-macos-components.mjs prepare "$kiteline_arch" "/var/tmp/kiteline-mac-inputs-$kiteline_arch"
# 在匹配架构的macOS构建环境中，kiteline_arch设置同上：
node "/var/tmp/kiteline-mac-inputs-$kiteline_arch/scripts/build-macos-components.mjs" build "$kiteline_arch" \
  "/var/tmp/kiteline-mac-inputs-$kiteline_arch" "/var/tmp/kiteline-mac-components-$kiteline_arch"
# 将完整组件带回源码侧，核对当前输入与实际文件：
node scripts/build-macos-components.mjs verify "$kiteline_arch" "/var/tmp/kiteline-mac-components-$kiteline_arch"
# 在macOS构建源码目录安装开发依赖后组包：
pnpm package agent "macos-$kiteline_arch" --macos-components="/var/tmp/kiteline-mac-components-$kiteline_arch"
```

macOS组包使用固定Node/pnpm、Git及系统tar，组件输入和文件摘要在组包入口再次核验。包名中的amd64对应Intel x86_64，arm64对应Apple Silicon。

完整交付从相同源码构建五个agent。将macOS两架构生成的包及`.sha256`放入Linux源码侧`dist/releases/`，然后依次组装两个server和镜像：

```sh
pnpm package agent amd64
pnpm package agent arm64
pnpm package agent windows-amd64 --windows-components=/var/tmp/kiteline-win-components
# 确认同源macOS两架构包及.sha256已放入dist/releases/。
pnpm package server amd64
pnpm package server arm64
pnpm images amd64
pnpm images arm64
```

各包根目录包含项目LICENSE；第三方许可位置见[随包材料](#随包材料)。构建后从各实际产物核对内容、来源、启动及受影响安装升级流程，区分原生、模拟和最低系统的验证结果。

## Server 部署

镜像按前节构建或导入后，启动 server。默认只发布宿主 `127.0.0.1:8080`，管理数据保存在 `server-data` 卷；不占用 80/443、不管理证书。

```sh
export KITELINE_VERSION=$(node -p 'require("./shared/src/version.json").version')
export KITELINE_HTTP_PORT=8443
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml logs server
```

打开 http://localhost:8443。上述版本读取命令在源码根目录执行；仅导入镜像时，直接将 `KITELINE_VERSION` 设置为导入的发布版本。局域网访问时在启动前另设 `KITELINE_HTTP_BIND=0.0.0.0`，然后打开 `http://主机IP:8443`；端口可按需更改。

HTTP直连可正常使用；建议有反代时使用HTTPS。使用HTTPS反代时，设置 `KITELINE_TRUST_PROXY_PROTO=1` 后运行同一 Compose 命令。反代将 HTTPS 入口转到发布的 HTTP 端口，保留原 Host（含端口）、覆盖 `X-Forwarded-Proto`，普通请求与 WebSocket Upgrade 都要处理。反代必须允许 WebSocket、SSE、流式响应与上传，不缓冲流式正文、不自动重放写请求，并为长连接设置合适期限。同一实例可同时使用多个域名和 HTTP 地址，各入口分别登录；不配置单一公开 URL。

反代在另一主机/容器时，可设置 `KITELINE_HTTP_BIND` 为可达的宿主地址，或将反代接入 Compose 网络、使用 `http://server:8080`。另一容器的 `127.0.0.1` 不是宿主机。ARM64 镜像另设 `KITELINE_ARCH=arm64`。

从所选入口打开网页，输入首次日志中的 setup token 并设置拥有者密码。需要新 token 时，先停止 server，在同一卷执行命令后重新启动：

```sh
docker compose -f deploy/compose.yaml stop server
docker compose -f deploy/compose.yaml run --rm --no-deps server setup-token
docker compose -f deploy/compose.yaml up -d server
```

已初始化后的密码恢复将中间命令换成 `reset-password`，按提示输入新密码（输入不回显，Enter提交，Ctrl+C取消）。使用原卷；原登录会话会失效。备份可停止 server 后备份整个 `server-data` 卷，agent 登记和凭据单独备份，项目文件沿原方式备份。

原生 server：校验并解压完整 server 包到 `/opt/kiteline-server`，创建专用 `kiteline` 用户及归其所有的 `/var/lib/kiteline`，将 [unit](kiteline-server.service) 安装为 `/etc/systemd/system/kiteline-server.service`。创建 `/etc/kiteline-server.env`，默认可只写 `KITELINE_TRUST_PROXY_PROTO=0`；接 HTTPS 反代时改为1，需要局域网直连或自定义端口时设置 `KITELINE_LISTEN_ADDR=0.0.0.0:8443`。执行 `systemctl daemon-reload`、`systemctl enable --now kiteline-server`，查看 `journalctl -u kiteline-server` 取得初始化 token。

未初始化而 token 过期或遗失时，以同一专用用户和原管理目录重新生成：

```sh
systemctl stop kiteline-server
sudo -u kiteline /opt/kiteline-server/bin/kiteline-server setup-token --data-dir /var/lib/kiteline
systemctl start kiteline-server
```

已初始化后的密码恢复，将中间命令的 `setup-token` 换为 `reset-password`，按上述不回显方式输入新密码；原登录会话会失效。两种恢复均使用原管理目录。

## 原生 Agent

在网页设备列表点击“绑定设备”，明确选择Linux、Windows或macOS并复制接入命令，在目标机器以日常项目用户执行。Windows先准备PowerShell 7及原生Git，rg和私有终端runtime随包；命令在PowerShell 7中执行，不在cmd或WSL中运行。程序安装需要系统提升，绑定与运行仍属于项目用户。默认前台run，Ctrl-C停止；以后执行公开launcher的`run`，无需重新绑定。项目没有系统服务管理或后台模式开关。

网页生成当前访问地址的接入命令；Linux/macOS用connect.sh并传所选平台，Windows用connect.ps1，完整下载脚本后执行。HTTPS不降级，HTTP可用HTTP/HTTPS；绑定码保留为Shell参数，不进入下载URL。目标设备必须能访问该地址，不能从手机的localhost地址给另一台机器绑定。不改全局PowerShell执行策略，企业策略限制时按实际错误处理。失败诊断与POSIX管道行为见[设备安装说明](#原生-agent)。

Linux两架构目标机均需要 curl、Git 2.23.0+、SSH、flock（util-linux）、有效的 UTF-8 locale 和项目使用的 Shell/CLI，rg已随包提供。缺项时命令停止并给出安装建议，不自动修改系统依赖。下面的Linux基础依赖命令以 root 执行，普通用户加 sudo：

```sh
# Ubuntu 24.04 / Debian 12
apt-get update
apt-get install -y curl ca-certificates tar gzip coreutils git openssh-client ncurses-bin locales util-linux
# Alpine 3.23
apk add curl ca-certificates tar gzip coreutils musl-utils git openssh-client ncurses musl-locales util-linux
# CentOS 7.9：另外提供 Git 2.23.0+，默认仓库版本不足。
yum install -y curl ca-certificates tar gzip coreutils openssh-clients ncurses glibc-common util-linux
```

CentOS使用SCL Git时，在启动agent的Shell或外部管理器中加载对应`enable`脚本，例如`source /opt/rh/rh-git227/enable`，同时取得PATH和所需库环境。

Linux用`locale -a`确认已安装的UTF-8 locale，`locale charmap`应输出UTF-8。例如已安装`en_US.UTF-8`时，可在启动Shell中执行`export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`。LC_ALL优先于LC_CTYPE和LANG。后台管理器需配置同样环境；应用目录配置文件只解析目录项。

Node、recorder、固定 tmux、terminfo 和文件 helper 已随包提供，无需 npm/编译器。安装失败后先处理具体原因，再执行命令；绑定码已过期则在网页重新生成。程序已安装但绑定失败时不重复替换安装；已有身份或不同版本会停止，不自动重绑/升级。若已登记但未在线，先核对本地凭据和 `kiteline-agent run` 输出；凭据丢失在网页删除残留身份并重新生成绑定码，不能把未知结果当成普通过期重试。

也可手工取得完整包及 `.sha256`，校验、解压、安装，再用网页“已安装，仅绑定”命令绑定：

```sh
# KITELINE_VERSION 设为下载的版本；ARM64 将 amd64 换成 arm64。
kiteline_package="kiteline-agent-${KITELINE_VERSION}-linux-amd64"
sha256sum -c "$kiteline_package.tar.gz.sha256"
tar -xpzf "$kiteline_package.tar.gz" --no-same-owner
"./$kiteline_package/bin/kiteline-agent" check
sudo "./$kiteline_package/bin/kiteline-agent" install --user YOUR_USER
# 执行网页提供的绑定命令后：
kiteline-agent run
```

macOS手工取得匹配架构的完整包及校验文件后，在项目用户终端执行；先准备Git 2.23+、SSH、有效UTF-8 locale及项目Shell。Node、rg、tmux和flock随包，无需Homebrew。提升只用于程序安装，运行和绑定仍由项目用户执行：

```sh
# Apple Silicon使用arm64，Intel将arm64换成amd64。
kiteline_package="kiteline-agent-${KITELINE_VERSION}-macos-arm64"
shasum -a 256 -c "$kiteline_package.tar.gz.sha256"
tar -xpzf "$kiteline_package.tar.gz" --no-same-owner
"./$kiteline_package/bin/kiteline-agent" check
sudo "./$kiteline_package/bin/kiteline-agent" install --user "$(id -un)"
kiteline-agent bind --server https://YOUR_SERVER
kiteline-agent run
# 先停止所有程序使用者及外部自动重启，再维护：
sudo kiteline-agent upgrade --archive "/path/to/$kiteline_package.tar.gz"
sudo kiteline-agent uninstall
```

升级归档与`.sha256`放在一起。Mac沿Linux的程序/目录配置布局和事务规则；TCC、quarantine或Gatekeeper提示由用户按系统要求处理，见[macOS设备端](#平台要求)。

Windows手工安装在PowerShell 7中校验ZIP后解压；`$version`设为下载的实际版本：

```powershell
$package = "kiteline-agent-$version-windows-amd64"
$expected = (Get-Content "$package.zip.sha256" -Raw).Trim().Split(' ')[0]
if ((Get-FileHash "$package.zip" -Algorithm SHA256).Hash -ine $expected) { throw 'Checksum mismatch' }
Expand-Archive -LiteralPath "$package.zip" -DestinationPath .
& ".\$package\bin\kiteline-agent.ps1" check
# 在提升的PowerShell中安装，明确原项目账户，不使用另一个管理员的HOME：
& ".\$package\bin\kiteline-agent.ps1" install --user 'MACHINE\PROJECT_USER'
# 回到项目用户PowerShell，执行网页绑定命令后：
& "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" run
```

程序安装到Program Files，公开PS入口与安装记录在ProgramData\kiteline-agent。目标用户须有已初始化profile；无法确认其LocalAppData时安装明确要求`--data-dir`，可另给短`--run-dir`。两者须绝对路径，状态由项目用户bind/run创建。若执行策略禁止脚本，可在单次`pwsh -NoProfile -ExecutionPolicy Bypass -File <脚本> ...`调用使用进程级策略，组织策略仍须由管理员协调；不修改全局策略。手工解包使用已校验的完整包，不直接运行树内Node作为正式入口。

Windows更新和卸载在提升的独立PowerShell中执行，先由用户正常停止所有使用者和外部重启策略：

```powershell
& "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" upgrade --archive "C:\Downloads\kiteline-agent-$version-windows-amd64.zip"
& "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" uninstall
```

升级的ZIP与`.sha256`放在一起；确认后不自动启动。默认卸载保留状态；`--purge-state`范围和稳定锁规则见[卸载规则](#原生-agent)。同身份同版本安装重跑按版本识别，不替树或重绑。

设备上线后，先在网页为该设备添加 workspace，选择项目目录；再获取 `WORKSPACE_ID` 创建终端：

```sh
kiteline-agent workspace list
kiteline-agent terminal new --workspace WORKSPACE_ID
kiteline-agent attach SESSION_ID
```

Linux/macOS CLI与运行进程共用`/etc/kiteline-agent.env`的目录项。KITELINE_AGENT_HOME和KITELINE_AGENT_RUN_DIR使用单行双引号绝对路径，不使用转义或尾部注释；默认状态在项目用户的`~/.local/share/kiteline-agent`，socket在其run目录。该文件由应用仅解析目录项，不自动加载PATH、SSH_AUTH_SOCK、LANG或代理。Windows默认状态在目标用户LocalAppData；自定义目录须让后台run与本机CLI一致。Web复制的接续命令带实际launcher与`--run-dir`；需要手工指定时使用`kiteline-agent attach SESSION_ID --run-dir '/实际运行目录'`，见[接续规则](#原生-agent)。doctor检查实际agent环境，认证以真实Git调用为准。

常驻、自启动、运行身份、凭据与维护停启由用户配置外部管理器。Linux可人工编辑[systemd示例](kiteline-agent.service)，Windows使用自行安装的WinSW 2.12及[XML示例](kiteline-agent.xml)，将wrapper、XML和日志放程序树外。用户自行安装管理器并在Windows服务属性中设置同一项目账户及凭据，不能使用默认LocalSystem；修改示例的实际PowerShell/Git、profile、data/run目录，保留console、parent-first及足够的停止宽限。项目不生成、安装或删除管理器配置，不保存密码。先以前台run/check/doctor验证项目用户环境，再自行接线；停止须给真实agent足够收尾时间。正确后台部署后用户注销任务继续，重登可接回；直接在交互会话运行不提供这项保证。切换部署方式先正常停止，身份/workspace/任务数据保留，但旧运行任务不迁移。

WinSW 2.12的`stop`只提交停止请求；维护前使用wrapper的`stopwait`，或自行等待服务实际停止，再确认没有仍使用安装的本机attach或其他实例。停止超时不能当作正常收尾；升级仍会独立检查占用。

macOS可将随包[LaunchDaemon示例](kiteline-agent.plist)复制到树外，按实际账户修改`YOUR_PROJECT_USER`及HOME、工作/数据/运行目录。先完成前台绑定和doctor，再正常停止前台实例；目录须与`/etc/kiteline-agent.env`一致。示例开机加载但不自动重启，日志位于项目用户状态目录：

```sh
sudo cp /opt/kiteline-agent/deploy/kiteline-agent.plist /Library/LaunchDaemons/com.kiteline.agent.plist
sudo -e /Library/LaunchDaemons/com.kiteline.agent.plist
sudo chown root:wheel /Library/LaunchDaemons/com.kiteline.agent.plist
sudo chmod 644 /Library/LaunchDaemons/com.kiteline.agent.plist
plutil -lint /Library/LaunchDaemons/com.kiteline.agent.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.kiteline.agent.plist
kiteline-agent doctor
# 维护前停止，由部署者确认实际进程和全部attach结束：
sudo launchctl bootout system /Library/LaunchDaemons/com.kiteline.agent.plist
```

plist不随程序升级替换或卸载删除；维护后由用户再次bootstrap。

```sh
kiteline-agent doctor
# 先由用户停止agent及外部管理器自动重启，再执行：
sudo kiteline-agent upgrade --archive "/path/to/kiteline-agent-${KITELINE_VERSION}-linux-amd64.tar.gz"
sudo kiteline-agent uninstall
```

更新server后刷新网页；设备版本不匹配时，在设备详情选“升级agent”，明确目标平台后复制到独立终端执行。命令从当前入口下载配套包及校验，无需重绑，不改变保存的连接地址。所有安装使用者须先停止，包括其他dataDir实例和本机attach；占用时明确拒绝，不由项目停服务。成功后仍停止，由用户run或外部管理器启动。失败只尝试回退程序树，不恢复服务状态。卸载及显式purge范围沿上述规则。

### 定时任务

`kiteline-agent schedule --help`及各子命令`--help`提供完整参数与示例，agent未运行时也可阅读。实际管理需要本机agent运行；执行与核查规则见`kiteline-agent schedule --help`。

### Agent 出站代理

绑定及控制/数据 WS/WSS 共用环境代理。前台 `bind`/`run` 使用当前 Shell 的环境，例如：

```sh
export HTTPS_PROXY=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1,.internal.example
kiteline-agent run
```

HTTP/WS使用HTTP代理变量，HTTPS/WSS使用HTTPS代理变量；上例HTTP选小写http_proxy，也供curl下载使用。后台通过用户所选管理器注入这些环境，在用户协调的维护窗口重启生效；只在执行管理命令的Shell中export不会改变后台环境。应用目录配置文件不自动加载代理，停止会结束终端及在途定时运行。

设备本地 HTTP 服务始终直连。新 Shell/AI CLI 继承 agent 的环境，但程序是否使用代理由自身决定；现有任务不会自动更新。同名非空小写变量优先；未配置协议代理时回退 ALL_PROXY，HTTPS 不回退 HTTP_PROXY。NO_PROXY 指定直连目标，仅支持 HTTP(S) 代理。

### 运行与维护补充

Linux/macOS 的 Unix socket 完整路径限 103 字节。显式使用 `/run` 等易失运行目录时，启动前及系统重启后需准备属于运行用户的可写目录。

短接入命令的外层 curl 失败时，POSIX 管道退出状态未必非零；以实际绑定和设备在线状态确认完成。

开启 `KITELINE_TRUST_PROXY_PROTO` 后，只将 HTTP 端口交给可信客户端或反代；环境代理须允许 CONNECT，包括目标为 HTTP 的连接。

定时任务停机错过不补跑，暂停仅停止后续调度，不停止在途运行。异常退出后的待核查结果需明确处理，历史为有限留存；实际参数见 `kiteline-agent schedule --help`。

普通卸载保留状态。显式 `--purge-state` 只删除应用 JSON 和 tasks，不删除状态根、workspace、项目文件或外部管理器配置；稳定锁及未删除配置按命令输出处理。

LaunchDaemon 停止宽限为 45 秒；维护前先 bootout，再确认 agent 和所有 attach 已退出。运行与认证使用项目用户的身份和凭据。

## 自行准备的容器

先创建自己的 Linux 容器并准备上述基础依赖、项目工具和挂载，再在容器内执行同一网页前台命令。没有 systemd 不影响前台运行，root 容器也可使用；容器的常驻和重建由你自行管理，工作台不提供容器创建入口。

项目目录与 agent 状态要持久化，运行用户的 UID/GID、HOME 与挂载权限一致。在网页选择容器内项目路径；本机接续用 `docker exec -it CONTAINER kiteline-agent attach SESSION_ID`，保持同一用户及运行目录。容器停止会结束任务，重建时须保留安装或重新安装；不要删除身份卷后误当原设备接续。

SSH 挂载该用户的 key、config、known_hosts，或可达的 SSH agent socket 并设置 SSH_AUTH_SOCK。`.gitconfig` 引用的 credential helper 也须在容器安装；只读 known_hosts 不会自动记录新主机。先在工作台终端验证实际认证，再使用 Git 界面同步。

linked worktree 同时挂载工作目录、gitDir 和 commonDir；`.git` 指向宿主绝对路径时保持相关目录的同一绝对路径，否则 Git 元数据不可达。

### 开发服务

同容器终端启动的服务可直接从端口入口访问，无需发布宿主端口。独立服务容器可使用 `network_mode: service:agent` 明确共享网络；普通 bridge 的其他容器和宿主 localhost 不属于 agent 的 localhost。原生 agent 则能访问已发布到宿主本地端口的容器服务。

普通路径代理剥离前缀。Vite 使用“保留路径”，将 base 设置为复制地址中的 `/absproxy/<deviceId>/<port>/`，server.allowedHosts 加入工作台实际域名，默认 HMR 沿同一入口使用 WS/WSS；根相对 API 和登录回调仍需项目配置。

## 平台要求

| 组件                         | 运行前提                                                             |
| ---------------------------- | -------------------------------------------------------------------- |
| Linux agent amd64            | Ubuntu 24.04、Debian 12、Alpine 3.23、CentOS 7.9；静态 musl，rg 随包 |
| Linux agent arm64            | Ubuntu 24.04、Debian 12、Alpine 3.23、CentOS 7.9；静态 musl，rg 随包 |
| Windows agent amd64          | Windows 11 x64、本地 NTFS、原生 Git 和 PowerShell 7                  |
| macOS agent amd64、arm64     | macOS 14 及更高版本                                                  |
| server 包及镜像 amd64、arm64 | Ubuntu 24.04                                                         |

设备还需 Git 2.23+、SSH、有效 UTF-8 locale 和项目使用的 Shell/CLI。Linux 静态包不替代这些外部程序的系统依赖，也不加载 glibc NSS 插件或动态 Node addon。Linux 文件发布要求内核与文件系统支持 `renameat2(RENAME_NOREPLACE)`；CentOS 7.9 amd64 基线为含此回移植的 `3.10.0-1160.el7.x86_64`。

CentOS 7.9 arm64 的基线为 `4.18.0-193.28.1.el7.aarch64`、64KiB 内存页与 XFS；其余三个 ARM 目标使用 ext4。

macOS 组件在匹配架构的 macOS 构建机上编译，需要 Command Line Tools 和 SDK；部署目标为 14.0。

## 随包材料

各包包含项目 LICENSE。Web 第三方材料位于 `licenses/`，原生材料位于 `native/licenses/`，Windows 对应源码位于 `native/sources/`；随实际组件保留其已有文件。

## 终端补丁维护

### xterm补丁再生成

使用项目固定Node/pnpm，在隔离维护目录安装`esbuild@0.28.0`。取得同版本未修补的npm包，保留其`lib/xterm.mjs`及map原件；先按以下参数重生成未修补包的副本，逐字比对ESM。一致后，在`pnpm patch @xterm/xterm@6.1.0-beta.304`给出的编辑目录修改TS并重生成，还原`lib/xterm.mjs.map`原件，最后用`pnpm patch-commit <编辑目录>`更新现有补丁。

将以下脚本放在安装esbuild的维护目录，以`node generate.mjs <生成目标目录> <未修补包目录>`执行；banner始终取自未修补原件。

```js
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2]);
const original = readFileSync(
  resolve(process.argv[3], "lib/xterm.mjs"),
  "utf8",
);
await build({
  absWorkingDir: root,
  entryPoints: ["src/browser/public/Terminal.ts"],
  outfile: "lib/xterm.mjs",
  bundle: true,
  format: "esm",
  target: "es2021",
  sourcemap: true,
  treeShaking: true,
  minify: true,
  legalComments: "none",
  banner: { js: original.slice(0, original.indexOf("var ")).trimEnd() },
  tsconfigRaw: {
    compilerOptions: { target: "es2021", experimentalDecorators: true },
  },
});
```

补丁保留可读TS修改和实际消费的ESM；升级后复核适配并执行受影响的类型和终端验证。生成工具仅用于隔离维护目录。
