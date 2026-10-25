# 接入设备

[English](devices.en.md)

本文面向部署者，说明如何把 Linux、macOS 和 Windows 机器接入工作台，并让 agent 长期运行。开始前先按[部署 server](server.md) 完成部署并登录工作台。

## 支持的系统与准备

| 系统                                                    | 架构                                | agent 发布包                                |
| ------------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| Linux：Ubuntu 24.04、Debian 12、Alpine 3.23、CentOS 7.9 | amd64、arm64                        | `kiteline-agent-<版本>-linux-<架构>.tar.gz` |
| macOS 14 及以上                                         | amd64（Intel）、arm64（Apple 芯片） | `kiteline-agent-<版本>-macos-<架构>.tar.gz` |
| Windows 11                                              | x64                                 | `kiteline-agent-<版本>-windows-amd64.zip`   |

同一架构的四个 Linux 发行版使用同一个发布包。

agent 在设备上以项目用户运行。项目用户是你日常使用、拥有项目文件的操作系统账户；工作台中的终端、文件操作、Git 和定时任务都以这个账户的权限执行。把 agent 安装到系统目录，以及对这份安装执行 `upgrade`、`uninstall`，需要管理员权限（Linux 和 macOS 用 sudo，Windows 用 UAC 提升）。也可以由项目用户在自己拥有的目录解包完整发布包，[直接运行](#手工安装)，无需管理员权限或执行 `install`。绑定、运行和其他 `kiteline-agent` 命令只能由项目用户执行。

发布包自带 Node、tmux、终端记录器（recorder）、terminfo、ripgrep 和文件操作辅助程序，设备上不需要安装这些程序，也不需要 npm 或编译器。设备需要自己提供：

- Git 2.23.0 或更高版本。
- 项目用户的 Shell：Linux 和 macOS 使用账户的登录 Shell，Windows 使用 PowerShell，默认选择见 [shell](reference.md#shell)。
- Linux 和 macOS：SSH 客户端（`ssh`）和 UTF-8 locale。
- Linux：`flock`（util-linux）、`infocmp`（ncurses）、`curl`、`tar`、`gzip`、`sha256sum`、`getent`；安装到系统目录时，非 root 用户还需要能使用 `sudo`。
- 项目实际使用的工具，例如编译器和 AI CLI。

接入命令会检查 agent 所需的前置条件，缺少时列出缺失项；各系统的安装方法见[安装系统依赖](#安装系统依赖)。

## 用网页命令接入

尚无设备时，可在主页点击“绑定设备”；也可从设备导航打开。选择设备的系统，复制接入命令，在设备上以项目用户执行。Windows 上使用普通（非管理员）的 PowerShell 窗口，在管理员窗口中执行会被拒绝。命令包含一次性绑定码，要在到期前执行（有效期见[限额](reference.md#限额)）。

命令中的 server 地址就是浏览器当前使用的入口，设备必须能访问这个地址。如果你通过 `127.0.0.1`、`localhost` 或 SSH 端口转发打开工作台，先改用设备能访问的地址打开工作台，再生成命令。用 HTTPS 入口生成的命令只通过 HTTPS 下载。

接入命令从 server 下载与 server 版本相同的 agent 发布包并校验 SHA-256，执行 `kiteline-agent check` 检查前置条件，然后安装 agent、用绑定码绑定，最后在当前终端前台运行 agent：

- Linux 和 macOS：用 sudo 安装到 `/opt/kiteline-agent`，命令入口为 `/usr/local/bin/kiteline-agent`。以 root 执行时直接安装。
- Windows：确认 UAC 提示后，由一个新的管理员 PowerShell 窗口安装到 `C:\Program Files\kiteline-agent`，并把 `kiteline-agent` 加入系统 PATH；绑定和运行仍在原窗口中进行。命令只为本次进程临时放宽 PowerShell 执行策略。当前窗口可以直接使用 `kiteline-agent`，其他已打开的窗口要从开始菜单重新打开才能使用。

绑定完成后，网页会区分已登记但尚未确认在线与已在线。尚未在线时需要启动 agent；在线后可在绑定对话框中直接添加工作区。

agent 在前台运行时，按 Ctrl-C 会停止 agent，同时结束它管理的终端会话和正在执行的定时任务运行；Linux 和 macOS 上关闭终端也是如此。Windows 上直接关闭 PowerShell 窗口或注销会强制结束 agent，不做清理：正在执行的定时任务运行在下次启动时需要[核查](scheduled-tasks.md#agent-重启后的核查)，留下的会话目录按[清理遗留的终端会话](reference.md#清理遗留的终端会话)删除。

以后再次启动不需要重新绑定，以项目用户执行：

```sh
kiteline-agent run
```

要让 agent 在关闭终端或注销后继续运行，见[后台运行](#后台运行)。

### 失败时

- 缺少工具或检查未通过：命令列出缺失项和安装建议，见[安装系统依赖](#安装系统依赖)。处理后，在绑定码有效期内重新执行同一条命令。
- 提示 `… uses the installation configuration`：当前 Shell 中设置了 `KITELINE_AGENT_HOME` 或 `KITELINE_AGENT_RUN_DIR`。取消这两个变量后重试；需要自定义目录时改用[手工安装](#手工安装)。
- 绑定码过期：对话框显示“绑定码已过期”，点击“重新生成”，复制新命令执行。
- 程序已安装但绑定失败：重新执行接入命令，不会重复安装，直接重试绑定。
- 提示 `This installation is already bound`：这台设备已经绑定，命令不会启动 agent，直接执行 `kiteline-agent run`。
- 提示 `A different version is installed`：先[升级 agent](#升级-agent)。
- 提示 `Binding result is unknown`：按[重新绑定](#重新绑定)处理。

### 仅绑定命令

绑定对话框也提供仅绑定命令：先执行 `check`，再用绑定码绑定，不安装也不启动 agent。用于已经手工安装或需要重新绑定的设备；绑定后执行 `kiteline-agent run`。

## 添加工作区

设备在线后，可从绑定对话框或设备详情打开“添加工作区”。输入新路径时，先前往再登记，具体操作见[设备与工作区](usage.md#设备与工作区)；登记项目目录后即可打开[终端](usage.md#终端)、文件和 Git。

## 后台运行

前台运行的 agent 随终端关闭、Ctrl-C 或用户注销而停止。要让 agent 开机自动运行，并在项目用户注销后继续运行终端和定时任务，需要用服务管理器运行它：Linux 用 systemd，macOS 用 launchd，Windows 用 WinSW。

以下步骤用于系统目录安装。程序目录的 `deploy/` 中附带示例配置（Linux 和 macOS 为 `/opt/kiteline-agent/deploy/`，Windows 为 `C:\Program Files\kiteline-agent\deploy\`）。项目不会替你安装、启动或删除服务。程序目录在升级时整体替换，所以先把示例复制到别处再修改。Alpine 默认使用 OpenRC，可以参照 systemd 示例中的用户、目录和环境变量自行编写服务。

配置服务之前，先在前台完成安装和绑定、确认 agent 能连接，然后按 Ctrl-C 停止它。同一个数据目录同时只能运行一个 agent。

服务的运行环境与你的登录 Shell 不同：

- 服务不读取 Shell 配置文件。agent、工作台 Git 和定时任务需要的 `PATH`、locale 和代理变量要写在服务配置中；`/etc/kiteline-agent.env` 只提供数据目录和运行目录的位置。终端与定时任务使用的 Shell 启动参数不同，见 [shell](reference.md#shell)。
- 需要交互解锁的 Git 凭据（例如只加载在桌面会话 SSH agent 中、带口令的密钥）在服务中不可用，要改用无需交互的认证方式。
- 服务启动后，以项目用户执行 `kiteline-agent doctor` 查看正在运行的 agent 的实际环境，再在工作台的 Git 中执行一次 Fetch，确认认证可用。

### systemd

在 Linux 上以项目用户（需要能使用 sudo）执行：

```sh
sudo cp /opt/kiteline-agent/deploy/kiteline-agent.service /etc/systemd/system/kiteline-agent.service
sudo sed -i "s/YOUR_PROJECT_USER/$(id -un)/g" /etc/systemd/system/kiteline-agent.service
sudo -e /etc/systemd/system/kiteline-agent.service
```

在编辑器中检查并按需修改：

- `WorkingDirectory` 和 `HOME`：项目用户的主目录（root 为 `/root`）。
- `PATH`：加入 Git 和项目工具所在的目录，例如 `~/.local/bin` 的绝对路径或 SCL Git 的目录。
- `LANG`：一个已安装的 UTF-8 locale。CentOS 7 没有 `C.UTF-8`，改为 `en_US.UTF-8`。
- 代理：需要时加入 `Environment=HTTPS_PROXY=http://proxy.example.com:3128` 等行，见[出站代理与证书](#出站代理与证书)。

保留 `KillMode`、`TimeoutStopSec=45` 等其余设置。然后启用并启动服务：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now kiteline-agent
systemctl status kiteline-agent
sudo journalctl -u kiteline-agent -f
```

服务开机自动启动，agent 异常退出时 systemd 会重新启动它。停止和启动：

```sh
sudo systemctl stop kiteline-agent
sudo systemctl start kiteline-agent
```

### launchd

在 macOS 上以项目用户（管理员）执行。示例是一个系统级 LaunchDaemon，以项目用户运行 agent：

```sh
sudo cp /opt/kiteline-agent/deploy/kiteline-agent.plist /Library/LaunchDaemons/com.kiteline.agent.plist
sudo sed -i '' "s/YOUR_PROJECT_USER/$(id -un)/g" /Library/LaunchDaemons/com.kiteline.agent.plist
sudo -e /Library/LaunchDaemons/com.kiteline.agent.plist
```

检查 `HOME`、`WorkingDirectory`（默认 `/Users/<用户名>`）、`PATH` 和 `LANG`。数据和运行目录由 `/etc/kiteline-agent.env` 提供，plist 中不要设置 `KITELINE_AGENT_HOME` 或 `KITELINE_AGENT_RUN_DIR`；沿用旧 plist 时，先确认该文件指向当前使用的目录，再删除这两项。然后加载：

```sh
sudo chown root:wheel /Library/LaunchDaemons/com.kiteline.agent.plist
sudo chmod 644 /Library/LaunchDaemons/com.kiteline.agent.plist
plutil -lint /Library/LaunchDaemons/com.kiteline.agent.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.kiteline.agent.plist
```

agent 立即启动，以后每次开机自动启动；它异常退出时 launchd 不会重新启动它。日志写在 `~/.local/share/kiteline-agent/launchd.log` 和 `launchd-error.log`。后台运行的 agent 可能被 macOS 的隐私保护拒绝访问“桌面”“文稿”“下载”等目录，项目目录请放在这些目录之外。

停止和启动：

```sh
sudo launchctl bootout system /Library/LaunchDaemons/com.kiteline.agent.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.kiteline.agent.plist
```

### WinSW

Windows 上使用 WinSW 2.12 把 agent 注册为 Windows 服务。以下命令在管理员 PowerShell 中执行。服务目录放在项目用户的主目录下，这样只有项目用户和管理员能修改服务程序：

```powershell
$projectUser = 'PROJECT_USER'  # 替换为 C:\Users 下项目用户的目录名
$service = "C:\Users\$projectUser\kiteline-service"
New-Item -ItemType Directory -Force -Path $service
Invoke-WebRequest -UseBasicParsing 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile "$service\kiteline-agent.exe"
(Get-Content "$env:ProgramFiles\kiteline-agent\deploy\kiteline-agent.xml" -Raw).Replace('PROJECT_USER', $projectUser) |
  Set-Content "$service\kiteline-agent.xml" -Encoding utf8
notepad "$service\kiteline-agent.xml"
```

WinSW 按自身文件名查找配置，所以 `kiteline-agent.exe` 必须与 `kiteline-agent.xml` 同名并放在同一目录。在记事本中检查：

- `PATH`：包含 Git 的 `cmd` 目录和项目工具所在的目录；使用 PowerShell 7 时也包含它的目录。
- 数据和运行目录由安装记录提供，不要在 XML 中设置 `KITELINE_AGENT_HOME` 或 `KITELINE_AGENT_RUN_DIR`；沿用旧 XML 时，先确认 `%ProgramData%\kiteline-agent\installation.json` 的 `dataDir` 和 `runDir` 指向当前使用的目录，再删除这两项。
- 代理：需要时加入 `<env name="HTTPS_PROXY" value="http://proxy.example.com:3128" />` 等行。
- 保留 `<hidewindow>false</hidewindow>`、`<stopparentprocessfirst>true</stopparentprocessfirst>` 和 `<stoptimeout>45sec</stoptimeout>`：停止服务时，WinSW 靠它们把 Ctrl-C 送到 agent，并留出结束终端会话和定时任务运行的时间。

保存后注册服务：

```powershell
& "$service\kiteline-agent.exe" install
```

服务默认以 LocalSystem 运行，agent 会拒绝。打开 `services.msc`，双击“Kiteline Agent”，在“登录”选项卡选择“此帐户”，填入项目用户的账户（本地账户写作 `.\PROJECT_USER`）和 Windows 密码（用 Microsoft 账户登录的用户填该账户的密码，不能用 PIN），确定。然后启动：

```powershell
& "$service\kiteline-agent.exe" start
& "$service\kiteline-agent.exe" status
```

服务开机自动启动，日志文件写在服务目录中。停止服务用 `stopwait`，它等到服务真正停止后才返回；`stop` 只发出停止请求：

```powershell
& 'C:\Users\PROJECT_USER\kiteline-service\kiteline-agent.exe' stopwait
& 'C:\Users\PROJECT_USER\kiteline-service\kiteline-agent.exe' start
```

## 安装系统依赖

### Linux

以下命令以 root 执行；以普通用户执行时在每条命令前加 `sudo`。

```sh
# Ubuntu 24.04、Debian 12
apt-get update
apt-get install -y curl ca-certificates tar gzip coreutils git openssh-client ncurses-bin locales util-linux sudo

# Alpine 3.23
apk add curl ca-certificates tar gzip coreutils musl-utils git openssh-client ncurses musl-locales util-linux sudo

# CentOS 7.9：先把 yum 源改为 vault.centos.org
sed -i -e 's/^mirrorlist=/#mirrorlist=/' -e 's|^#\? *baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' /etc/yum.repos.d/CentOS-*.repo
yum install -y curl ca-certificates tar gzip coreutils openssh-clients ncurses glibc-common util-linux sudo
```

CentOS 7 已停止维护，官方镜像站已下线，所以 yum 源要改为 `vault.centos.org`。CentOS 7 自带的 Git 低于 2.23.0，需要另外安装，例如 Software Collections 的 `rh-git227`；它的源文件由 `centos-release-scl` 安装，安装后同样改为 vault 源：

```sh
yum install -y centos-release-scl
sed -i -e 's/^mirrorlist=/#mirrorlist=/' -e 's|^#\? *baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' /etc/yum.repos.d/CentOS-SCLo-*.repo
[ "$(uname -m)" = aarch64 ] && sed -i 's|vault.centos.org/centos/7/sclo/|vault.centos.org/altarch/7/sclo/|' /etc/yum.repos.d/CentOS-SCLo-*.repo
yum install -y rh-git227
```

使用 SCL 的 Git 时，在运行 agent 的 Shell 中先执行 `source /opt/rh/rh-git227/enable`。作为服务运行时，把执行该脚本后的 `PATH` 和 `LD_LIBRARY_PATH`（用 `echo "$PATH"`、`echo "$LD_LIBRARY_PATH"` 查看）写入服务配置。

### macOS

以项目用户准备 Git：

```sh
xcode-select --install
```

这会安装 Command Line Tools，其中包含 Git。也可以使用其他来源的 Git 2.23.0 或更高版本。SSH 客户端由系统提供。

### Windows

支持 Windows 自带的 PowerShell 5.1 或 PowerShell 7.4 及以上 7.x 版本。另需 Git for Windows，可用 winget 安装：

```powershell
winget install --id Git.Git --source winget
```

安装后打开新的 PowerShell 窗口，确认 `git --version` 可以执行。项目用户需要已经登录过一次 Windows（已有用户配置文件）。项目用户是标准用户时，安装过程中的 UAC 提示需要输入管理员的账户和密码。

日常以普通权限运行。项目账户本身是管理员、且确实需要管理员权限时，先停止 agent，再以同一账户“以管理员身份运行”PowerShell，执行 `kiteline-agent run`；此时终端、文件、Git 和定时任务也会获得管理员权限。标准用户输入另一管理员的凭据会切换账户，不能用它运行原项目用户的安装。

### UTF-8 locale

Linux 和 macOS 上，agent 要求运行环境使用 UTF-8 locale。执行 `locale charmap`，输出应为 `UTF-8`。不是时，用 `locale -a` 查看已安装的 locale，然后在项目用户登录时读取的 Shell 配置中设置（bash 为 `~/.bash_profile`，没有该文件时为 `~/.profile`；zsh 为 `~/.zprofile`；Alpine 的 ash 为 `~/.profile`）：

```sh
export LANG=C.UTF-8      # Ubuntu、Debian、Alpine
export LANG=en_US.UTF-8  # CentOS 7、macOS
```

两行选一行。`LC_ALL` 和 `LC_CTYPE` 优先于 `LANG`，它们被设成非 UTF-8 的值时也要修改。通过 SSH 登录 macOS 时 `LANG` 常常为空，需要这样设置。后台服务不读取 Shell 配置，要在服务配置中设置，见[后台运行](#后台运行)。

## 手工安装

手工下载、校验并解包完整发布包后，可以以项目用户直接前台运行，也可以由管理员安装到系统目录。两种方式都使用网页上的[仅绑定命令](#仅绑定命令)。

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

无需系统安装时，展开网页上的[仅绑定命令](#仅绑定命令)，把其中两处 `kiteline-agent` 改成 `"./$name/bin/kiteline-agent"`，在当前 Shell 中执行；绑定后执行：

```sh
"./$name/bin/kiteline-agent" run
```

保留整个解包目录，后续命令也使用这个入口。

需要安装到系统目录时，执行：

```sh
sudo "./$name/bin/kiteline-agent" install --user "$(id -un)"
```

由管理员替其他账户安装时，管理员执行这条命令并把 `"$(id -un)"` 换成项目用户名，`check` 仍由项目用户执行。

`install` 在 `/etc/kiteline-agent.env` 中记录 agent 数据目录，默认为项目用户的 `~/.local/share/kiteline-agent`，运行目录默认为其中的 `run`。需要使用其他目录时，在绑定前编辑这个文件中的 `KITELINE_AGENT_HOME` 和 `KITELINE_AGENT_RUN_DIR`，格式见[目录配置文件](reference.md#目录配置文件)。运行目录的路径长度有上限（见[限额](reference.md#限额)）。

然后以项目用户执行网页上的[仅绑定命令](#仅绑定命令)，再执行 `kiteline-agent run`。

同一用户重复安装同一版本时，`install` 提示已经安装，不改动程序、绑定和任务；已安装其他版本时，`install` 拒绝执行，改用[升级 agent](#升级-agent)。

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

无需系统安装时，展开网页上的[仅绑定命令](#仅绑定命令)，把其中两处 `-File` 后的脚本路径改成 `".\$package\bin\kiteline-agent.ps1"`，在当前窗口执行；绑定后执行：

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

agent 数据目录默认为项目用户的 `%LOCALAPPDATA%\kiteline-agent`，运行目录默认为其中的 `run`。安装时可以用 `--data-dir` 和 `--run-dir` 指定其他绝对路径；安装程序无法确定项目用户的 LocalAppData 时（例如该用户当前没有登录），必须显式指定这两个选项。

安装完成后关闭管理员窗口，从开始菜单新开项目用户的普通 PowerShell 窗口，执行网页上的[仅绑定命令](#仅绑定命令)，再执行 `kiteline-agent run`。

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
- `no_proxy` 用逗号或空格分隔；`*` 表示全部直连；以 `.` 或 `*` 开头的项按后缀匹配（`.example.com` 匹配 `kiteline.example.com`）；可以带 `:端口`；不支持 CIDR 网段。

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

作为服务运行时，在服务配置中设置这些变量（见[后台运行](#后台运行)），然后重启服务；重启会结束当前的终端会话和定时任务运行。

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

在容器的 Shell 中粘贴网页上的[仅绑定命令](#仅绑定命令)执行，然后 `exit`。绑定凭据保存在 `agent-data` 卷中。启动 agent：

```sh
docker compose up -d
docker compose logs -f agent
```

在网页添加工作区时选择 `/home/dev/projects` 下的目录。

升级时把 `KITELINE_VERSION` 改为新版本，执行 `docker compose build` 和 `docker compose up -d`；绑定保留在卷中，不需要重新绑定。停止或重建容器会结束 agent 管理的终端会话和定时任务运行，与停止前台 agent 相同。

- Git 认证：把项目用户的 SSH 密钥、`config` 和 `known_hosts` 挂载到 `/home/dev/.ssh`，或挂载一个 SSH agent socket 并设置 `SSH_AUTH_SOCK`；`.gitconfig` 引用的 credential helper 也要安装在镜像中。只读挂载的 `known_hosts` 无法记录新主机，要事先写入。
- linked worktree：把主仓库和各个工作树按宿主机上相同的绝对路径挂载，否则 `.git` 文件中记录的路径在容器中不存在。
- 开发服务：容器内启动的服务可以直接通过工作台访问。另一个容器中的服务需要与 agent 共享网络命名空间（Compose 中设置 `network_mode: "service:agent"`）；宿主机的 `localhost` 和同一网桥上的其他容器不是 agent 的 `localhost`。

## 升级 agent

agent 的版本必须与 server 相同。先[升级 server](server.md#升级-server)，再升级显示“版本不匹配”的每台设备。

直接运行解包目录的用户按[手工换包](#手工换包)更新；系统目录安装使用下面的网页命令或手工升级命令。

升级系统目录安装前，停止所有使用这份安装的进程，否则升级会拒绝执行（提示 `Agent installation is busy`，Windows 上为 `Installation is busy`）：

- 前台运行的 agent：按 Ctrl-C。
- 服务：用[后台运行](#后台运行)中的停止命令，它们同时阻止服务管理器自动重启。
- 使用其他数据目录运行的 agent 实例。
- 正在执行的其他 `kiteline-agent` 命令和包内 CLI 调用：等待它们结束。

停止 agent 会结束它的终端会话和定时任务运行；绑定、配置、工作区、定时任务定义和保留的运行记录都会保留。

### 手工换包

按 Ctrl-C 停止旧 agent，等命令结束后，再按[手工安装](#手工安装)下载、校验与 server 同版的完整发布包，解到新目录。以同一项目用户使用新包入口执行 `check` 和 `run`，沿用原数据目录与运行目录设置，不重新绑定。绑定、配置、定时任务定义和保留的运行记录继续使用原数据；工作区文件仍在原位置。

同版重解包也使用新目录，不向旧程序目录合并文件。新包检查和运行正常后，可以删除自己拥有的旧程序目录。

### 用网页命令升级

在设备页的“升级 agent”中复制升级命令，到设备上的交互式终端或 SSH 会话执行；平台未知时先选择平台。命令从当前入口下载与 server 版本相同的发布包并校验：Linux 和 macOS 上用 sudo 执行升级；Windows 上在 PowerShell 中执行，确认 UAC 提示后在新的管理员窗口中升级。升级前提示 `Type yes to continue:`，输入 `yes` 继续。server 版本在复制命令之后又变化时，命令提示 `The server release changed` 并停止，重新复制即可。

升级不改变绑定和保存的 server 地址。升级成功后 agent 不会自动启动（输出中有 `not started`），按平时的方式启动：前台执行 `kiteline-agent run`，或启动服务。

### 手工升级

把新版本的发布包和对应的 `.sha256` 文件下载到同一目录（下载方法同[手工安装](#手工安装)），然后执行：

```sh
sudo /usr/local/bin/kiteline-agent upgrade --archive "$PWD/kiteline-agent-X.Y.Z-linux-amd64.tar.gz"
```

```powershell
# 在管理员 PowerShell 中执行，使用新包内的维护脚本
Set-Location 'C:\Users\PROJECT_USER\Downloads'
$package = 'kiteline-agent-X.Y.Z-windows-amd64'
$expected = (Get-Content -LiteralPath "$package.zip.sha256").Split(' ')[0]
if ((Get-FileHash -LiteralPath "$package.zip" -Algorithm SHA256).Hash -ine $expected) { throw 'Package SHA256 verification failed' }
Expand-Archive -LiteralPath "$package.zip" -DestinationPath .
& (Join-Path $PSHOME $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'powershell.exe' } else { 'pwsh.exe' })) -NoProfile -ExecutionPolicy Bypass -File ".\$package\bin\kiteline-agent.ps1" upgrade --archive "$PWD\$package.zip"
```

版本号和文件名按实际下载的发布包修改。加 `--yes` 跳过确认。替换程序失败时，升级会尝试恢复旧程序；恢复也失败时，输出会给出备份位置。

## 卸载

直接运行解包目录时，按 Ctrl-C 停止 agent，然后删除自己拥有的程序目录即可。程序目录外的 agent 数据和工作区文件保留。

下面的卸载命令用于系统目录安装。删除设备后，网页会提供本机卸载命令；平台未知时先选择平台。

先像[升级 agent](#升级-agent) 一样停止所有使用者。卸载命令不处理服务配置，用了服务时先删除它：

- systemd：执行 `sudo systemctl disable --now kiteline-agent`，删除 `/etc/systemd/system/kiteline-agent.service`，再执行 `sudo systemctl daemon-reload`。
- launchd：执行[停止命令](#launchd)中的 `bootout`，再删除 `/Library/LaunchDaemons/com.kiteline.agent.plist`。
- WinSW：在管理员 PowerShell 中对服务程序执行 `stopwait` 和 `uninstall`，再删除服务目录。

然后选择卸载模式。默认卸载删除程序目录、命令入口和安装记录，保留 agent 数据、运行目录、Unix 的 `/etc/kiteline-agent.env` 和协调锁。Linux 和 macOS：

```sh
sudo /usr/local/bin/kiteline-agent uninstall
```

Windows（管理员 PowerShell）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" uninstall
```

Windows 上两种模式都会从系统 PATH 中删除 `kiteline-agent` 的入口；已打开的窗口要重新打开。

同一项目用户使用原数据路径重新安装时，可以复用绑定和数据。Windows 的自定义数据或运行目录要在重新安装时再次传入，安装器不会记住它们。Unix 重新安装会沿用 `/etc/kiteline-agent.env`；更换项目用户前，先删除它或改正其中的数据路径。

完整清理使用 `--purge`：

```sh
sudo /usr/local/bin/kiteline-agent uninstall --purge
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" uninstall --purge
```

`--purge` 还会删除 `/etc/kiteline-agent.env`、整个 agent 数据与运行目录（包括绑定、工作区登记、定时任务和运行记录）、协调锁和 agent 专用的空目录。检查命令列出的目录后输入 `yes` 确认；加 `--yes` 跳过确认。

两种模式都不清理 [CLI 凭据](cli.md#接入)：它们保存在独立的目录中，卸载也不会撤销它们。

## 重新绑定

重新绑定为设备生成新的身份。工作区登记和定时任务保存在 agent 数据目录中，重新绑定后保留。

通用步骤：

1. 停止 agent（前台按 Ctrl-C，或停止服务）。
2. 删除 agent 数据目录中的 `connection.json`：

   ```sh
   rm ~/.local/share/kiteline-agent/connection.json
   ```

   ```powershell
   Remove-Item "$env:LOCALAPPDATA\kiteline-agent\connection.json"
   ```

   修改过数据目录时，换成实际路径。

3. 在工作台点击“绑定设备”，以项目用户执行[仅绑定命令](#仅绑定命令)。
4. 启动 agent。
5. 工作台中旧的设备记录会一直离线，在它的“设备操作”菜单中点击“删除设备”。

各种情况的处理：

- 提示 `Binding result is unknown`：server 可能已经处理了绑定请求。按网页绑定对话框的状态处理：
  - “等待设备”：重新执行同一条命令。
  - “绑定码已过期”：点击“重新生成”，执行新命令。
  - “已登记，尚未连接”等已登记状态：agent 数据目录中有 `connection.json` 时直接启动 agent；没有时在网页删除这台新登记的设备，再用新绑定码执行仅绑定命令。
- 提示 `was registered but its credentials were not saved`：在网页删除该设备，再用新绑定码绑定。
- 绑定凭据丢失（数据目录被删除或换了数据目录）：按通用步骤绑定，并删除旧的设备记录。
- 两个 agent 数据目录中有同一份凭据（例如克隆了虚拟机或磁盘，或复制了数据目录）：后连接的 agent 会顶替先连接的，被顶替的 agent 输出 `Remote connection stopped`（原因为 `connection_replaced`）并停止连接。在副本上按通用步骤重新绑定。
- 设备在网页中被删除：agent 输出 `Remote connection stopped` 并停止连接。需要继续使用时按通用步骤重新绑定。
- server 地址变化或换用另一个 server：agent 只连接绑定时的地址。按通用步骤，从设备能访问的新入口生成绑定码并绑定。
