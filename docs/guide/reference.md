# 参考

[English](reference.en.md)

本文供部署者查找 `kiteline-server` 与 `kiteline-agent` 的命令行接口、配置、限额数值和报错处理。操作步骤见[部署 server](server.md)、[接入设备](devices.md)和[使用工作台](usage.md)。

## kiteline-server 命令

```text
kiteline-server [serve | setup-token | reset-password] [--data-dir DIR]
kiteline-server --version
```

| 命令或选项       | 作用                                                   |
| ---------------- | ------------------------------------------------------ |
| `serve`          | 启动 server。省略子命令时执行它                        |
| `setup-token`    | 生成新的初始化 token 并只打印 token 本身               |
| `reset-password` | 重设拥有者密码，并使全部登录会话失效                   |
| `--data-dir DIR` | 本次使用的 server 数据目录，优先于 `KITELINE_DATA_DIR` |
| `--version`      | 打印版本号，不能与子命令或 `--data-dir` 同时使用       |

`kiteline-server` 没有 `--help`。未知参数或子命令会打印错误并以状态 1 退出。

- `serve` 只在首次启动时打印一行 `Kiteline setup token: …`；监听成功后打印 `Kiteline listening on http://HOST:PORT`；收到 `SIGINT` 或 `SIGTERM` 后停止。
- `setup-token` 会替换之前的 token，新 token 有效期见[限额](#限额)。拥有者已设置密码后，它报错 `Already initialized`。
- `reset-password` 提示 `New password: `，在终端中输入不回显，按 Enter 提交；也可以从标准输入传入一行密码。初始化之前执行会报错 `Not initialized`。成功时打印 `Password updated. All web login sessions have been invalidated.`
- 除 `--version` 外，每个命令都会把 server 数据目录的权限设为 `0700` 并占用其中的 `process.lock`。server 运行时执行 `setup-token` 或 `reset-password` 会报错 `Lock file is already being held`，因此必须先停止 server。Docker 与原生部署的完整步骤见[重置初始化 token 与密码](server.md#重置初始化-token-与密码)。

Docker 镜像的 `ENTRYPOINT` 是 `kiteline-server`，默认参数是 `serve`，所以 `docker compose run` 之后直接写子命令。在 `compose.yaml` 所在目录执行，并使用与启动时相同的 `KITELINE_VERSION` 和 `KITELINE_IMAGE` 配置。

### 健康检查

`GET /healthz` 返回 `{"status":"ok","version":"<版本>"}`，不需要登录，可用于监控和反向代理的健康检查。

## kiteline-agent 命令

Linux 和 macOS 的命令入口是 `/usr/local/bin/kiteline-agent`；用 `sudo` 执行时写这个绝对路径。Windows 的命令入口是 `%ProgramData%\kiteline-agent\kiteline-agent.ps1`，在 PowerShell 中有两种调用方式：

```powershell
# 短写法
& "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" doctor
# 完整写法
& (Join-Path $PSHOME $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'powershell.exe' } else { 'pwsh.exe' })) -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" doctor
```

在真实控制台中直接交互时可用短写法，执行策略须允许运行本地脚本。需要变量捕获、PowerShell 管道或重定向时使用完整写法；短写法的程序输出不进入 PowerShell 对象管道。完整写法中的 `Bypass` 仅作用于当前进程，组策略仍优先。文档中的 `kiteline-agent <子命令>` 在 Windows 上按用途替换为相应写法。

不带参数或带 `--help` 执行 `kiteline-agent` 会打印子命令概要，`--version` 打印版本号。只有 `schedule` 及其子命令提供 `--help`；其他子命令没有 `--help`，参数以下表为准。

| 命令                      | 选项                                                                        | 执行者        | agent 进程   |
| ------------------------- | --------------------------------------------------------------------------- | ------------- | ------------ |
| `install`                 | `--user PROJECT_USER`；Windows 另有 `--data-dir PATH`、`--run-dir PATH`     | root 或管理员 | 无关         |
| `upgrade`                 | `--archive FILE`（必填）、`--yes`                                           | root 或管理员 | 必须全部停止 |
| `uninstall`               | `--purge-state`、`--yes`                                                    | root 或管理员 | 必须全部停止 |
| `check`                   | 无                                                                          | 项目用户      | 无关         |
| `bind`                    | `--server URL`（必填）、`--if-unbound`                                      | 项目用户      | 必须停止     |
| `run`                     | 无                                                                          | 项目用户      | 由它启动     |
| `doctor`                  | 无                                                                          | 项目用户      | 可选         |
| `attach SESSION_ID`       | `--run-dir DIR`                                                             | 项目用户      | 必须运行     |
| `workspace list`          | 无                                                                          | 项目用户      | 必须运行     |
| `terminal list`           | `--workspace WORKSPACE_ID`                                                  | 项目用户      | 必须运行     |
| `terminal new`            | `--workspace WORKSPACE_ID`（必填）、`--shortcut SHORTCUT_ID`、`--no-attach` | 项目用户      | 必须运行     |
| `terminal end SESSION_ID` | 无                                                                          | 项目用户      | 必须运行     |
| `schedule …`              | 见[定时任务的命令行](scheduled-tasks.md#命令行)                             | 项目用户      | 必须运行     |

表中的项目用户指安装时记录的账户。安装后以其他账户执行会报错 `Use project user PROJECT_USER to run this command`。

### 安装与维护

安装、升级和卸载的步骤、前提及数据影响分别见[手工安装](devices.md#手工安装)、[升级 agent](devices.md#升级-agent)和[卸载](devices.md#卸载)。

### 绑定与运行

- `check` 检查随包组件、[系统前提](devices.md#支持的系统与准备)、数据及运行目录是否可写，以及运行目录的路径长度。全部通过时打印 `Setup checks passed.`，否则列出失败项并以非零状态退出。
- `bind --server URL` 用一次性绑定码把这台机器登记为设备。绑定码在终端中由 `Binding code: ` 提示输入，或从标准输入读入一行。`URL` 必须是 `http://` 或 `https://` 地址，agent 只保存其中的协议、主机和端口；设备名取主机名。`--if-unbound` 在已经绑定时报错退出，不改动已有身份。
- `run` 在前台运行 agent，连接 server 并开始执行定时任务。Linux 和 macOS 收到 `SIGINT`、`SIGTERM` 或 `SIGHUP` 时停止，Windows 收到 Ctrl-C 或 Ctrl-Break 时停止。正常停止会结束全部终端会话和正在运行的定时任务。后台常驻见[后台运行](devices.md#后台运行)。
- `doctor` 输出 `[ok]`、`[warn]`、`[error]` 三类检查结果，有 `[error]` 时以状态 1 退出。agent 正在运行时，它报告 agent 实际的环境：版本、server 连接、recorder、定时任务、Git 配置来源和 `SSH_AUTH_SOCK`；agent 未运行时只检查安装和配置文件，并提示 `Runtime environment has not been checked`。

### 终端与工作区

- `workspace list` 每行输出 `WORKSPACE_ID`、名称和路径，以 Tab 分隔。工作区只能在网页中添加或移除。
- `terminal list` 每行输出 `SESSION_ID`、`WORKSPACE_ID`、状态和名称；`--workspace` 只列出该工作区的会话。
- `terminal new` 打印新会话的 `SESSION_ID`，然后附着到它；`--no-attach` 只创建不附着。`--shortcut` 用快捷方式启动：新设备预置的快捷方式 ID 是 `claude`、`codex` 和 `opencode`；在“终端设置”中新增的快捷方式使用随机 ID，可在 agent 数据目录的 `agent.json` 的 `shortcuts` 中查到。
- `terminal end SESSION_ID` 不经确认直接结束会话及其中的程序。
- `attach SESSION_ID` 在当前终端附着到会话，按 `Ctrl-b d` 断开。附着需要交互终端；在容器中用 `docker exec -it`。`--run-dir` 指定运行目录，优先于环境变量。网页的“本机接续命令”已经包含正确的入口和运行目录。使用方法见[终端](usage.md#终端)。

## server 环境变量

| 变量                         | 默认值              | 说明                                              |
| ---------------------------- | ------------------- | ------------------------------------------------- |
| `KITELINE_LISTEN_ADDR`       | `127.0.0.1:8080`    | 监听地址，格式 `HOST:PORT`，IPv6 写成 `[::]:8080` |
| `KITELINE_DATA_DIR`          | `/var/lib/kiteline` | server 数据目录                                   |
| `KITELINE_TRUST_PROXY_PROTO` | `0`                 | 设为 `1` 时采用反向代理传入的 `X-Forwarded-Proto` |

- `KITELINE_LISTEN_ADDR` 省略端口时监听 80 端口。Docker 镜像把它设为 `0.0.0.0:8080`；仓库中的 systemd 示例把它设为 `127.0.0.1:8080`，可在 `/etc/kiteline-server.env` 中覆盖。
- `KITELINE_TRUST_PROXY_PROTO` 只接受 `0` 和 `1`，其他值使 server 启动失败并报错 `KITELINE_TRUST_PROXY_PROTO must be 0 or 1`。何时设为 `1` 见 [HTTPS 与反向代理](server.md#https-与反向代理)。

仓库原版 `deploy/compose.yaml` 另外读取以下变量：

| 变量                         | 默认值                     | 说明                                                     |
| ---------------------------- | -------------------------- | -------------------------------------------------------- |
| `KITELINE_VERSION`           | 无                         | 镜像标签，官方镜像为发布版本，本地构建为 `<版本>-<架构>` |
| `KITELINE_IMAGE`             | `ghcr.io/azure99/kiteline` | 镜像路径，可改为本地 `kiteline-server` 或 fork 镜像      |
| `KITELINE_HTTP_BIND`         | `127.0.0.1`                | 主机上发布端口所用的地址                                 |
| `KITELINE_HTTP_PORT`         | `8080`                     | 主机上发布的端口，映射到容器内的 8080                    |
| `KITELINE_TRUST_PROXY_PROTO` | `0`                        | 传给容器内的 server                                      |

必须设置 `KITELINE_VERSION`，否则 Compose 报错 `Set KITELINE_VERSION to the release version`。Compose 使用 `KITELINE_IMAGE:KITELINE_VERSION`，不读取 `KITELINE_ARCH`；原生包下载示例中的 `KITELINE_ARCH` 仍用于选择归档。

## agent 环境变量

| 变量                     | 默认值                                                                                                | 说明           |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | -------------- |
| `KITELINE_AGENT_HOME`    | Linux、macOS：`<项目用户 HOME>/.local/share/kiteline-agent`；Windows：`%LOCALAPPDATA%\kiteline-agent` | agent 数据目录 |
| `KITELINE_AGENT_RUN_DIR` | `<agent 数据目录>/run`                                                                                | 运行目录       |

目录按以下顺序确定，先找到的生效：

1. 进程环境变量 `KITELINE_AGENT_HOME`、`KITELINE_AGENT_RUN_DIR`。`attach --run-dir` 对运行目录的优先级更高。
2. Linux 和 macOS 读取 `/etc/kiteline-agent.env`；Windows 读取安装记录 `installation.json` 中由 `install` 写入的目录。
3. 上表的默认值。Linux 和 macOS 的 HOME 取自安装记录中的项目用户，与执行命令时的 `HOME` 无关。

`run`、本机命令和后台服务必须解析到同一组目录，否则本机命令找不到正在运行的 agent。运行目录路径的长度有上限（见[限额](#限额)），超出时报错 `KITELINE_AGENT_RUN_DIR is too long`。

执行网页生成的接入命令（以及 Windows 上的升级命令）前，在当前 Shell 中取消这两个变量，否则命令报错 `… uses the installation configuration`。自定义目录在 Linux 和 macOS 上写入[目录配置文件](#目录配置文件)，在 Windows 上由 `install` 的 `--data-dir`、`--run-dir` 决定。

### 目录配置文件

`install` 在文件不存在时创建它，写入一行注释和 `KITELINE_AGENT_HOME`；文件已存在时内容不变。无论哪种情况，`install` 都把属主设为 `root`、属组设为项目用户的主组、权限设为 `0640`，修改需要 root 权限。agent 只读取 `KITELINE_AGENT_HOME` 和 `KITELINE_AGENT_RUN_DIR` 两个键，其他行被忽略：

```sh
# 替换为实际目录
KITELINE_AGENT_HOME="/srv/kiteline/agent"
KITELINE_AGENT_RUN_DIR="/srv/kiteline/run"
```

每个键最多出现一次，整行必须是 `KEY="/绝对路径"`：从行首开始，不加 `export`，路径用双引号包住，不含引号、反斜杠或行尾注释。格式不符时，agent 的各个命令都会报错并给出这条规则。服务的其他环境变量在服务配置中设置，见[后台运行](devices.md#后台运行)。

### 其他变量

| 变量                                                            | 作用                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`、`NO_PROXY` 及小写形式 | agent 连接 server 时使用的出站代理，见[出站代理与证书](devices.md#出站代理与证书)                                   |
| `NODE_EXTRA_CA_CERTS`                                           | server 使用私有 CA 签发的证书时，指定 CA 证书文件（仅 Linux、macOS），见[出站代理与证书](devices.md#出站代理与证书) |
| `LANG`、`LC_ALL`、`LC_CTYPE`                                    | `check` 和 `doctor` 要求字符集为 UTF-8                                                                              |
| `PATH`                                                          | agent 从中查找 Git、SSH 和 Windows 的 `pwsh.exe`                                                                    |
| `SSH_AUTH_SOCK`                                                 | Linux、macOS 上的 `doctor` 检查它指向可访问的 socket；Git 通过它使用 SSH agent                                      |

终端会话和定时任务继承 agent 进程的环境。修改环境后需要重启 agent 才生效。

## agent 配置文件

`config.json` 位于 agent 数据目录，agent 不会自动创建它。文件是一个 JSON 对象，可包含 `shell` 和 `limits` 两个键，都可省略：

```json
{
  "shell": "/bin/bash",
  "limits": {
    "editorBytes": 4194304,
    "taskRunsPerDevice": 8
  }
}
```

`run` 只在启动时读取这个文件，修改后重启 agent 才生效。其他读取配置的命令（如 `bind`、`terminal`、`schedule`）在文件无效时也会报错；值无效时报错 `Invalid <键名>`，`doctor` 在 agent 未运行时把它列为 `Configuration on disk` 错误。

### shell

`shell` 是终端会话和定时任务使用的 Shell，必须是绝对路径。默认值：Linux 和 macOS 取项目用户在系统账户数据库中的登录 Shell，取不到时用 `/bin/sh`；Windows 优先使用 `PATH` 中的 `pwsh.exe`，只有找不到时才使用系统 Windows PowerShell 5.1。找到但版本不支持或无法运行的 `pwsh.exe` 会报错，显式配置的 Shell 也不会回退。

未配置 `shell` 时，安装或移除 `PATH` 中的 pwsh 会在 agent 重启后改变默认 Shell 和任务语义。需要固定时，在此配置绝对路径。

| 用途     | Linux、macOS        | Windows                                             |
| -------- | ------------------- | --------------------------------------------------- |
| 终端会话 | `SHELL -l`          | `SHELL -NoLogo`                                     |
| 快捷方式 | `SHELL -lc COMMAND` | `SHELL -NoLogo -Command COMMAND`                    |
| 定时任务 | `SHELL -c COMMAND`  | `SHELL -NoProfile -NonInteractive -Command COMMAND` |

Windows 上支持 Windows PowerShell 5.1 Desktop 和 PowerShell 7.4 及以上 7.x 版本，`check` 和 agent 启动时都会核对。定时任务的执行环境见[执行环境](scheduled-tasks.md#执行环境)。

### limits

`limits` 中的每个值都是不小于 1 的整数。名称以 `Bytes` 结尾的单位是字节，以 `Timeout` 结尾的单位是毫秒，`imagePixels` 是像素数，其余是个数。`tasksPerDevice` 最大 300，`rpcTimeout` 最大 2147482647，其他 `*Timeout` 最大 2147483647，其余键没有上限。未列出的键被忽略。可用的键、默认值和含义见[限额](#限额)。

调低 `tasksPerDevice` 只限制新建任务，已有任务仍可管理。调低输出限额只影响之后写入的输出。

### agent 管理的文件

agent 数据目录中的 `agent.json`、`connection.json`、`temporary-files.json` 和 `tasks/` 由 agent 读写，不要手工编辑。工作区、快捷方式和“新会话滚屏行数”保存在 `agent.json` 中，在网页的工作区管理和“终端设置”中修改。

## 限额

本节列出配置、容量和排错所需的限额。配置列给出 `config.json` 中 `limits` 的键名（见 [agent 配置文件](#agent-配置文件)）；不能配置的项标为固定。

### 登录与绑定

| 项目                | 值                                             | 配置 |
| ------------------- | ---------------------------------------------- | ---- |
| 初始化 token 有效期 | 30 分钟                                        | 固定 |
| 绑定码有效期        | 10 分钟                                        | 固定 |
| 登录有效期          | 30 天，从登录时起算，使用期间不延长            | 固定 |
| 拥有者密码          | 8 至 72 字节（UTF-8）                          | 固定 |
| 登录与初始化尝试    | 每个来源每分钟 10 次，全部来源合计每分钟 30 次 | 固定 |
| 绑定尝试            | 与登录相同，单独计数                           | 固定 |

来源是连到 server 的 TCP 对端地址。经同一个反向代理地址接入的请求共用一个来源额度。

### 终端

| 项目                   | 值                              | 配置                        |
| ---------------------- | ------------------------------- | --------------------------- |
| 每台设备的终端会话     | 32                              | `terminalSessionsPerDevice` |
| 单次粘贴和待发送的输入 | 256 KiB                         | `terminalInputBytes`        |
| 新会话滚屏行数         | 默认 10,000，可设 0 至 50,000   | 网页“终端设置”              |
| 浏览器停止处理输出     | 10 秒后断开该显示，会话继续运行 | `terminalStallTimeout`      |
| 运行目录路径           | 76 字节（UTF-8）                | 固定                        |

### 文件

| 项目                 | 值                                | 配置                        |
| -------------------- | --------------------------------- | --------------------------- |
| 文本打开、编辑与保存 | 2 MiB，按保存时的编码和换行符计算 | `editorBytes`               |
| 单个文件上传或下载   | 1 GiB                             | `transferBytes`             |
| 同时进行的文件传输   | 4                                 | `transfersPerDevice`        |
| 图片预览             | 20 MiB，且不超过 20,000,000 像素  | `imageBytes`、`imagePixels` |
| 传输无进展超时       | 120 秒                            | 固定                        |
| 每次复制、移动或删除 | 500 项                            | 固定                        |
| 搜索结果             | 1,000 条                          | 固定                        |
| 搜索时长             | 10 秒，超时返回已找到的结果       | `searchTimeout`             |

文本打开、保存、图片预览、上传和下载都占用同时进行的文件传输名额。

### Git

| 项目                           | 值                                 | 配置              |
| ------------------------------ | ---------------------------------- | ----------------- |
| 单次暂存、取消暂存或丢弃的路径 | 1,000 个                           | 固定              |
| 单个 Diff 内容                 | 约 512 KiB，超出部分截断           | 固定              |
| Diff 结构化显示                | 2,000 行；超出时显示前 32 KiB 原文 | 固定              |
| 写操作时限                     | 10 分钟                            | `gitWriteTimeout` |
| 读取操作时限                   | 30 秒                              | `rpcTimeout`      |

写操作包括暂存、取消暂存、丢弃、提交、分支操作、fetch、pull、push，以及继续或中止进行中的操作。

### 定时任务

| 项目                     | 值                           | 配置                   |
| ------------------------ | ---------------------------- | ---------------------- |
| 每台设备的任务数         | 100                          | `tasksPerDevice`       |
| 每台设备同时运行         | 4，待核查的运行也占名额      | `taskRunsPerDevice`    |
| 每个任务保留的已结束记录 | 20，含已跳过的记录           | `taskHistoryRuns`      |
| 每次运行的输出           | 1 MiB，stdout 与 stderr 合计 | `taskOutputBytes`      |
| 设备上保留的输出总量     | 128 MiB                      | `taskOutputTotalBytes` |
| 任务名称                 | 256 字节（UTF-8）            | 固定                   |
| 命令                     | 16 KiB                       | 固定                   |
| Cron 表达式              | 256 个字符                   | 固定                   |
| 计划时刻的迟到容差       | 5 秒                         | 固定                   |
| 停止时从 TERM 到 KILL    | 5 秒                         | 固定                   |

### 连接与请求

| 项目                   | 值                                              | 配置         |
| ---------------------- | ----------------------------------------------- | ------------ |
| 一般设备操作时限       | 30 秒                                           | `rpcTimeout` |
| 每台设备同时处理的请求 | 32                                              | 固定         |
| 每台设备的数据通道     | 128，终端显示、文件传输和开发服务请求合计       | 固定         |
| 单条请求或结果         | 1 MiB；请求超出返回 413，结果超出时为结果未确认 | 固定         |

一般设备操作包括文件列表与重命名、Git 读取、定时任务管理和本机命令行请求。复制、移动和删除没有总时限。

## 文件位置

### Linux 和 macOS 上的 agent

| 路径                                                | 内容                                           |
| --------------------------------------------------- | ---------------------------------------------- |
| `/opt/kiteline-agent/`                              | 程序目录，属主 root                            |
| `/usr/local/bin/kiteline-agent`                     | 命令入口                                       |
| `/etc/kiteline-agent.json`                          | 安装记录：项目用户、UID、GID、HOME             |
| `/etc/kiteline-agent.env`                           | 目录配置，见 [agent 环境变量](#agent-环境变量) |
| `/opt/.kiteline-agent-use.lock`                     | 使用锁，每个 `kiteline-agent` 命令运行时持有   |
| `/opt/.kiteline-agent-install.lock`                 | 安装、升级、卸载的互斥锁                       |
| `/opt/kiteline-agent/deploy/kiteline-agent.service` | systemd 示例（Linux 包）                       |
| `/opt/kiteline-agent/deploy/kiteline-agent.plist`   | launchd 示例（macOS 包）                       |

卸载后留下的文件见[卸载](devices.md#卸载)。升级失败且旧程序无法自动恢复时，输出会给出 `/opt` 下保留的备份目录。

### Windows 上的 agent

| 路径                                                      | 内容                           |
| --------------------------------------------------------- | ------------------------------ |
| `%ProgramFiles%\kiteline-agent\`                          | 程序目录                       |
| `%ProgramData%\kiteline-agent\kiteline-agent.ps1`         | 命令入口                       |
| `%ProgramData%\kiteline-agent\installation.json`          | 安装记录，含数据目录与运行目录 |
| `%ProgramData%\kiteline-agent\use.lock`                   | 使用锁                         |
| `%ProgramData%\kiteline-agent\management.lock`            | 安装、升级、卸载的互斥锁       |
| `%ProgramFiles%\kiteline-agent\deploy\kiteline-agent.xml` | WinSW 示例                     |
| `%LOCALAPPDATA%\kiteline-agent\`                          | 默认的 agent 数据目录          |

### agent 数据目录

| 文件                               | 内容                                                       |
| ---------------------------------- | ---------------------------------------------------------- |
| `agent.json`                       | 工作区、快捷方式、终端设置                                 |
| `connection.json`                  | server 地址、设备 ID 和设备凭据，权限 `0600`               |
| `config.json`                      | 手工创建的配置，见 [agent 配置文件](#agent-配置文件)       |
| `temporary-files.json`             | 文件写入过程中的临时文件登记                               |
| `tasks/`                           | 定时任务：`TASK_ID.json`、`RUN_ID.stdout`、`RUN_ID.stderr` |
| `process.lock`                     | agent 运行或绑定时持有的锁                                 |
| `run/`                             | 默认的运行目录                                             |
| `launchd.log`、`launchd-error.log` | 使用 launchd 示例时的日志                                  |

数据目录权限为 `0700`（Windows 上只允许项目用户、SYSTEM 和管理员访问）。备份设备时保留 `connection.json`、`agent.json`、`config.json` 和 `tasks/`。

### 运行目录

| 文件                   | 内容                                              |
| ---------------------- | ------------------------------------------------- |
| `agent.sock`           | 本机命令连接 agent 的 socket（Linux、macOS）      |
| `agent.sock.lock`      | 同一运行目录只允许一个 agent 的锁（Linux、macOS） |
| `SESSION_ID/tmux.sock` | 该终端会话的 tmux socket                          |
| `SESSION_ID/tmux.conf` | 该终端会话的 tmux 配置                            |
| `SESSION_ID/pane.json` | 该终端会话的启动参数和环境变量（Windows）         |

会话结束时 agent 删除它的 `SESSION_ID/` 目录。Windows 的运行目录中只有会话目录，本机命令通过命名管道连接 agent。

### server

| 路径                                       | 内容                                             |
| ------------------------------------------ | ------------------------------------------------ |
| `/opt/kiteline-server/`                    | 原生包的程序目录                                 |
| `/opt/kiteline-server/bin/kiteline-server` | 原生包的命令入口                                 |
| `/etc/kiteline-server.env`                 | 原生部署的环境变量文件                           |
| `/var/lib/kiteline/kiteline.sqlite`        | 数据库，WAL 模式，运行时另有 `-wal`、`-shm` 文件 |
| `/var/lib/kiteline/process.lock`           | server 和维护命令运行时持有的锁                  |

Docker 部署中，server 数据目录是容器内的 `/var/lib/kiteline`，对应 Compose 卷 `kiteline_server-data`。备份方法见[备份与恢复](server.md#备份与恢复)。

## 常见问题

报错原文是英文；表中引用的是其中的关键部分。

| 现象或报错                                                                           | 原因                                                                                          | 处理                                                                             |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 设备显示“版本不匹配”；agent 日志 `HTTP 426. agent version … does not match server …` | agent 与 server 版本不同                                                                      | [升级 agent](devices.md#升级-agent)                                              |
| 网页提示“Web … / Server …：远程操作已暂停。”                                         | server 升级后，打开中的页面还是旧版本                                                         | 复制未保存的内容后点“刷新页面”                                                   |
| 初始化或登录时提示“该请求未获允许。” `[forbidden] Origin mismatch`                   | 未设置 `KITELINE_TRUST_PROXY_PROTO=1`，或反向代理改写了 `Host`                                | 改正后重启 server，见 [HTTPS 与反向代理](server.md#https-与反向代理)             |
| 400 `Invalid X-Forwarded-Proto`                                                      | 反向代理追加而非覆盖该头，或值不是单个 `http` 或 `https`                                      | 让反向代理用 `https` 覆盖该头，见 [HTTPS 与反向代理](server.md#https-与反向代理) |
| 网页能打开，但终端无法连接、设备一直离线                                             | 反向代理没有转发 WebSocket Upgrade                                                            | 开启 WebSocket 转发，见 [HTTPS 与反向代理](server.md#https-与反向代理)           |
| 下载或开发服务页面长时间无响应、大文件上传失败                                       | 反向代理缓冲了响应或请求，或限制了上传大小                                                    | 关闭缓冲、放开上传大小，见 [HTTPS 与反向代理](server.md#https-与反向代理)        |
| 400 `Invalid Host header`                                                            | 请求有多个 Host 头，或 Host 含非法字符                                                        | 检查反向代理的 Host 设置                                                         |
| `Setup credentials are invalid or expired`                                           | token 输错或已过期                                                                            | 生成新 token，见[重置初始化 token 与密码](server.md#重置初始化-token-与密码)     |
| `Already initialized`                                                                | 已设置拥有者密码，`setup-token` 只能在此之前使用                                              | 用 `reset-password`                                                              |
| `Lock file is already being held`                                                    | 同一数据目录上已有 server 或 agent 在运行                                                     | 先停止正在运行的进程                                                             |
| 429 `Too many attempts; try again later`                                             | 一分钟内尝试次数超限                                                                          | 等待一分钟后重试                                                                 |
| `Binding code is invalid, expired, or already used`                                  | 绑定码已过期或已被使用                                                                        | 在网页重新生成命令，见[用网页命令接入](devices.md#用网页命令接入)                |
| `This installation is already bound`                                                 | 接入命令带 `--if-unbound`，而设备已经绑定                                                     | 直接 `kiteline-agent run`；要重新绑定见[重新绑定](devices.md#重新绑定)           |
| `Binding result is unknown`                                                          | 绑定请求发出后连接中断                                                                        | 在网页核对设备列表，见[重新绑定](devices.md#重新绑定)                            |
| `Device is not bound; run kiteline-agent bind`                                       | agent 数据目录中没有 `connection.json`                                                        | 绑定，或检查 `KITELINE_AGENT_HOME` 是否指向原目录                                |
| agent 日志 `HTTP 401. Invalid device credentials`，随后 `Remote connection stopped`  | 设备已在网页删除，或凭据属于另一个 server                                                     | [重新绑定](devices.md#重新绑定)                                                  |
| `Remote connection stopped: … (4003: device_deleted)`                                | 设备在网页中被删除                                                                            | [重新绑定](devices.md#重新绑定)                                                  |
| `Remote connection stopped: … (4001: connection_replaced)`                           | 另一个使用相同凭据的 agent 连上了 server，常见于复制了数据目录的机器或容器                    | 见[重新绑定](devices.md#重新绑定)                                                |
| `UTF-8 locale: Character map is …`                                                   | 启动环境的 locale 不是 UTF-8                                                                  | 设置已安装的 UTF-8 locale，见[支持的系统与准备](devices.md#支持的系统与准备)     |
| `git: spawn git ENOENT`                                                              | 启动环境的 `PATH` 中没有 Git                                                                  | 安装 Git 或修正 `PATH`，见[支持的系统与准备](devices.md#支持的系统与准备)        |
| `git: Native executable not found in the current PATH: git`                          | Windows 上启动环境的 `PATH` 中没有 Git                                                        | 安装 Git 或修正 `PATH`                                                           |
| `Agent installation is busy`；Windows 上为 `Installation is busy`                    | 升级或卸载时仍有 `kiteline-agent` 进程在使用这份安装                                          | 停止 `run`、`attach` 和服务后重试，见[升级 agent](devices.md#升级-agent)         |
| `… uses the installation configuration`                                              | 执行接入命令的 Shell 中设置了 `KITELINE_AGENT_HOME` 或 `KITELINE_AGENT_RUN_DIR`               | 取消这两个变量；自定义目录的设置方法见 [agent 环境变量](#agent-环境变量)         |
| 本机命令报 `connect ENOENT …/agent.sock` 或 `connect ECONNREFUSED …/agent.sock`      | agent 未运行（ECONNREFUSED 表示 agent 异常退出后留下了旧 socket），或命令解析到不同的运行目录 | 启动 agent；确认用户和目录与 `run` 一致                                          |
| `Device channel limit reached`                                                       | 该设备上同时打开的终端显示、文件传输和开发服务请求达到上限                                    | 关闭不用的终端显示和页面                                                         |
| agent 异常退出后留下终端会话                                                         | agent 被强制结束或崩溃时不清理终端会话                                                        | 见[清理遗留的终端会话](#清理遗留的终端会话)                                      |
| “此设备的任务存储不可用。”                                                           | agent 无法读取 `tasks/` 中的文件                                                              | 见 [agent 重启后的核查](scheduled-tasks.md#agent-重启后的核查)                   |

agent 正在运行时，`kiteline-agent doctor` 会显示 server 连接状态和最近一次连接错误，是排查设备离线的第一步。

### 清理遗留的终端会话

agent 被强制结束或崩溃时（Windows 上包括直接关闭前台 agent 的 PowerShell 窗口），不会清理它的终端会话：

- Linux 和 macOS：每个会话的 tmux server 是独立的守护进程，agent 异常退出后它和其中的程序继续运行，新启动的 agent 不接管它们。使用示例 systemd 单元时，agent 主进程一旦退出（包括崩溃），systemd 就按 `KillMode=control-group` 结束这些 tmux server；前台运行、使用 launchd，或容器在 agent 退出后仍继续运行时，它们会留下来。以 agent 为主进程的容器（例如[在容器中运行](devices.md#在容器中运行)中的示例）在 agent 退出时整体停止，其中的进程一并结束。
- Windows：会话中的程序随 agent 一起结束，但会话目录留在运行目录中。其中的 `pane.json` 保存了 agent 的完整环境变量，可能含有令牌等敏感信息。

清理前先确认没有 agent 在使用这个运行目录：`kiteline-agent terminal list` 报 `connect ENOENT` 或 `connect ECONNREFUSED`。

Linux 和 macOS 上以项目用户执行：

```sh
RUN_DIR="$HOME/.local/share/kiteline-agent/run"     # 替换为实际运行目录
TMUX_BIN=/opt/kiteline-agent/dist/native/bin/tmux   # 未安装时替换为解包目录下的 dist/native/bin/tmux
if [ -x "$TMUX_BIN" ]; then
  for socket in "$RUN_DIR"/*/tmux.sock; do
    [ -S "$socket" ] || continue
    "$TMUX_BIN" -S "$socket" kill-server 2>/dev/null
    if "$TMUX_BIN" -S "$socket" list-sessions 2>&1 | grep -q 'no server running'; then
      rm -r -- "$(dirname -- "$socket")"
    fi
  done
else
  echo "tmux not found: $TMUX_BIN" >&2
fi
```

`kill-server` 会结束会话中的程序；脚本只在确认 server 已不存在（`no server running`）时才删除会话目录。没有 `tmux.sock` 的会话目录可以直接删除。需要保留某个会话中的程序时，先用 `"$TMUX_BIN" -S <socket> attach-session -t kiteline` 附着进去处理，再执行脚本。

Windows 上以项目用户在 PowerShell 中执行，删除运行目录中的会话目录：

```powershell
$RunDir = "$env:LOCALAPPDATA\kiteline-agent\run"   # 替换为实际运行目录
Get-ChildItem -LiteralPath $RunDir -Directory |
  Where-Object Name -Match '^[0-9a-f]{16}$' |
  Remove-Item -Recurse -Force
```
