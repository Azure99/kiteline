# 远程 CLI

`kiteline` 使用 Web 签发的设备操作凭据连接 server。设备上的运行与维护仍使用
`kiteline-agent`，server 管理仍使用 `kiteline-server`。从源码构建后，可用
`node cli/dist/main.js` 代替下文的 `kiteline`。

## 接入

在 Web 的“拥有者菜单 → CLI 凭据”中选择设备并签发 token，然后导入：

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
`inspect`、`terminal list` 和 `terminal create` 忽略默认 session，不接受显式 `--session`。
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
测试直接使用终端中的原生工具；CLI 不另提供 Git 或 task/run 命令。

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
返回 conflict；重新观察后由调用方决定是否再发。网页输入计数，本机直接 tmux 输入不计数。
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

## Web 接续与记录恢复

`web url` 返回同一终端的链接，不创建交接状态。Web 登录后点击实际终端显示区再输入；
“专注终端”按钮只调整布局。双方的输入与尺寸都影响同一终端，关闭 CLI 不关闭 Shell。

遇到 `recording_unavailable`，先看 `terminal list`，再按需显式 `terminal recover`。
恢复复用同一 pane，可能短暂改变尺寸以重绘，丢失旧 recorder 历史并更换 epoch。返回
`recovering` 只表示受理，后续自行 list/snapshot 观察；CLI 不轮询或重发之前的输入。
目标不匹配的 not_found 不能推断 Shell 已毁。超过 1MiB 的观察返回 limit_exceeded，终端
继续运行；可显式减少 tail/attrs 或尺寸后观察，CLI 不自动裁屏。

## 输出和失败

默认输出适合直接阅读；`--json` 的 stdout 是带 `outcome`、`result` 或 `error.code` 的
结构化回复。提示和诊断使用 stderr。CLI 没有后台进程、自动重试或隐含交互。

| 退出码 | 含义                                                               |
| ------ | ------------------------------------------------------------------ |
| 0      | 操作或观察成功。                                                   |
| 1      | 远端明确失败或部分失败；部分结果和诊断仍保留。                     |
| 2      | 本地参数、配置、目标或文件 I/O 错误。                              |
| 3      | 请求可能生效，但未取得确定结果。先观察，再决定下一步，不自动重发。 |

HTTP 请求及响应体消费最多等待 30 秒。`--help` 和 `--version` 离线可用。
