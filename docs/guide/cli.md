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
`inspect` 和 `terminal list` 忽略默认 session，不接受显式 `--session`。
`auth`、`targets`、`--help` 和 `--version` 不读取目标文件。

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
