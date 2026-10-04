# agent 安装与运行

本文写给修改 `agent/src/install/`、`installer/`、`agent/src/cli/`、`agent/src/main.ts` 或 `agent/src/state-lock.ts` 的人，说明 agent 安装、升级、卸载和运行的机制与不变量。操作步骤见[接入设备](../guide/devices.md)，命令、目录和文件位置见[参考](../guide/reference.md)。

## 安装布局

程序目录、公开入口、安装记录、目录配置和锁文件的位置见[文件位置](../guide/reference.md#文件位置)。维护时另用两个内部目录：Linux 和 macOS 上，`install`、`upgrade`、`uninstall` 从维护副本 `/var/tmp/kiteline-agent-maintenance.XXXXXX` 运行，升级在 `/opt/.kiteline-upgrade-XXXXXX` 中暂存新程序；Windows 的维护操作使用 `%ProgramFiles%\.kiteline-maintenance-<GUID>`。

安装记录在 Linux 和 macOS 上保存项目用户的 `user`、`uid`、`gid`、`home`；在 Windows 上保存 `user`、`sid`、`home`、`dataDir`、`runDir`。安装记录不保存密码和服务状态。程序目录的内容见[构建与发布](../development/release.md#产物结构)，示例服务配置在 `<程序目录>/deploy/` 下。

发布包里有两种入口：解包目录中的 `bin/kiteline-agent`（Windows 为 `bin/kiteline-agent.ps1`）用于检查和首次安装；安装后的公开入口来自包内的 `bin/kiteline-agent-installed`（Windows 为 `bin/kiteline-agent-installed.ps1`）。入口负责取锁和准备运行环境，绕过入口启动的进程不受使用锁保护。直接用 Node 运行 `agent/dist/main.js` 做安装变更会被拒绝（`Use the public kiteline-agent launcher`）。

已安装的 agent 在确定目录时检查调用者：当前用户必须是安装记录中的项目用户（Linux 和 macOS 比较 uid，Windows 比较 SID），否则拒绝（`Use project user <用户> to run this command`）。程序已安装但缺少安装记录时报告安装损坏，不退回其他默认目录。

## 锁

| 锁         | 对象                                              | 谁持有                                                                 | 模式                         | 保护什么                                   |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| 管理锁     | 管理锁文件                                        | `install`、`upgrade`、`uninstall`                                      | 排他                         | 同一时间只有一个维护操作                   |
| 使用锁     | 使用锁文件                                        | 经已安装入口的每个普通命令（含长时间的 `run` 和 `attach`）；升级和卸载 | 普通命令共享；升级和卸载排他 | 有任何命令在使用程序目录时不能替换或删除它 |
| 状态锁     | `<agent 数据目录>/process.lock`                   | `run`、`bind`、`uninstall --purge-state`                               | 排他                         | 一个 agent 数据目录同时只有一个写者        |
| 运行目录锁 | `<运行目录>/agent.sock` 的锁（仅 Linux 和 macOS） | `run`                                                                  | 排他                         | 一个运行目录同时只有一个 agent             |

所有锁都是非阻塞的：取不到时命令立即失败，从不排队等待，也不会停止持有者。

实现：

- Linux 和 macOS 的管理锁和使用锁用 `flock`（Linux 用系统 `flock`，macOS 用随包的 `flock`）。公开入口在加载程序目录中的 Node、JavaScript 和配置之前取得使用锁，并把文件描述符留给 Node 进程，锁一直保持到进程退出。Windows 用 `LockFileEx`，由入口的 PowerShell 进程持有，它同时以不允许删除的方式打开程序目录（目录固定），直到 Node 及其进程集合全部结束。
- 状态锁和运行目录锁在 Linux 和 macOS 上使用 proper-lockfile：以建目录的方式加锁（`process.lock`、`agent.sock.lock`），释放时删除。进程退出时（包括以非零状态退出），proper-lockfile 同步删除自己持有的锁目录；只有进程被 SIGKILL 结束、崩溃或断电时锁目录才会留下，超过 10 秒未更新即视为过期，可被新的进程取得。Windows 的状态锁是 `process.lock` 文件上的 `LockFileEx`，进程退出时由系统释放；Windows 没有运行目录锁，同一用户和运行目录只能创建一个命名管道实例，起到同样作用（见[平台实现](platforms.md#windows)）。
- 状态锁和运行目录锁是两个不同的对象，所以运行目录可以与 agent 数据目录相同。同一运行目录配不同的数据目录也只能运行一个 agent。

不变量：

- `flock` 和 `LockFileEx` 使用的锁文件一旦创建就不删除、不重建。锁属于文件本身，删除后重建会让新旧两个进程各自锁住不同的文件。卸载因此保留这些文件；Linux 和 macOS 的卸载输出列出它们的路径。
- `run` 的取锁顺序是：使用锁（入口）、状态锁、运行目录锁。停止时先完成全部清理，再释放运行目录锁，最后释放状态锁；清理失败时进程在退出前不释放这两把锁，并以非零状态退出。
- 维护操作先取管理锁，再取使用锁，清除状态时最后取状态锁。升级和卸载只在用户确认之后、写入之前取排他使用锁，并一直持有到回退和清理完成。
- 服务管理器配置了自动重启时，它与升级争抢使用锁：重启的 agent 先取得共享锁则升级被拒绝；升级先取得排他锁则启动被拒绝。

## 安装升级与卸载

### 安装

安装（`install --user <项目用户>`，Windows 另可指定 `--data-dir`、`--run-dir`）按安装记录的状态处理：

| 安装记录               | 结果                                                     |
| ---------------------- | -------------------------------------------------------- |
| 不存在                 | 新装；程序目录或公开入口已存在时拒绝，请先确认它们的用途 |
| 同一项目用户、同一版本 | 报告已安装，不改动程序、绑定和正在运行的 agent           |
| 同一项目用户、不同版本 | 拒绝，提示先执行升级                                     |
| 其他项目用户           | 拒绝（`Current installation belongs to <用户>`）         |
| 空文件、损坏或结构不对 | 报告错误并停止，保留原文件                               |

Linux 和 macOS 的新装步骤：用 `getent`（macOS 用 `dscl`）读取账户的 uid、gid 和主目录，不使用 sudo 之后的 `HOME`；校验发布包（`release.json` 的平台和架构、`SHA256SUMS`、随包 Node 和 tmux 的版本、agent 版本）；写入 `/etc/kiteline-agent.env`（已存在时保留）；创建使用锁文件；复制程序目录并把属主设为 root；写入安装记录；最后原子替换公开入口。任一步失败时删除已写入的公开入口、安装记录和程序目录。Windows 的新装在 PowerShell 中完成同样的步骤，见[平台实现](platforms.md#windows)。

### 升级

升级（`upgrade --archive <发布包>`）在 Linux 和 macOS 上的步骤：

1. 尝试取排他使用锁并立即释放，有使用者时尽早失败。
2. 在程序目录的上级目录中建立暂存目录，使它与程序目录位于同一文件系统，后面的重命名才是原子的。把发布包复制进去，用旁边的 `<发布包>.sha256`（第一个字段）校验，解包到 `new/` 并做与安装相同的校验。
3. 请求确认（输入 `yes`；没有终端时必须传 `--yes`）。确认前可以随时取消。
4. 取排他使用锁，把 `new/` 的属主设为 root，然后做两次重命名：程序目录改名为 `previous/`，`new/` 改名为程序目录；再原子替换公开入口。
5. 删除 `previous/` 和暂存目录，释放锁。

Windows 没有第 1 步的预检：入口在准备期间持有共享使用锁，在确认之前设置新目录的 ACL，有使用者时在确认之后取排他锁时才失败（见[平台实现](platforms.md#windows)）。

第 4 步的重命名或替换入口失败时，删除新的程序目录，把 `previous/` 改回原名，恢复旧的公开入口。回退也失败时，错误信息给出程序目录和备份路径，备份保留不删。升级只改动程序目录和公开入口，不改动 agent 数据目录、绑定和服务配置，完成后不启动 agent。

### 卸载

卸载（`uninstall [--purge-state]`）在 Linux 和 macOS 上同样先预检锁，再确认，再取排他使用锁；Windows 与升级一样只在确认之后取排他锁。指定 `--purge-state` 且 agent 数据目录存在时还要取得状态锁，取不到则整个卸载失败。然后删除公开入口、程序目录和安装记录；只有持有状态锁时才删除 agent 管理的状态文件。删除和保留的文件见[卸载](../guide/devices.md#卸载)，目标目录的来源见[目录与权限](#目录与权限)。

### 维护在程序目录之外执行

升级和卸载要替换或删除程序目录，执行它们的代码因此不能来自这个目录。Node 按需从程序目录加载模块，如果维护进程本身从旧目录运行，换目录后可能加载到新旧混合的文件，旧目录也会一直处于使用中。

- Linux 和 macOS：公开入口在取得管理锁（以及从已安装目录运行时的共享使用锁）后，把整个发布包目录复制到维护副本，释放共享使用锁，从副本启动 Node，并把管理锁的文件描述符传给它。Node 核对继承的描述符与管理锁文件是同一个文件，否则拒绝执行（`Management lock was not inherited`）。入口等待 Node 最终退出后删除副本，返回 Node 的退出码。公开入口本身是一个先完整读入再执行的 Shell 函数，维护过程中替换 `/usr/local/bin/kiteline-agent` 不影响正在运行的入口。
- Windows：维护逻辑全部在入口的 PowerShell 进程中执行，原生代码由脚本内嵌的源码在内存中编译，不读取程序目录中的文件；只有校验新包时用新目录中的 Node 运行一次新包的 `kiteline-agent --version`。

维护进程拥有自己的输入：升级先把发布包复制进暂存目录再校验；调用升级的下载脚本等到维护命令最终退出后，才删除自己的下载目录。

### 中断与退出码

- Linux 和 macOS：确认之前（安装为校验发布包之前）收到 HUP、INT 或 TERM 会取消并清理。之后收到的信号被推迟：操作继续完成、回退和清理，再以 129、130 或 143 退出，即使变更已经生效。入口把信号转发给 Node，并返回同样的退出码。
- Windows：入口登记控制台事件，Ctrl-C 记为 130，Ctrl-Break 记为 131；开始写入之前检查到中断就取消，开始写入之后照常完成，再返回记录的退出码。入口无法查询、结束或关闭自己的进程集合时以 125 退出，这会结束整个当前 PowerShell 进程。下载脚本遇到 125，或无法确认提升权限的子进程已经结束时，保留下载目录并打印路径。
- 被 SIGKILL 结束、整个进程组被中断或断电时，可能留下暂存目录和 `previous/` 备份。重新操作前先检查程序目录和这些目录。

## 启动与停止

`run` 的启动顺序：

1. 读取目录配置和 `config.json`，以私有权限创建 agent 数据目录，取得状态锁。
2. 创建运行目录；Linux 和 macOS 取得运行目录锁。
3. 读取 `connection.json`；未绑定时报错（`Device is not bound; run kiteline-agent bind`）。
4. 加载 `agent.json`、`temporary-files.json` 和定时任务，启动本机 IPC（Linux 和 macOS 先删除旧的 `agent.sock`），然后连接 server。

停止信号在任何资源产生之前就已登记：Linux 和 macOS 是 SIGINT、SIGTERM、SIGHUP，Windows 是 SIGINT（Ctrl-C）和 SIGBREAK（Ctrl-Break）。启动途中收到信号时，在下一步之前停下并清理已经建立的部分。所有信号进入同一条停止路径，重复的信号共用同一次停止。

停止顺序（`Agent.close()`）：

1. 拒绝新请求（`Agent is stopping`），停止定时任务的计时器，取消所有进行中的 RPC，断开控制连接。
2. 同时关闭终端、HTTP 和文件数据通道、本机 IPC、文件整理操作，停止正在运行的定时任务（见[定时任务契约](scheduled-tasks.md#执行与停止)），并等待进行中的请求处理结束。
3. 关闭临时文件记录。
4. 同时关闭目录游标、Git 仓库（进行中的 Git 写操作按 [Git 契约](git.md#写操作)结束）、文件监听和终端会话：Windows 先撤销尚未完成的创建，然后停止 recorder（30 秒内未退出则强制结束），再在每个会话的私有 socket 上执行 `kill-server`。

任何一步失败都会被收集；全部步骤结束后，如果有失败，agent 打印汇总错误并以 1 退出，退出前不主动释放运行目录锁和状态锁。进程退出时这两把锁随之释放（见[锁](#锁)），未能结束的 tmux server 按[资源与清理](terminal.md#资源与清理)处理。成功时依次释放运行目录锁和状态锁。

退出码：

- Linux 和 macOS：正常停止为 0，启动失败或清理失败为 1。
- Windows 经公开入口：Ctrl-C 停止为 130，Ctrl-Break 为 131，出错为 1。Node 退出后其进程集合中仍有进程时，入口结束这些进程并报告错误；入口自身无法管理进程集合时为 125。

正常停止结束全部终端会话和正在运行的定时任务（见[会话生命周期](terminal.md#会话生命周期)）。服务管理器必须用上述信号（Windows 为控制台 Ctrl 事件）停止 agent，并留出足够的停止时间（示例服务配置为 45 秒；agent 等 recorder 退出最多 30 秒）；强制结束会跳过清理，后果见[资源与清理](terminal.md#资源与清理)。配置方法见[接入设备](../guide/devices.md#后台运行)。

## 绑定与连接

### 绑定

`bind --server <地址>` 的处理：

- 地址必须是 `http:` 或 `https:` URL，只保存其 origin。绑定码从终端提示读取，或从标准输入读取（最多 4096 个字符）。
- 整个命令持有状态锁，agent 正在运行时绑定会失败。
- 带 `--if-unbound` 时，在状态锁内检查 `connection.json`；已存在则拒绝并保留原身份。网页生成的接入命令和仅绑定命令都使用这个选项。不带此选项时会覆盖原有身份。
- 绑定请求 `POST /api/agent/bind` 经环境代理发送（见[接入设备](../guide/devices.md#出站代理与证书)），期限 30 秒。网络失败或没有收到应答时报告绑定结果未知；server 返回错误时报告该错误。
- 成功后以原子替换写入 `connection.json`（`deviceId`、`deviceToken`、`server`，权限 `0600`）。写入失败时提示该设备已登记但凭据未保存。两种情况的处理见[重新绑定](../guide/devices.md#重新绑定)。

保存的 server 地址只由 `bind` 写入。升级、在其他入口打开网页或从其他地址下载发布包都不会改写它。

### 控制连接

agent 用设备令牌连接 `/api/agent/control`，握手期限 30 秒。重连退避、停止重连的条件和同一身份的连接替换见 [WebSocket 连接](protocol.md#websocket-连接)。停止重连后，本机终端、定时任务和本机 IPC 继续工作，`doctor` 报告最近的连接错误；处理绑定问题后需要重启 agent。复制了数据目录的设备怎样处理见[重新绑定](../guide/devices.md#重新绑定)。

## 目录与权限

### agent 数据目录和运行目录

- 目录的确定顺序和 `/etc/kiteline-agent.env` 的格式见 [agent 环境变量](../guide/reference.md#agent-环境变量)。已安装时，Linux 和 macOS 的默认目录基于安装记录中项目用户的主目录，Windows 的两个目录取自安装记录；`attach --run-dir` 只替换运行目录。从解包目录运行时不读安装记录，默认目录基于当前用户的主目录。
- `<运行目录>/<会话 ID>/tmux.sock` 的字节长度有上限，因此运行目录路径也有上限（见[限额](../guide/reference.md#限额)）；超出时 `run` 和 `check` 报告 `KITELINE_AGENT_RUN_DIR is too long`。
- 维护命令（升级、清除状态）的目标目录只取自安装记录和目录配置，不取执行命令的管理员环境中的变量，也不扫描其他自定义目录。

### 权限

- Linux 和 macOS：`run` 和 `check` 以 `0700` 创建 agent 数据目录和运行目录，`bind` 只创建 agent 数据目录（已存在的目录保持原有权限）；会话目录为 `0700`，`agent.sock` 为 `0600`，JSON 状态文件为 `0600`。这些目录及其上级目录应只能由项目用户（和 root）修改。
- Windows：agent 数据目录和运行目录由原生模块创建，属主为项目用户，DACL 受保护，只授予 SYSTEM、Administrators 和项目用户完全控制。目录已存在时必须是真实目录（不是链接）且属主为项目用户，agent 会重设其 DACL。
- 程序目录：Linux 和 macOS 上属主为 root，目录和可执行文件为 `0755`，其他文件为 `0644`，安装记录为 `0644`，使用锁文件为 `0640`（项目用户的主组可读，用于取共享锁），管理锁文件只对 root 可读写。Windows 上程序目录和 `%ProgramData%\kiteline-agent` 的属主为 Administrators，SYSTEM 和 Administrators 完全控制，项目用户只读和执行。

### JSON 状态

agent 的 JSON 状态（`agent.json`、`connection.json`、`temporary-files.json`、定时任务记录，以及 Linux 和 macOS 的安装记录）先以独占方式写入同目录的临时文件（`atomicJson()`，`agent/src/config.ts`；临时文件名为 `<文件>.<UUID>.tmp`），再以重命名替换，读者只会看到完整的旧内容或新内容。写入后不调用 fsync，不保证断电后的持久性。

读取时，`agent.json`、`connection.json`、`config.json`、定时任务记录和安装记录为空文件、损坏的 JSON 或不支持的结构时，agent 报告错误并保留原文件，不自动修复、迁移或覆盖。`temporary-files.json` 例外：读取失败时只记录日志并按空登记处理，下一次创建临时文件时被改写（见[临时文件](files.md#保存)）。

## check 与 doctor

`check` 在当前环境中逐项检查，全部通过时输出 `Setup checks passed.`，否则列出失败项并以非零状态退出。每个外部命令最多运行 5 秒。

| 检查项       | Linux                       | macOS                                     | Windows                |
| ------------ | --------------------------- | ----------------------------------------- | ---------------------- |
| 随包 ripgrep | 运行并核对版本              | 运行并核对版本                            | 运行并核对版本         |
| 随包 tmux    | `tmux -V`                   | `tmux -V`                                 | `tmux -V`              |
| 文件辅助程序 | `rename-noreplace` 可以启动 | `rename-noreplace`、`entry-name` 可以启动 | 原生模块可以加载       |
| flock        | 系统 `flock --version`      | 随包 `flock --version`                    | 不检查                 |
| Git          | 2.23.0 及以上               | 2.23.0 及以上                             | 2.23.0 及以上          |
| SSH          | `ssh -V`                    | `ssh -V`                                  | 不检查                 |
| Shell        | 可执行                      | 可执行                                    | PowerShell 7.0 及以上  |
| UTF-8 locale | `locale charmap` 为 UTF-8   | `locale charmap` 为 UTF-8                 | 不检查                 |
| terminfo     | `infocmp -x tmux-256color`  | `infocmp -x tmux-256color`                | 私有 terminfo 目录存在 |
| 目录         | 运行目录长度；创建并可写    | 同左                                      | 同左                   |

`check` 会创建 agent 数据目录和运行目录。文件辅助程序的检查只确认程序能启动，不确认文件系统支持不覆盖的重命名。

`doctor` 先通过本机 IPC 请正在运行的 agent 检查自己（在线），输出每项的 `[ok]`、`[warn]` 或 `[error]`，有 `error` 时以 1 退出。

- 在线检查覆盖 `check` 的全部项目，另加目录配置、Node 和 agent 版本、原生组件构建信息、recorder 入口、Linux 上的动态库依赖（静态 musl 构建跳过），以及正在运行的 agent 的身份和 `HOME`、`PATH`、server 连接与最近的连接错误、recorder 进程、定时任务和每个终端会话的记录状态、Git 配置来源和 `SSH_AUTH_SOCK`。Windows 另报告 PowerShell 的输出编码，以及 `PATH` 中是否有 `ssh`（只作提示）。
- 连接不到 agent 时（离线），`doctor` 在当前进程中检查安装、配置和随包组件（这些组件会实际运行），在结果最前面加“Local connection”警告，结果中还有 `Runtime environment has not been checked` 警告；`config.json` 无效时追加错误。离线结果不代表后台 agent 的实际环境。

`doctor` 不验证 Git 认证、hooks 和签名，也不修改 Git 配置；在工作台执行一次 Fetch 或提交可以确认它们是否可用。
