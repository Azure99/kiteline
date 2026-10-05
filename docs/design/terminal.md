# 终端

本文写给修改 `agent/src/terminal/`、`terminal-recorder/`、`shared/src/terminal/` 或 `web/src/terminal/` 的人，说明终端会话的机制和必须保持的不变量。界面操作见[使用工作台](../guide/usage.md#终端)，帧格式见[数据通道](protocol.md#数据通道)。

## 组件

- **私有 tmux server**：每个会话一个，socket 为 `<运行目录>/<会话 ID>/tmux.sock`，其中只有一个名为 `kiteline` 的 tmux 会话、一个窗口和一个 pane。它持有真实 PTY 和程序，是会话是否存在的唯一依据。
- **agent 会话表**（`agent/src/terminal/sessions.ts`）：分配 ID、登记会话、创建和结束 tmux server、查证存活、发起恢复。
- **recorder**（`terminal-recorder/src/`）：每个 agent 一个 Node 进程；每个会话一个 tmux 控制模式客户端（`tmux -C`）、一个 `@xterm/headless` 模型和一个输入队列。
- **网页显示**（`web/src/terminal/display.ts`）：每次附着新建一个 xterm.js 实例，恢复画面后接收实时输出，发送输入和尺寸。
- **本机客户端**（`agent/src/cli/terminal.ts`）：`kiteline-agent attach` 运行随包 tmux 客户端，附着到同一个 tmux 会话。

tmux 使用会话目录下的 `tmux.conf`，不加载用户的 tmux 配置或插件。预设在 `terminalPreset()`（`shared/src/terminal/node.ts`）中：`status off`、`window-size latest`、`default-terminal tmux-256color`、`remain-on-exit on`、`mouse on`、`allow-passthrough off`、`set-clipboard external`；`history-limit` 和 `default-size` 取创建时的值；prefix 键表只保留 `C-b`（发送 `C-b`）、`d`（断开）、`[`（复制模式）和 `]`（`paste-buffer -p`）；右键点击把鼠标事件交给程序，不弹出 tmux 菜单。

固定版本：tmux 版本见 [`release/inputs.json`](../../release/inputs.json)，各平台都禁用 Sixel 并应用 [`native/tmux/paste.patch`](../../native/tmux/paste.patch)。xterm.js 及插件版本见 [`web/package.json`](../../web/package.json)、[`terminal-recorder/package.json`](../../terminal-recorder/package.json) 和 [`shared/package.json`](../../shared/package.json)。网页的 xterm.js 带有 [`web/patches/`](../../web/patches/) 中的补丁，让 DOM 渲染器按设备像素比测量字形宽度；重新生成步骤见[构建与发布](../development/release.md#升级固定依赖)。

依赖固定 xterm 版本内部行为的代码集中在两处，升级 xterm 时要逐项复核：

- `shared/src/terminal/index.ts`（网页和 recorder 共用，保证两端解析一致）：Unicode 11 初始化、终端选项（关闭 `win32InputMode` 和 `kittyKeyboard`）、CSI S/T/L/M 与 REP 的计数适配、解析器空闲判断、鼠标编码补齐、用户输入转发、结束后冻结鼠标、粘贴规范化。
- `web/src/terminal/`：`touch-selection.ts`（触控选择）、`viewport.ts`（滚动、搜索定位及结束后的视口保留）、`auxiliary-input.ts`（辅助按键编码，直接导入 xterm.js 私有源码 `src/common/input/Keyboard`）。

## 会话生命周期

### 创建

agent 处理 `sessions.create`（网页或 `kiteline-agent terminal new`）的顺序：

1. 确认 agent 未在停止、Shell 可执行、会话数未达到 `terminalSessionsPerDevice`、工作区和快捷方式存在。
2. 生成 8 个随机字节作为会话 ID（16 位小写十六进制），以 `0700` 新建 `<运行目录>/<会话 ID>/`。ID 已在会话表中或目录已存在时换一个，最多 8 次，仍失败返回 `busy`。已存在的目录从不复用。
3. 启动 tmux 之前登记会话：名称（参数、快捷方式名称或 `Shell`）、创建时间、当时的 `historyLines`，状态 `starting`。
4. 让 recorder 创建会话（Windows 先由 agent 启动空的 tmux server，见[平台实现](platforms.md#windows)）。成功后状态变为 `running`，记录可用。

程序的工作目录是工作区目录，通过进程 cwd 传给 tmux，不用会展开格式字符串的 `-c`。Linux 和 macOS 上普通终端运行 `<Shell> -l`，快捷方式运行 `<Shell> -lc <命令>`，Windows 见[平台实现](platforms.md#windows)；Shell 的选择见 [agent 配置文件](../guide/reference.md#agent-配置文件)。tmux 把参数末尾的 `;` 当作命令分隔符，recorder 构造 `new-session` 时因此在末尾分号前加 `\`。初始尺寸 80×24（`agent/src/limits.ts` 的 `terminalInitialCols`、`terminalInitialRows`），之后由附着的入口调整。

### 创建结果不确定时

- recorder 在应答前失败或退出：agent 在私有 socket 上执行 `list-panes -a` 查证。pane 存活则设为 `running`、记录不可用（可以恢复）；确认不存在且不会再出现时删除登记并返回失败；无法确认时保留 `starting`，返回带 `sessionId` 的结果未确认（见[结果语义](protocol.md#结果语义)）。
- 调用方停止等待（RPC 取消、超时或控制连接断开）：agent 只停止等待，返回带 `sessionId` 的 `cancelled`、结果未确认，创建在后台继续。
- Windows 上创建失败或 agent 停止时，agent 发送 `cancelCreate`。recorder 等该次创建的准备步骤结束、关闭已建立的部分后才应答；不应答时 agent 结束 recorder 的整个进程集合。此后不会有迟到的创建。
- Linux 和 macOS 没有撤销步骤，失败后 tmux 会话仍可能出现。agent 每 2 秒查证一次记录不可用的会话：存活的 `starting` 会话变为 `running`，确认已结束的删除登记。
- 网页收到结果未确认时重新读取会话列表，按 `sessionId` 找回会话，从不自动重发创建。

### 存续与结束

| 事件                                           | 会话                                     |
| ---------------------------------------------- | ---------------------------------------- |
| 网页刷新、关闭、断网，或没有任何入口附着       | 继续                                     |
| server 重启、控制连接重连、退出登录、删除设备  | 继续                                     |
| 本机客户端断开或退出                           | 继续                                     |
| 控制客户端故障、recorder 退出                  | 继续                                     |
| Shell 或快捷方式程序退出                       | 结束                                     |
| 网页“结束会话”或 `kiteline-agent terminal end` | 结束                                     |
| agent 正常停止                                 | 结束                                     |
| agent 异常退出                                 | 见 [agent 异常退出后](#agent-异常退出后) |
| 设备或容器重启                                 | 结束；会话目录留在运行目录中             |

会话没有空闲超时。server 重启、退出登录和删除设备只关闭相关的网页附着。控制客户端故障时会话变为记录不可用，可以[恢复](#记录故障后的恢复)。

agent 正常停止（包括停止或重启服务）时，`Agent.close()` 在每个会话的私有 socket 上执行 `kill-server`，会话中的程序随之结束，正在运行的定时任务也被停止（见[执行与停止](scheduled-tasks.md#执行与停止)）。新启动的 agent 会话表为空，不导入旧会话。停止顺序见[启动与停止](agent-lifecycle.md#启动与停止)，异常退出见[资源与清理](#资源与清理)。

程序退出后，`remain-on-exit on` 让 pane 保留到 agent 读取退出码。recorder 订阅 `#{pane_dead}` 和退出码，在控制流中排在之前的输出之后处理结束：先把结束帧（含退出码）送给所有显示，再通知 agent。agent 在私有 socket 上执行 `kill-server`（Windows 还要结束 tmux server 的进程集合并等它清空），删除登记，推送 `sessions.changed`，再删除会话目录。退出码在 Linux 和 macOS 上取 `#{pane_dead_status}`，在 Windows 上取 pane 选项 `@kiteline-exit-dword`，读不到时为空。明确结束会话时，agent 先等进行中的创建或恢复，再让 recorder 关闭控制客户端并执行 `kill-server`，退出码为空。

不变量：

- 会话表只在 agent 进程内存中，只有 `starting` 和 `running` 两种状态。只有确认 tmux 会话已不存在时才删除登记；记录故障和网页断线都不算会话结束。
- 有会话的工作区不能移除（`workspaces.remove` 返回 `busy`）。
- 网页收到结束帧后立即停止发送输入和尺寸；已收到的输出写完后关闭程序的鼠标模式，显示变为只读（`freezeMouse`、`retainReadonlyViewport`），仍可滚动、选择和复制，直到用户关闭它。

## 输出记录与历史

recorder 由 agent 在第一次需要时启动，通过标准输入输出交换按行分隔的 JSON（见[通信契约](protocol.md#recorder-ipc)）。

### 顺序与故障

控制流中的 `%output`、`%layout-change` 和存活订阅按到达顺序进入同一个队列：输出写入模型，布局变化调整模型尺寸，存活变化触发结束。以下情况属于记录故障：控制客户端退出、tmux 命令超过 30 秒未应答、出现 `%pause`、`%continue`、`%extended-output` 或 `%exit`、出现意外的 pane 或布局、模型待解析的输出超过 `terminalModelPendingBytes`。记录故障时 recorder 关闭该会话的所有显示（`recording_unavailable`），agent 把会话标为记录不可用并设置 `historyGap`；tmux 中的程序不受影响。整个 recorder 退出时，它的所有会话都按此处理。

tmux 是终端查询的唯一应答方：headless 模型的应答被丢弃，网页只转发 xterm.js 标记为用户输入的数据（`forwardUserInput`）。

### 检查点与尾段

recorder 为每个会话保存一个检查点和其后的完整尾段：

- 检查点是 `SerializeAddon` 输出的 VT 序列，含屏幕、普通缓冲区的滚屏历史和常用模式，末尾补上它不输出的鼠标编码（SGR 或 SGR-Pixels）。尾段是检查点之后依次发生的输出和尺寸变化。
- 只在模型写完一批输出且解析器空闲（ground，即不在未结束的控制序列中）时生成检查点。尾段达到 `terminalCheckpointIntervalBytes` 后，在下一个空闲点生成新检查点并清空尾段。
- 尾段超过 `terminalRecoveryTailBytes` 时丢弃检查点和尾段，之后的附着要等解析器回到空闲状态。
- 序列化结果超过 `terminalSnapshotBytes` 时把滚屏行数减半重试，并给这份副本标记 `historyLimited`；滚屏为 0 仍超过时返回 `limit_exceeded`。缩短只影响这份副本，不改变模型中的历史。
- 序列化在 recorder 的单个线程中同步执行，同一 recorder 的其他会话会短暂停顿。

`historyLines`（界面“新会话滚屏行数”，范围见[限额](../guide/reference.md#限额)）在创建时写入会话，同时决定 tmux 的 `history-limit`、recorder 模型和网页 xterm.js 的滚屏行数；修改设置只影响之后新建的会话。tmux 的历史服务本机客户端，recorder 的历史服务网页，两者各自淘汰旧行。网页的两种提示：

- “历史存在缺口”（`historyGap`）：本次 agent 运行期间该会话发生过记录故障，部分输出没有进入网页历史。agent 运行期间不清除。
- “已减少较早历史”（`historyLimited`）：本次附着的恢复副本被缩短。

### 内部常量

| 常量                              | 值                   | 位置                                  | 作用                          |
| --------------------------------- | -------------------- | ------------------------------------- | ----------------------------- |
| `terminalModelPendingBytes`       | 8 MiB                | `terminal-recorder/src/model.ts`      | 模型待解析输出上限            |
| `terminalCheckpointIntervalBytes` | 4 MiB                | `terminal-recorder/src/model.ts`      | 生成新检查点的尾段长度        |
| `terminalRecoveryTailBytes`       | 8 MiB                | `terminal-recorder/src/model.ts`      | 尾段上限                      |
| `terminalSnapshotBytes`           | 16 MiB               | `shared/src/protocol/index.ts`        | 一份恢复副本的上限            |
| `terminalOutstandingBytes`        | 256 KiB              | `terminal-recorder/src/attachment.ts` | 每个显示已发送未确认的输出    |
| `terminalPendingBytes`            | 1 MiB                | `shared/src/protocol/index.ts`        | 每个显示的待发队列和 IPC 积压 |
| `dataChunkBytes`                  | 64 KiB               | `shared/src/protocol/index.ts`        | 输出分块、单个输入帧上限      |
| `interactionTimeout`              | 30 秒                | `shared/src/protocol/index.ts`        | recorder 应答和各种等待的期限 |
| 存活查证间隔                      | 2 秒                 | `agent/src/terminal/sessions.ts`      | 记录不可用的会话              |
| 重绘                              | 行数加 1，停留 80 ms | `terminal-recorder/src/session.ts`    | 见[恢复动作](#恢复动作)       |

## 附着与恢复

### 网页附着

网页打开显示时建立 `terminal.attach` 数据通道（见[数据通道](protocol.md#数据通道)）。agent 确认会话为 `running` 且记录可用后发送通道就绪帧 `ready{meta}`（带 `terminalInputBytes`；server 读取它，并在创建通道的响应中交给浏览器），收到 `start` 后请求 recorder 附着，`history` 为 `retained`（默认）或 `screen`：

- `retained`：解析器空闲且尚无检查点或尾段非空时，先生成新检查点；然后发送检查点和尾段副本。解析器不空闲但有检查点时，直接发送已有检查点和完整尾段，不等程序补完序列。两者都没有时等待下一次输出，30 秒内取不到返回 `busy`。
- `screen`：只在解析器空闲时序列化当前屏幕（滚屏为 0），否则等待，超时返回 `busy`。它不替换检查点，也不改会话的 `historyLines`。

agent 发往该显示的帧依次为：`restore.begin`（尺寸、`historyLines`、副本字节数、`historyLimited`、`historyGap`）、副本的二进制分块、尾段（二进制输出和 `resize`）、恢复完成帧 `ready`，然后是实时的二进制输出和 `resize`，最后是 `ended` 或 `error`（帧名列表见[数据通道](protocol.md#数据通道)）。恢复期间的新输出进入该显示自己的队列，不阻塞模型。网页在 `restore.begin` 时新建 xterm.js 实例，副本字节数对不上就放弃该实例；收到恢复完成帧 `ready` 并发出第一次尺寸后才允许输入。

流量控制：网页每写完一块输出就回报累计的 `consumed` 字节数。未确认输出达到 `terminalOutstandingBytes` 时暂停发送；待发队列超过 `terminalPendingBytes` 返回 `limit_exceeded`；有未确认输出且 `terminalStallTimeout` 内没有进展返回 `timeout`。这些错误只关闭这一个显示。

显示在第一次打开时附着。切换分组、工具，或收起文件和 Git 视图下方的终端面板，只隐藏显示，隐藏的显示保持附着并继续消费输出；关闭显示、离开工作区或页面销毁时释放附着。断开后网页不自动重连，显示“连接已断开”，由用户点击“重新连接”。同一会话的多个显示各自维护视口、选区和搜索。

### 本机附着

`kiteline-agent attach <会话 ID>` 通过本机 IPC（见[通信契约](protocol.md#本机-ipc)）调用 `terminal.attach` 取得 socket，然后运行随包 tmux：`tmux -S <socket> attach-session -E -t kiteline`（`-E` 不用客户端环境更新会话环境）。标准输入和输出都必须是终端；会话仍在创建时返回 `busy`。命令按 [`--run-dir` 和目录配置](../guide/reference.md#agent-环境变量)找到运行目录，不读取 `config.json`，本机请求使用默认的 `rpcTimeout`，附着时长不限。附着期间公开入口持有共享使用锁，升级和卸载会被拒绝（见[锁](agent-lifecycle.md#锁)）。

网页菜单“本机接续命令”生成的命令包含公开入口的绝对路径和 `--run-dir`；Windows 客户端的启动方式见[平台实现](platforms.md#windows)。

### 记录故障后的恢复

`sessions.recover` 为同一个 pane 重建记录，不新建 Shell，也不重启程序：

1. 会话进入 `recovering`；同一会话的恢复串行进行，记录已可用时直接返回。
2. agent 在私有 socket 上查证 pane。pane 已结束按会话结束处理；查证失败时保留原因，回到记录不可用。
3. recorder（必要时重新启动）以控制模式附着原会话，删除遗留的 `kiteline-web-input` 缓冲，用 `capture-pane -e` 及光标、备用屏幕、应用光标键状态构造当前屏幕，写入新模型并生成检查点。这个画面不含旧的滚屏历史和其他隐藏模式，初始化期间的输出不进入模型。
4. recorder 做一次[重绘](#恢复动作)让程序重画，再生成检查点。
5. 会话恢复为记录可用，网页重新附着。失败时保持记录不可用并显示原因，可以再次恢复或用本机附着；agent 不自动重试。

## 输入

网页到 tmux 的路径：

1. 网页只发送用户输入：键盘输入编码为 UTF-8，`onBinary` 的数据按单字节映射，以二进制帧发送。单帧超过 `dataChunkBytes` 或发送缓冲超过 `terminalPendingBytes` 时不发送，显示“终端输入过大或发送积压”。
2. 粘贴走单独的 `paste` 消息（拦截浏览器的 paste 事件，“粘贴”按钮也走这里）。网页先检查规范化后的字节数不超过 `terminalInputBytes`、消息不超过 `controlMessageBytes`，超过时整次拒绝，显示“粘贴内容超过容量”。
3. recorder 只接受已收到 `ready` 的显示的输入，按到达顺序排队。待处理字节（尺寸和重绘各计 32 字节）超过 `terminalInputBytes` 时拒绝（`input.error`，`failed`）。同一显示连续的普通输入合并为一批，同一显示连续的尺寸请求只保留最后一个；合并不跨越粘贴、其他显示或其他类型的请求。
4. 每批用一次独立的 tmux 调用注入：`load-buffer -b kiteline-web-input -` 后接 `paste-buffer -r -d [-p] -b kiteline-web-input -t <pane>`。

要点：

- 粘贴正文由 recorder 规范化（`normalizePaste`）：CRLF 和 LF 变为 CR，ESC 换成可见的 U+241B，正文因此不会被程序当作按键，也不会提前结束括号粘贴。普通输入不做替换。
- 粘贴带 `-p`：程序开启括号粘贴时加起止标记。`paste.patch` 让 tmux 按程序自己的模式（`wp->base.mode`）判断，本机客户端处于复制模式时网页粘贴仍带标记。
- 注入失败时网页收到结果未确认的 `input.error`，recorder 只删除自己的 `kiteline-web-input` 缓冲。输入不自动重试；网页在断开和恢复期间不缓存输入。
- 网页输入不经过 tmux 键表，网页中的 Ctrl-b 直接交给程序。本机客户端使用 tmux 键表：`Ctrl-b d` 断开，`Ctrl-b Ctrl-b` 发送 Ctrl-b。
- 手机辅助键和待用修饰键用 xterm.js 的键盘编码函数生成，读取程序当前的应用光标键模式；虚拟 Alt 按 Meta 处理。
- 多个入口同时输入时按到达顺序交错写入。

## 尺寸

真实 PTY 只有一组行列。tmux 使用 `window-size latest`，最近活动的客户端决定尺寸：

- 本机客户端按自己终端的尺寸参与。
- 网页通过 recorder 的控制客户端参与：执行 `select-window` 和 `refresh-client -C <列>x<行>`，等控制流报告同样的实际尺寸（30 秒期限）后再处理队列中的下一项。实际尺寸经控制流进入模型，再以 `resize` 帧发给所有显示。
- 网页请求限制在 `terminalMaxCols` × `terminalMaxRows` 以内（见[限额](../guide/reference.md#限额)）。本机客户端可以让实际尺寸更大，所以恢复帧接受最大 10000 列和 10000 行。没有网页时控制客户端保留最后的尺寸。
- 不使用 `resize-window`，它会把窗口切换为手动尺寸，客户端之后无法再调整。

网页一侧（`display.ts` 的 `resize()`）：先按会话的实际尺寸恢复画面，收到 `ready` 后按自己的可见区域发送第一次尺寸，再开放输入。隐藏或尺寸为 0 的显示不发送尺寸；滚动、选择和输出不重复提交尺寸。手机软键盘只缩短可见高度时，宽度和字号不变就保留打开键盘前的行列，终端只在本地裁切并跟随光标，不请求会话改变尺寸；宽度、旋转和字号变化会重新计算。

## 恢复动作

| 动作（i18n 键）                           | 出现条件                                       |
| ----------------------------------------- | ---------------------------------------------- |
| “重新连接”（`terminal.reconnect`）        | 显示出错，错误码不是 `recording_unavailable`   |
| “恢复终端”（`terminal.recover`）          | 错误码为 `recording_unavailable`               |
| “减少历史后重试”（`terminal.screenOnly`） | 错误码为 `limit_exceeded`、`timeout` 或 `busy` |
| “重绘程序”（`terminal.redrawProgram`）    | 会话菜单，确认后执行                           |

- 重新连接：确认登录仍有效后关闭当前显示，新建显示并以 `retained` 重新附着。不触及 recorder、共享历史和程序。
- 恢复终端：调用 `sessions.recover`，`recovering` 期间每 500 ms 读取一次会话列表，变为可用后重新附着（见[记录故障后的恢复](#记录故障后的恢复)）。
- 减少历史后重试：以 `screen` 重新附着，只省略本次的较早滚屏；检查点和 `historyLines` 不变，之后的附着仍取完整历史。
- 重绘程序：调用 `sessions.redraw`，在输入队列中排队，把行数加 1，等实际尺寸生效后停留 80 ms，再恢复原尺寸并等待生效。要求记录可用。程序会向所有入口重画，其他入口的画面和选区可能改变；请求完成只表示尺寸已恢复。

关闭显示后再打开会新建附着，原显示的选区和本地历史随之释放。程序输出未结束的 OSC 或 DCS 序列时解析器一直不空闲，尾段超过 `terminalRecoveryTailBytes` 后新的附着只能返回 `busy`；以上动作都无法纠正，需要程序输出结束序列或结束会话。

## 资源与清理

- 每个显示的待发队列、未确认窗口和 IPC 积压各有上限，慢的显示只关闭自己。控制命令结果、IPC 单行和本机请求以 `controlMessageBytes` 为上限。超出记录能力时报告记录故障并保留程序，不靠长时间背压或结束程序来满足上限。
- `terminalSnapshotBytes` 只限制序列化结果，不限制内存；内存还包括各会话的 tmux 和 headless 网格、尾段和队列。
- 关闭显示会取消它尚未注入的输入、帧路由和恢复引用。会话结束时删除 `<运行目录>/<会话 ID>/`。

### agent 异常退出后

agent 被强制结束或崩溃时不执行清理，新启动的 agent 也不导入、不清理旧会话：

- recorder 读到标准输入结束后关闭控制客户端并退出，不结束 tmux server。
- Linux 和 macOS 上 tmux server 是守护进程，不在 agent 的进程组中，它和 pane 中的程序继续运行，会话目录也留在运行目录中；只有按 cgroup 或整个容器结束进程时它们才一并结束（各种运行方式下的情况见[清理遗留的终端会话](../guide/reference.md#清理遗留的终端会话)，示例 systemd 单元见[服务](platforms.md#服务)）。
- Windows 上 tmux server 在 agent 持有的 Job 中，agent 退出时系统结束这些 server 及其中的程序（见[平台实现](platforms.md#windows)）；会话目录（含 `tmux.conf` 和 `pane.json`）留在运行目录中。

清理这些 tmux server 和会话目录的步骤见[清理遗留的终端会话](../guide/reference.md#清理遗留的终端会话)。

## 已知差异

`adaptTerminalScrolling()` 让 xterm.js 按 tmux 3.4 的上界处理计数：CSI S、T、L、M 不超过滚动区高度，REP 不超过当前行剩余列数（包含待换行状态），省略或 0 按 1，没有剩余列时直接消费序列；普通屏幕上滚动区从第 0 行开始时，CSI S 让滚出的行进入滚屏历史并保持保存的光标。以下情况本机画面与网页的画面、光标或历史仍可能不同：

- 宽字符或组合字符后的 REP：tmux 遇到 UTF-8 字符时清除可重复的字符，xterm.js 重复整个字形。
- soft hyphen、BOM、未知 CSI 或 ESC 之后的 REP：两边记录的“上一个字符”不同。
- 关闭自动换行时的右边界：画面相同，光标列可能不同。
- 滚动区不从第 0 行开始时的 CSI S：tmux 可能把滚出的行留在历史中，网页不保留。
- 超过 2147483647 的参数：tmux 忽略整条序列，xterm.js 截到该值后执行。

其他行为：网页不显示图片（构建时禁用 Sixel，网页不加载图片插件）；`allow-passthrough off` 阻止程序绕过 tmux 控制外层终端；程序用 OSC 52 写剪贴板的请求被 tmux 拒绝，tmux 自己的复制可以写到支持 OSC 52 的外层终端；记录故障恢复后的画面来自 `capture-pane`，不含故障前的网页历史和全部隐藏模式。适配的回归测试在 `terminal-recorder/test/model.test.ts`。
