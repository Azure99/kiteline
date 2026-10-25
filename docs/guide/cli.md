# 远程 CLI

[English](cli.en.md)

本文面向在自己电脑的终端中操作工作台设备的拥有者。`kiteline` 经 server 连接选定设备，用工作台签发的凭据认证；设备上的运行与维护使用 `kiteline-agent`，server 管理使用 `kiteline-server`。

## 下载

从 [GitHub Releases](https://github.com/Azure99/kiteline/releases) 下载与 server 版本相同、匹配本机系统和架构的 `kiteline-cli-<版本>-<平台>-<架构>` 归档及同名 `.sha256`。支持的系统和架构与[设备 agent](devices.md#支持的系统与准备) 相同；Windows 需要 PowerShell 5.1 或 7.4 及以上 7.x。CLI 包自带 Node，本机不需要 Git、tmux 或 agent。

### Linux 和 macOS

```sh
KITELINE_VERSION=X.Y.Z  # 替换为 server 版本
KITELINE_PLATFORM=linux # macOS 改为 macos
KITELINE_ARCH=amd64     # ARM64 和 Apple 芯片改为 arm64
name="kiteline-cli-$KITELINE_VERSION-$KITELINE_PLATFORM-$KITELINE_ARCH"
url="https://github.com/Azure99/kiteline/releases/download/v$KITELINE_VERSION"
curl -fLO "$url/$name.tar.gz"
curl -fLO "$url/$name.tar.gz.sha256"
sha256sum -c "$name.tar.gz.sha256"       # Linux
# shasum -a 256 -c "$name.tar.gz.sha256" # macOS 用这一行代替上一行
tar -xpzf "$name.tar.gz" --no-same-owner
export PATH="$PWD/$name/bin:$PATH"
kiteline --version
```

`PATH` 设置只对当前终端生效；新终端中重新设置，或使用解包目录中的完整路径。保留整个包目录，入口依赖包内的 runtime。macOS 上用浏览器下载的归档被系统隔离时，按[手工安装](devices.md#手工安装)中的方法移除隔离属性。

### Windows

在 PowerShell 中执行：

```powershell
$version = 'X.Y.Z' # 替换为 server 版本
$package = "kiteline-cli-$version-windows-amd64"
$url = "https://github.com/Azure99/kiteline/releases/download/v$version"
Invoke-WebRequest -UseBasicParsing "$url/$package.zip" -OutFile "$package.zip"
Invoke-WebRequest -UseBasicParsing "$url/$package.zip.sha256" -OutFile "$package.zip.sha256"
$expected = (Get-Content "$package.zip.sha256" -Raw).Trim().Split(' ')[0]
if ((Get-FileHash "$package.zip" -Algorithm SHA256).Hash -ine $expected) { throw 'Checksum mismatch' }
Expand-Archive -LiteralPath "$package.zip" -DestinationPath .
Set-ExecutionPolicy -Scope Process Bypass -Force
$env:Path = (Resolve-Path -LiteralPath ".\$package\bin").Path + ';' + $env:Path
kiteline.ps1 --help
```

执行策略和 `PATH` 只对当前窗口生效。下文的 `kiteline` 在 Windows 上换成 `kiteline.ps1`，不需要管理员权限；交互接续必须经 `.ps1` 入口，由它恢复本机终端状态。

用管道把 token 传给 CLI 时，要启动独立的 PowerShell 进程，token 才会成为 CLI 的标准输入；直接把管道接到脚本不行。文本或 JSON 参数直接传给 `& $cli`，避免外层 PowerShell 再解析引号：

```powershell
$cli = 'C:\包目录\bin\kiteline.ps1'
$shell = (Get-Process -Id $PID).Path
Get-Content -Raw credential.txt | & $shell -NoProfile -ExecutionPolicy Bypass -File $cli auth login --server https://desk.example --token-stdin
$reply = & $cli targets --json
$reply | ConvertFrom-Json
```

### 使用 agent 包中的 CLI

agent 发布包也带有同一个 CLI：`bin/kiteline`（Windows 为 `bin/kiteline.ps1`），与 agent 共用 Node。安装 agent 后它位于 `/opt/kiteline-agent/bin/kiteline` 或 `C:\Program Files\kiteline-agent\bin\kiteline.ps1`，随 agent 程序包一起升级和卸载，不注册全局 `kiteline` 命令；升级或卸载 agent 前先等这里的 CLI 调用结束。移除程序包不会撤销 CLI 凭据。

独立 CLI 的升级：校验并解开新版本归档，改用新入口，删除旧目录。

## 接入

### 签发凭据

在工作台右上角的拥有者菜单中打开 **CLI 接入 → CLI 凭据**，填写名称、选择一台或多台设备，再填写有效天数或选择 **无到期**。token 只显示这一次，server 只保存摘要。

凭据能以 agent 运行账户的权限操作选定设备，工作区不是沙箱；它不能管理设备登记、绑定码或其他凭据。设备 agent 使用的绑定码是另一种凭据。

### 登录

```sh
kiteline auth login --server https://desk.example
# 没有终端时必须明确指定输入来源：
kiteline auth login --server https://desk.example --token-stdin < credential.txt
kiteline auth status
```

- 第一种写法只在终端中提示粘贴 token；没有终端时立即报错。核验成功后才保存。
- 凭据保存在 `~/.kiteline/credentials.json`，用 `KITELINE_CLI_HOME` 可以指定其他目录。Linux 和 macOS 上新建的目录为 0700、文件为 0600；Windows 沿用所在用户目录的权限。不要把凭据放进共享目录或版本库。
- 也可以成组设置 `KITELINE_URL` 和 `KITELINE_TOKEN`，它们优先于保存的凭据；只设置其中一个会报错，不会补用文件中的另一个值。
- CLI 使用 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 和 `NODE_EXTRA_CA_CERTS`。它不跟随重定向，`--server` 要写准确的工作台地址。

### 退出与撤销

- `auth logout` 撤销当前 token，并删除正在使用的本地凭据文件。token 已失效时也会清除本地文件；网络结果不明时保留文件。使用环境变量凭据时，退出不删除磁盘上的凭据，环境变量要自行移除。
- 在签发凭据的对话框中可以撤销任一凭据。撤销会断开该凭据的连接，不结束共享的终端，也不撤回已经发送的输入；其他凭据继续有效。
- [重置拥有者密码](server.md#重置初始化-token-与密码)会使全部 CLI 凭据失效。

## 接续已有终端

在工作台会话菜单中选择“在 CLI 中接续”，复制带完整目标 ID 的命令，在已登录此 server 的本机终端执行。尚未接入时可打开“安装与登录”；引导中的平台选择会同步接续命令的 Shell。在引导中点“返回接续”、点 X 或按 Escape，会回到原会话命令，再关闭一次才退出流程。从设置菜单直接打开的“CLI 接入”关闭即退出。也可以手工指定目标：

```sh
kiteline terminal attach --device DEVICE_ID --workspace WORKSPACE_ID --session SESSION_ID
# 当前目录已有 .kiteline.json 时：
kiteline terminal attach
```

- 需要在真实终端中运行（stdin 和 stdout 都是 TTY），不接受 `--json`。不新建 Shell。
- 连接后直接输入：`Ctrl+C` 发给远端程序，`Ctrl+B d` 脱离，`Ctrl+B [` 进入 tmux 历史复制模式，`Ctrl+B Ctrl+B` 发送 Ctrl+B。
- 输入和终端尺寸与工作台共享，没有输入独占，同时输入的字符会交错。
- 脱离或断线只结束本次连接，会话继续运行。本机终端长时间跟不上输出时，连接报错结束，重新执行 attach 即可接续当前画面；Windows 上所在终端一直不读取输出时，入口可能一直等待。
- 正常脱离返回 0，这不是远端命令的退出码。

## 选择目标

```sh
kiteline targets
kiteline inspect --device DEVICE_ID --workspace WORKSPACE_ID
kiteline terminal list --device DEVICE_ID --workspace WORKSPACE_ID
```

`targets` 列出设备和工作区的完整 ID、名称、在线状态和路径；离线设备的工作区路径来自最后一次快照。`inspect` 另外列出该工作区当前的终端会话，需要设备在线。名称相同时用完整 ID 区分，CLI 不按名称猜测。

在当前目录放一个 `.kiteline.json`，可以省去反复输入目标：

```json
{ "device": "DEVICE_ID", "workspace": "WORKSPACE_ID", "session": "SESSION_ID" }
```

CLI 只读取当前目录中的这个文件，不向上级目录查找。命令行参数逐项覆盖文件中的值，不回写文件。不需要会话的命令忽略其中的 `session`，具体规则见各命令的 `--help`。

## 用短命令操作终端

```sh
kiteline terminal create --name work
# 把返回的会话 ID 写入当前目录的 .kiteline.json 后：
kiteline terminal snapshot
kiteline terminal send --text 'pwd; git status --short' --enter
kiteline terminal wait
kiteline terminal snapshot --tail 40
kiteline web url
```

每次调用都是独立的短命令，终端和 Shell 状态保留在设备上。

- `terminal send` 成功只表示输入已经送达，不表示命令执行完毕；用 `snapshot` 或 `wait` 观察结果后再决定下一步。CLI 不会自动重发输入。
- `terminal wait` 在输出安静或超时后返回当前画面；安静不代表任务已经完成。
- `terminal resize` 会改变所有客户端共享的终端尺寸。
- CLI 不提供 Git、定时任务等命令，在终端中使用原生工具完成。
- `kiteline web url` 返回同一终端在工作台中的链接，`web url --path PATH` 返回文件链接（不检查文件是否存在）。在工作台中点一下终端画面即可输入。

条件输入（`--if-input`）、增量观察（`--if-changed`）、样式区间（`--attrs`）和各项期限见 `kiteline terminal <命令> --help`，机制见[远程观察](../design/terminal.md#远程观察)。

### 记录不可用时

命令返回 `recording_unavailable` 时，终端程序通常仍在运行，attach 照常可用。需要短命令或工作台观察时，先用 `terminal list` 确认状态，再执行 `terminal recover`。恢复不重启程序，但会丢弃之前的网页历史，并可能短暂改变尺寸让程序重绘；返回 `recovering` 只表示已受理。

超过 1 MiB 的观察返回 `limit_exceeded`，终端继续运行；减少 `--tail`、去掉 `--attrs` 或缩小终端后再试。

## 传输文件

```sh
kiteline files download 'notes/设计.md' --output ./design.md
kiteline files upload 'notes/设计副本.md' --file ./design.md
kiteline web url --path 'notes/设计副本.md'
```

- 远端路径相对选定的工作区，使用 `/` 分隔，不能是绝对路径或含 `..`；本地路径用 `--output` 或 `--file` 指定。
- 下载不覆盖已有的本地文件。下载失败时可能留下空文件或部分内容，不能当作完整文件使用。
- 上传默认只创建新文件。目标已存在时返回冲突，诊断中给出可用于替换的版本；确认要替换时再执行 `kiteline files upload 'notes/设计副本.md' --file ./design.md --replace-version VERSION`。这个版本用于检查替换目标，不能证明你下载之后没人改过。
- 上传替换符号链接本身，下载跟随链接。
- 上传结果未确认时文件可能已经写入；先下载或在终端中检查，CLI 不会自动重传。

## 输出与退出码

默认输出供阅读；`--json` 在 stdout 输出带 `outcome`、`result` 或 `error.code` 的结构化结果。提示和诊断写到 stderr。CLI 不自动重试。

| 退出码 | 含义                                                                                          |
| ------ | --------------------------------------------------------------------------------------------- |
| 0      | 操作或观察成功。                                                                              |
| 1      | 远端失败（包括 `invalid_argument`）、部分失败，或读取请求的传输失败；部分结果和诊断仍会输出。 |
| 2      | 本地错误，例如参数、配置、默认目标或本地文件读写错误。                                        |
| 3      | 请求可能已经生效，但没有得到确定结果。先观察，再决定下一步。                                  |

结果未确认时总是退出 3，例如上传中本地读取失败、写入结果不确定。本地缺少或配置了无效的默认目标退出 2；设备上查不到目标退出 1。

JSON 请求最多等待 30 秒；文件传输连续 120 秒没有进展时结束。`--help` 和 `--version` 不需要连接 server。
