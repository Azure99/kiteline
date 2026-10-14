# 远程 CLI

`kiteline` 使用 Web 签发的设备操作凭据连接 server。设备上的运行与维护仍使用
`kiteline-agent`，server 管理仍使用 `kiteline-server`。

## 下载与运行

从 [GitHub Releases](https://github.com/Azure99/kiteline/releases) 下载与 server 版本和本机
系统、架构匹配的 `kiteline-cli-<版本>-<平台>-<架构>` 归档及同名 `.sha256`。系统与架构
范围见[支持的系统](devices.md#支持的系统与准备)；Windows 使用 PowerShell 5.1 或
7.4 及以上 7.x。CLI 包自带 Node，不需要预装 Node、Git、tmux 或本机 agent；设备指南
中的 Git、SSH 等前置条件用于运行设备 agent。

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
kiteline --help
```

上述 PATH 设置只对当前终端生效。新终端中重新设置，或调用解包目录中的完整入口路径。
保留整个包目录；入口使用包内 runtime。macOS 浏览器下载的归档若被系统隔离，校验后按
[手工安装说明](devices.md#linux-和-macos)移除解包目录的隔离属性。

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

执行策略和 PATH 设置仅对当前 PowerShell 窗口生效。新窗口中重新执行这两步，
或设置执行策略后用完整入口路径。下文命令中的 `kiteline` 在 Windows 上替换为
`kiteline.ps1`；无需管理员权限。
普通命令可直接调用脚本并捕获 JSON。传入 token 的 PowerShell 管道须启动独立
PowerShell 进程，使 token 成为 CLI 的 stdin；不能直接把管道接到脚本：

```powershell
$cli = 'C:\包目录\bin\kiteline.ps1'
$shell = (Get-Process -Id $PID).Path
Get-Content -Raw credential.txt | & $shell -NoProfile -ExecutionPolicy Bypass -File $cli auth login --server https://desk.example --token-stdin
$reply = & $cli targets --json
$reply | ConvertFrom-Json
```

文本或 JSON 参数直接传给 `& $cli`，避免外层 PowerShell 再解析引号。

### 已有共同 agent 包

agent 发布包也带有 `bin/kiteline`（Windows 为 `bin/kiteline.ps1`），与 agent 共用一份
Node。便携目录可以直接调用这两个入口；系统安装后 CLI 位于
`/opt/kiteline-agent/bin/kiteline`，Windows 位于
`C:\Program Files\kiteline-agent\bin\kiteline.ps1`。安装、升级和卸载以整个 agent
程序包为单位，只注册 `kiteline-agent`；不注册全局 `kiteline`，也不单独更新 CLI。
操作前等待该包中的 CLI 调用结束。CLI 凭据独立，移除程序包不会撤销凭据。

server 的下载接口只提供共同 agent 包，独立 CLI 从 Release 下载。独立 CLI 的升级是
校验并解开新归档后改用新入口，删除旧包即可移除旧程序。源码开发仍可用
`node cli/dist/main.js` 代替入口；Windows 的交互 attach 必须用 `.ps1` 入口恢复本机终端状态。

## 接入

在 Web 的“拥有者菜单 → CLI 接入 → CLI 凭据”中选择设备并签发 token，然后导入：

```sh
kiteline auth login --server https://desk.example
# 无交互环境必须明确指定输入来源：
kiteline auth login --server https://desk.example --token-stdin < credential.txt
kiteline auth status
```

第一条只在 TTY 中提示粘贴 token，无 TTY 时立即报错。导入核验成功后才保存。
凭据位于 `~/.kiteline/credentials.json`，与设备 agent 身份独立；可用
`KITELINE_CLI_HOME` 指定专用凭据目录。Unix 新建目录为 0700、文件为 0600；Windows
沿用所在用户目录的访问权限。凭据文件不能放进共享工作目录或版本库。

无人值守也可成组设置 `KITELINE_URL` 和 `KITELINE_TOKEN`，优先于已保存凭据；只设置
一个会报错，不会补用文件中的另一个值。CLI 沿用 `HTTP_PROXY`、`HTTPS_PROXY`、
`NO_PROXY` 和 Node 的 `NODE_EXTRA_CA_CERTS`，使用准确的 server origin，不跟随重定向。

`auth logout` 撤销当前 token，并删除当前使用的本地凭据文件。环境凭据的退出不删除
另一份磁盘凭据，调用方需自行移除环境变量。token 已失效时也可清除本地保存；网络结果
不明时保留文件。Web owner 可以定向撤销凭据。权限含义及期限见[设备操作凭据](server.md#签发-cli-凭据)。

## 发现和选择目标

```sh
kiteline targets
kiteline inspect --device DEVICE_ID --workspace WORKSPACE_ID
kiteline terminal list --device DEVICE_ID --workspace WORKSPACE_ID
```

`targets` 列出完整 ID、名称、在线状态及工作区路径。工作区来自设备元数据快照，离线
设备的路径不是当前文件系统检查结果。`inspect` 附加选中工作区的实际终端列表；设备离线
时无法获取该列表。相同名称的目标通过完整 ID 区分，不按名称猜测。

在调用进程的当前工作目录放置 `.kiteline.json` 可减少多轮调用中的重复参数：

```json
{ "device": "DEVICE_ID", "workspace": "WORKSPACE_ID", "session": "SESSION_ID" }
```

CLI 只读当前目录，不搜索父目录、Git 根目录或 home。它是目录共享的默认值；显式
`--device`、`--workspace`、`--session` 逐字段覆盖本次调用，不回写。组合不匹配时明确失败。
`inspect`、`terminal list`、`terminal create` 和 `files` 忽略默认 session，不接受显式
`--session`。`web url --path` 也忽略默认 session，不能与显式 `--session` 同用。
`auth`、`targets`、`--help` 和 `--version` 不读取目标文件。

## 操作同一个终端

```sh
kiteline terminal create --name work
# 将返回的 session ID 写入当前目录的 .kiteline.json 后：
kiteline terminal snapshot
kiteline terminal send --text 'pwd; git status --short' --enter
kiteline terminal wait
kiteline terminal snapshot --tail 40
kiteline web url
```

每次调用都是短命令，终端和 Shell 状态持续存在。默认不改变尺寸，`terminal resize
--cols 100 --rows 30` 会改变所有参与者共享的终端。目录浏览、阅读、编辑、Git、构建和
测试直接使用终端中的原生工具；CLI 仅另提供文件传输，不提供 Git 或 task/run 命令。

`send` 恰好选择一个 `--text TEXT`、`--paste TEXT` 或 `--key KEY`。文本与粘贴可加
`--enter`；文字 `Enter` 不会变成回车。具名按键见 `terminal send --help`。粘贴使用
现有 bracketed paste 行为，程序启用此模式时会收到粘贴边界。成功仅表示远端输入操作已
处理，不表示命令执行完成。调用方观察屏幕，决定下一步；没有自动重发、输入独占或完成检测。

`snapshot` 返回当前活动屏。默认 stdout 仅有屏幕文本，按需请求的 normal 历史尾部位于
屏幕之前；两部分实际行数、折行、尺寸、光标和观察位置在 stderr，正文不插入标记。
末尾空行可以省略，内部空行、缩进和物理行保持。`--attrs` 在 stderr 附加非默认样式区间，
可用于判断仅靠高亮区分选中项的 TUI；需要明确区分屏幕与历史或程序处理时用 `--json`。
区间是 0-based cell 列，`end` 不含，不能当字符串字符索引。

```sh
kiteline terminal snapshot --attrs --json > observation.json
kiteline terminal snapshot --attrs --if-changed "$(jq -c .result.position observation.json)"
kiteline terminal send --key Down --if-input "$(jq -r '.result.input | "\(.epoch):\(.inputSeq)"' observation.json)"
```

`--if-changed` 只复用同目标、同观察选项的完整 position；改变 tail/attrs 仍返回完整数据。
`unchanged` 省略屏幕，但仍给当前 inputSeq；seq 推进也不一定意味着可见文字变化。
recorder 换代返回 `reset` 全屏。`--if-input` 是可选的接纳条件：观察后若已有其他输入进入，
返回 conflict；重新观察后由调用方决定是否再发。网页输入计数，本机 tmux 和远程 attach 输入不计数。
新 inputSeq 配旧画面仍可能意味着输入尚未回显，条件通过不保证不会混行。

`wait` 默认等待 300ms 输出安静，总上限 1000ms，可用 `--quiet-ms` 和 `--timeout-ms`
调整，最长 10000ms。`--mode change --after EPOCH:SEQ` 等待输出位置变化，after 可来自
snapshot 或 send.before。quiet/changed/timeout/reset 都返回当前画面；quiet 不表示业务完成。
send/resize 的预算默认 5000ms，亦可用 `--timeout-ms`，范围 1–10000ms。

可选的 Bash 日志示例须先进入 `targets` 所列 workspace 路径，日志才能通过文件能力访问：

```bash
cd '/absolute/workspace/path'
(set +e
  mkdir -p logs || exit
  make test 2>&1 | tee logs/test.log
  rc=${PIPESTATUS[0]}
  printf '\nFOREGROUND_RETURNED rc=%s\n' "$rc"
  exit "$rc"
)
```

必须紧接管道读取 `PIPESTATUS[0]`。该标记只代表这次前台命令返回，不表示它启动的后台
工作完成。CLI 不自动包装输入或解析该标记。

## 文件传输

```sh
kiteline files download 'notes/设计.md' --output ./design.md
kiteline files upload 'notes/设计副本.md' --file ./design.md
kiteline web url --path 'notes/设计副本.md'
```

`PATH` 相对选定 workspace，使用 `/` 分隔，不能是绝对路径或含 `..` 段；本地路径由
`--output` 或 `--file` 明确指定。下载以新建方式写入，不覆盖已有本地文件；失败可能留下
空文件或部分内容，不能当作完整下载。文件内容直接流式传输，成功结果只给 `path`、`size`，
下载另给 `output`；`--json` 不包含文件正文。

上传读取本地普通文件，默认只创建新目标。目标存在时返回 conflict，纯文本诊断及
`--json` 的 `error.details.current.targetVersion` 提供可选择的替换版本。确认要替换后再用：

```sh
kiteline files upload 'notes/设计副本.md' --file ./design.md --replace-version VERSION
```

`VERSION` 是该上传目标的替换条件，不是下载得到的内容 revision。设备在准备上传和发布前
检查版本；这不保证从下载至今无人修改，最后一次检查到发布之间仍可能有外部写入。
上传替换叶节点符号链接本身，下载则跟随该链接。上传结果为 unknown 时可能已发布，先通过
终端或下载观察，再决定下一步；CLI 不自动重传。

在不区分大小写或 Unicode 等价拼写的文件系统中，异拼写可能在使用冲突版本后再次触发
conflict。可通过共享终端核对实际名称，再决定是否替换。

## 交互接续已有终端

在本机终端中接续设备上已有的运行中会话：

```sh
kiteline terminal attach --device DEVICE_ID --workspace WORKSPACE_ID --session SESSION_ID
# 已配置当前目录 .kiteline.json 时：
kiteline terminal attach
```

stdin 和 stdout 都必须是 TTY，不能使用 `--json`。命令复用上述凭据和目标，不新建 Shell，
不自动恢复记录。连接后直接输入；`Ctrl+C` 发给远端程序，`Ctrl+B d` 脱离，
`Ctrl+B [` 进入 tmux 历史复制模式，`Ctrl+B Ctrl+B` 发送前缀键。

Web 和 CLI 共用输入与尺寸，没有输入独占；`--if-input` 不计入 attach 输入。粘贴按
本机终端与 tmux 的原生规则处理。脱离或断线只结束本次连接，原会话继续运行。
输出积压超过[消费预算](reference.md#终端)时该连接会报错结束，重新执行 attach 接续当前画面。

正常脱离、最后输出写完且本机状态恢复后返回 0；这不是远端命令的退出码。输出完全
停止消费时，排空超时以非 0 结束本次 CLI 进程，尚未消费的画面复位无法立即生效。
Linux/macOS 会恢复本机输入模式；Windows 的 PowerShell 入口可能需要等待宿主恢复消费后完成
状态恢复并返回，若宿主一直停读，入口可能持续等待。远端桥会结束，原会话和其他客户端继续。

## Web 接续与记录恢复

`web url` 返回同一终端的链接，不创建交接状态。Web 登录后点击实际终端显示区再输入；
“专注终端”按钮只调整布局。双方的输入与尺寸都影响同一终端，关闭 CLI 不关闭 Shell。
`web url --path PATH` 返回文件链接，仅核实设备/workspace，不检查文件存在或版本。

遇到 `recording_unavailable`，仍可用 attach 接续运行中的会话。需要 Web 或短命令观察时，
先看 `terminal list`，再按需显式 `terminal recover`。
恢复复用同一 pane，可能短暂改变尺寸以重绘，丢失旧 recorder 历史并更换 epoch。返回
`recovering` 只表示受理，后续自行 list/snapshot 观察；CLI 不轮询或重发之前的输入。
目标不匹配的 not_found 不能推断 Shell 已毁。超过 1MiB 的观察返回 limit_exceeded，终端
继续运行；可显式减少 tail/attrs 或尺寸后观察，CLI 不自动裁屏。

## 输出和失败

默认输出适合直接阅读；`--json` 的 stdout 是带 `outcome`、`result` 或 `error.code` 的
结构化回复；交互 attach 不接受 `--json`。提示和诊断使用 stderr，不自动重试。

| 退出码 | 含义                                                               |
| ------ | ------------------------------------------------------------------ |
| 0      | 操作或观察成功。                                                   |
| 1      | 远端明确失败或部分失败；部分结果和诊断仍保留。                     |
| 2      | 本地参数、配置、目标或文件 I/O 错误。                              |
| 3      | 请求可能生效，但未取得确定结果。先观察，再决定下一步，不自动重发。 |

JSON 交互最多等待 30 秒；文件正文传输在连续 120 秒无进度时结束等待。
`--help` 和 `--version` 离线可用。
