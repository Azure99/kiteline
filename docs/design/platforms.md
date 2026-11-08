# 平台实现

本文说明 agent 在 Linux、macOS 和 Windows 上的运行差异。三个平台共用的安装、锁和运行规则见[agent 安装与运行](agent-lifecycle.md)。支持的系统见[接入设备](../guide/devices.md#支持的系统与准备)，固定构建输入见 [release/README.md](../../release/README.md)，构建流程见[构建与发布](../development/release.md)。

## 安装入口的生成

`installer/` 中的文件按以下三种方式进入运行环境：

| 类别     | 文件                                                                              | 渲染者、时机与去向                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 组包模板 | `kiteline-agent.in.sh`、`kiteline-agent.in.ps1`、`launcher.in.cs`、`kiteline.ps1` | [`scripts/agent-launcher.ts`](../../scripts/agent-launcher.ts) 在组包时生成 portable/installed 两个 agent 入口和 Windows 的 CLI 入口；C# 内嵌在 PowerShell 中，在入口运行时由 `Add-Type` 编译。Windows 入口使用的 Node 环境变量键取自构建后的 shared/terminal/node 模块。 |
| 请求模板 | `connect.in.sh`、`upgrade.in.sh`、`windows-entry.in.ps1`                          | [`packages/server/src/agent-installation.ts`](../../packages/server/src/agent-installation.ts) 在请求时填入版本、入口地址与模式，返回 `/connect.sh`、`/upgrade.sh`、`/connect.ps1` 或 `/upgrade.ps1`。                                                                    |
| 原样分发 | `install.sh`、`install.ps1`、`kiteline-server`、`kiteline`                        | [`scripts/package.mjs`](../../scripts/package.mjs) 将安装器复制到 server 的 downloads，供 `/install.sh`、`/install.ps1` 分发；`kiteline-server` 复制到 server 包的 `bin/kiteline-server`，`kiteline` 复制到 Linux 和 macOS 的 agent 包与 CLI 包的 `bin/kiteline`。        |

## Linux

### 随包组件

同一架构的发布包用于全部受支持发行版。随包 Node、tmux、ripgrep、PTY 桥和文件 helper 都静态链接 musl，不依赖目标机的 libc 或动态库。原生组件构建记录 `dist/native/identity.json` 的 `linkage` 为 `static-musl`，doctor 据此跳过动态库检查。包内 terminfo 的兼容方式见下节。

静态 musl 程序不加载 glibc 的 NSS 模块，只能从 `/etc/passwd`（以及 nscd）读取账户信息。agent 默认用账户的登录 Shell（`os.userInfo()`），账户只存在于 LDAP、SSSD 等目录服务且无法经 nscd 取得时，读取会失败，此时在 `config.json` 中设置 `shell`（见 [agent 配置文件](../guide/reference.md#agent-配置文件)）。

### terminfo

pane 中的 `TERM` 是 `tmux-256color`。

agent 启动 tmux 时设置 `TERMINFO_DIRS`，依次为随包现代目录、随包兼容目录、用户原有的 `TERMINFO_DIRS`，最后一项为空，表示系统默认目录。tmux server 和 pane 中的程序继承这个值。`TERMINFO` 和 `~/.terminfo` 的优先级不变。`check` 用 `infocmp -x tmux-256color` 在同样的设置下检查，因此需要系统提供 `infocmp`。

### 系统接口

- 锁：命令入口和 agent 用系统的 `flock` 命令取得管理锁和使用锁（见[锁](agent-lifecycle.md#锁)）。
- 不覆盖的重命名：文件的新建发布、重命名、移动和上传等不能覆盖目标的步骤调用 `rename-noreplace`，它使用 `renameat2(RENAME_NOREPLACE)`。内核或文件系统不支持这个调用时，这些文件操作失败并报告系统错误。`check` 只确认程序能启动，不能提前发现这种情况。文件语义见[文件](files.md#整理操作)。
- 进程组：定时任务和 Git 子进程各自在独立的进程组中运行。停止时向进程组发送 SIGTERM，宽限期后发送 SIGKILL。离开原进程组的后代进程不在停止范围内。各自的停止规则见[定时任务](scheduled-tasks.md#执行与停止)和 [Git](git.md#写操作)。
- 端口建议的来源见[开发服务访问](http-access.md#端口建议)。

### 服务

示例 systemd 单元在 `<程序目录>/deploy/kiteline-agent.service`，使用 `KillMode=control-group` 和 `TimeoutStopSec=45`：停止服务时 systemd 同时向该单元 cgroup 中的全部进程（agent、tmux server、pane 中的程序和定时任务）发送 SIGTERM，45 秒后对仍存在的进程发送 SIGKILL。agent 主进程异常退出时，systemd 同样按 `KillMode=control-group` 结束 cgroup 中的其余进程，然后按 `Restart=on-failure` 重启。示例通过 `EnvironmentFile=-/etc/kiteline-agent.env` 加载目录配置；systemd 会加载文件中的所有变量，而 agent 只解析其中的两个目录项。配置步骤见[接入设备](../guide/devices.md#后台运行)。

## macOS

### 随包组件

发布包在对应架构的 macOS 主机上构建，部署目标取自 [`release/agent-macos.json`](../../release/agent-macos.json) 的 `deploymentTarget`。构建检查每个 Mach-O 文件的最低系统版本及直接依赖；直接依赖只能位于 `/usr/lib` 或 `/System/Library` 下，随包程序不依赖 Homebrew。

- 随包 `flock` 来自 discoteq/flock，构建时确认使用 `flock(2)`，而不是 `fcntl` 锁。

### 文件名与进程组

- APFS 默认不区分大小写。文件操作在请求边界上用 `entry-name` 逐级取得路径中每一段在磁盘上保存的名称，把请求中的路径换成磁盘上的写法，避免同一文件因大小写不同被当作两个路径；`.git` 的大小写变体按是否为同一个文件系统对象识别。细节见[文件](files.md#路径与列表)。
- 进程组停止与 Linux 相同（SIGTERM，宽限期后 SIGKILL）。

### LaunchDaemon

示例在 `<程序目录>/deploy/kiteline-agent.plist`，没有 `KeepAlive`，`ExitTimeOut` 为 45 秒。安装、升级和卸载从不加载、替换或删除 `/Library/LaunchDaemons/` 中的 plist；运行中的服务持有使用锁，维护前要先停止它。配置和停止步骤见[接入设备](../guide/devices.md#后台运行)。

## Windows

### 组成

agent、recorder 和 pane 的启动脚本运行在随包的原生 Windows Node 中。私有 MSYS2 运行时供 tmux 与同源 PTY 桥使用，不修改用户的 `PATH`，也不使用用户 Git 自带的 MSYS；文件与进程等系统能力由 `native/windows/` 的原生 addon 提供。ripgrep 使用随包的原生 Windows 版本。

私有 MSYS2 运行时中的 tmux 应用 [`native/tmux/series`](../../native/tmux/series) 的共用补丁和 Windows 专用的 [`cygwin-outfd.patch`](../../native/tmux/cygwin-outfd.patch)，后者让 Cygwin 构建重新打开客户端终端后同时更新输出描述符，控制模式的输出依赖它。runtime DLL 从固定源码重建并应用 [`ctrl-c.patch`](../../native/msys/ctrl-c.patch)，避免 ConPTY 的 Ctrl+C 在输出背压时阻塞于不必要的 console 附着，维护要求见 [MSYS2](../development/release.md#msys2)。文件清单见 [`scripts/windows-components.ts`](../../scripts/windows-components.ts)，所属软件包的来源、版本、校验值和源码归档固定在 [`release/agent-windows.json`](../../release/agent-windows.json)；包内不带 pacman 或编译器。

### 进程集合

agent 和 recorder 在 Windows 上启动的每个进程（tmux server 和每次 tmux 调用、recorder、控制客户端、远程附着客户端、Git、ripgrep、定时任务和检查命令）都放在自己的 Job 对象中（`packages/shared/src/windows/job.ts`）：

- Job 设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不允许子进程脱离。进程以挂起状态直接创建在 Job 中，再恢复运行，不存在先运行、后加入的间隙。
- 一个进程集合结束的判断是：主进程已退出，且 Job 中的活动进程数为 0。只看主进程退出不够。
- 查询、结束或释放 Job 失败时，当前 Node 进程打印诊断并以 1 退出，不继续后面的清理，以免把仍在运行的进程当作已经结束。
- 持有 Job 的进程退出时，系统关闭句柄并结束其中的全部进程。tmux server 的 Job 由 agent 持有，所以 agent 异常退出时所有会话随之结束；recorder 和控制客户端各有自己的 Job，recorder 故障不影响会话。
- 命令入口也把 Node 放在自己的 Job 中。Node 退出后 Job 中仍有进程时，入口结束它们并报告错误。

### 终端

- agent 先在独立 Job 中启动空的 tmux server，工作目录为工作区目录；确认 server 可以应答后才让 recorder 创建会话。
- recorder 用私有的 `script` 提供 PTY，在原始模式下运行 tmux control 客户端。所有 tmux 客户端都带 `-N`，不启动新的 server。
- pane 中运行原生 Node 的 `shared/dist/terminal/pane.js`，从会话目录的 `pane.json` 读取启动信息，以参数数组和继承的标准输入输出启动配置的 PowerShell。PowerShell 退出后将 32 位退出码发布到 tmux pane；启动失败、被信号结束或发布失败时退出码为空。启动脚本忽略 Ctrl-C 和 Ctrl-Break，由 PowerShell 处理。
- 远程 attach 使用与 Unix 同源的 `forkpty` 桥，在独立 Job 中运行普通 tmux client；原 server Job 不属于这次连接。
- Windows CLI 由 `kiteline.ps1` 入口保存和恢复控制台输入模式。Node 排空输出后通过临时文件把结果交给入口并直接退出，避免退出清理被不读取输出的宿主卡住；排空超时时入口恢复控制台并以非 0 退出。宿主完全不读取输出时，入口可能一直等待，但 Node 和远端桥在期限内退出。
- 定时任务的启动参数见 [agent 配置文件](../guide/reference.md#agent-配置文件)，进程管理见[定时任务契约](scheduled-tasks.md#执行与停止)。

### 环境

- `pane.json` 保存 agent 启动时的完整环境变量，PowerShell 在这个环境上加上 `TERM`、`TMUX` 和 `TMUX_PANE` 运行。环境中可能有令牌等敏感值，它们由运行目录的 DACL 保护，会话结束时随会话目录删除。agent 异常退出时会话目录和 `pane.json` 留在运行目录中，需要手工删除（见[资源与清理](terminal.md#资源与清理)）。
- tmux 相关进程使用单独的环境（`packages/shared/src/terminal/node.ts` 的 `tmuxEnvironment()`）：`PATH` 只包含 MSYS 的 `usr/bin` 和系统目录，并关闭 MSYS 的路径自动转换。
- 内部 Node 进程（agent、recorder、`pane.js`）启动前移除 `packages/shared/src/terminal/node.ts` 的 `nodeEnvironmentKeys` 中的变量。命令入口启动 agent 时先保存这些值，agent 启动后再放回自己的环境，所以用户的设置仍会传给 Shell、Git 和定时任务。
- Git、ripgrep、定时任务和诊断都直接以原生路径和用户环境运行，不经过 MSYS。

### 本机 IPC 与单实例

本机 IPC 使用命名管道 `\\.\pipe\kiteline-<SHA-256(SID + "\0" + 运行目录的真实路径)>`，名称与登录会话编号无关：

- 管道的 DACL 受保护，只授予 SYSTEM、Administrators 和当前用户完全控制；设置 `PIPE_REJECT_REMOTE_CLIENTS`，拒绝远程客户端。
- agent 在构造前取得运行目录的 `agent.lock` 文件锁，同一实体目录即使通过不同路径访问也只能运行一个 agent。命名管道发生 fatal 错误时，agent 记录错误并关闭本机入口，其他工作继续，运行目录锁保持。
- 第一个管道实例用 `FILE_FLAG_FIRST_PIPE_INSTANCE` 创建，名称已被占用时创建失败。
- 客户端连接后核对管道服务端的属主 SID 与自己相同，否则拒绝。同一用户从其他登录会话（例如 SSH）也能连接。

### 安装与目录

- Windows 安装根目录来自系统 Known Folders，不受 `ProgramFiles`、`ProgramData` 环境变量覆盖影响；数据和运行目录仍按 [agent 环境变量](../guide/reference.md#agent-环境变量)解析。
- `%ProgramData%\kiteline-agent` 的属主不是 SYSTEM 或 Administrators，或允许其他账户写入时，维护命令拒绝执行。
- 会话 socket 路径按 MSYS 形式计算长度，运行目录太长时用 `--run-dir` 指定一个较短的目录。
- 安装、状态和程序目录的路径中不能经过重解析点。
- 维护在 `%ProgramFiles%\.kiteline-maintenance-<GUID>` 中准备新目录并设置 ACL，然后用目录移动完成替换和回退，与 Linux 的两次重命名相同（见[安装升级与卸载](agent-lifecycle.md#安装升级与卸载)）。

### 停止

agent 只通过控制台的 Ctrl-C（SIGINT）和 Ctrl-Break（SIGBREAK）进入正常停止。`TerminateProcess`、`taskkill /F` 或服务管理器的超时强制结束都会跳过清理；由于 Job 的设置，进程集合仍会被系统结束。退出码见[启动与停止](agent-lifecycle.md#启动与停止)。

### 路径与文件

- 设备上的绝对路径必须是带盘符的完整路径（`C:\…`）或 UNC 路径（`\\server\share\…`），不接受 `\\.\`、`\\?\` 设备路径。整个绝对路径（包括 UNC 主机和共享名）必须通过[无损 Unicode 校验](files.md#路径模型)。路径中的名称不能包含 `<>:"/\|?*` 和控制字符，不能以点或空格结尾，不能是 `CON`、`PRN`、`AUX`、`NUL`、`CONIN$`、`CONOUT$`、`COM1` 至 `COM9`、`LPT1` 至 `LPT9` 等保留名。工具协议中的工作区相对路径仍用 `/` 分隔。
- 符号链接和目录联接（junction）按链接处理；其他重解析点在[目录列表](files.md#路径模型)中保留为不可操作条目，对它们执行文件操作仍返回 `unsupported`。
- 目录列表中名称可用的子项使用枚举元数据，避免属性句柄的访问限制或共享占用阻断整个列表；不可表示为 UTF-8 的名称沿用不可操作条目。链接不展示大小；进入目录、读取正文和写入仍执行各自真实操作的权限检查。
- 不覆盖的重命名用 `MoveFileExW`（不带替换标志）；覆盖用 `SetFileInformationByHandle` 的 POSIX 语义重命名，打开时不跟随重解析点。文件语义见[文件](files.md#整理操作)。
- 端口建议使用原生模块读取的一次 TCP 监听表快照，规则见[开发服务访问](http-access.md#端口建议)。
