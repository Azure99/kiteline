# 定时任务

本文写给修改 `agent/src/tasks/`、`agent/src/cli/tasks.ts`、`server/src/task-summary.ts` 或 `web/src/tasks/` 的人：定时任务的定义、调度、执行和记录都由 agent 管理，server 只保存每台设备的状态摘要并转发管理请求。使用说明见[定时任务](../guide/scheduled-tasks.md)。

## 数据模型

类型定义在 `shared/src/protocol/tasks.ts`，RPC 方法定义在 `shared/src/protocol/rpc.ts`。工作台通过设备 RPC、`kiteline-agent schedule` 通过本机 IPC 调用同一组方法（`agent/src/tasks/rpc.ts`），任务方法不带 `workspaceId`。

### 任务

| 字段          | 含义                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| `id`          | 任务 ID，由调用方生成                                                      |
| `name`        | 名称                                                                       |
| `command`     | 命令文本                                                                   |
| `schedule`    | `{kind:"cron",expression}` 或 `{kind:"once",at}`；`at` 保存为 UTC ISO 时间 |
| `cwd`         | 工作目录的绝对路径；创建时省略则为项目用户的 HOME                          |
| `timezone`    | IANA 调度时区；创建时省略则为 agent 进程的时区                             |
| `revision`    | 修订号，从 1 开始                                                          |
| `state`       | `active` 或 `paused`                                                       |
| `reviewRunId` | 待核查运行的 ID；没有待核查运行时省略                                      |
| `nextRunAt`   | 下一次定时时刻；暂停、待核查、单次计划已消耗或已错过时为 `null`            |
| `onceStatus`  | 单次计划的状态：`pending`、`consumed` 或 `missed`                          |

修改定义、暂停、恢复、确认核查，以及 agent 启动时把未结束运行标为待核查，都会使 `revision` 加 1；运行的开始、结束和输出增长不改变它。`tasks.update` 必须携带 `expectedRevision`，与当前值不同时返回 `conflict`，定义保持不变。

创建和修改时，agent 用 `realpath` 解析 `cwd` 并确认它是目录；`cwd` 与原值相同时跳过检查，所以只改其他字段时目录可以暂时不可达。执行时目录不可达，这次运行以 `start_failed` 失败，agent 不改用其他目录。

### 运行

运行记录的字段见 `shared/src/protocol/tasks.ts`。`state` 在进行中为 `starting`、`running` 或 `stopping`；`exitCode` 和 `signal` 是实际值，Windows 退出码保留 DWORD 值；`parameters` 保存接纳时任务的名称、命令、`cwd`、计划、时区和 `taskRevision`；`taskId` 在加载时从所在文件推导；跳过的运行没有 `startedAt`。

结束状态的判定：

| 状态        | 条件                                                                | `reasonCode`                      |
| ----------- | ------------------------------------------------------------------- | --------------------------------- |
| `succeeded` | 退出码为 0                                                          | 无                                |
| `failed`    | 退出码非 0，或命令无法启动                                          | `exit_nonzero` 或 `start_failed`  |
| `stopped`   | 收到停止请求或 agent 正常停止，进程集合已结束；保留实际退出码和信号 | `requested_stop` 或 `agent_stop`  |
| `skipped`   | 定时触发时没有启动命令                                              | `missed`、`overlap` 或 `capacity` |
| `unknown`   | agent 启动时发现上次未结束的运行，无法知道它的结果                  | `unconfirmed`                     |

定义与运行相互独立：接纳之后修改任务，不影响这次运行的 `parameters`。失败的运行不自动重试，以后的定时照常进行。

### ID

任务 ID 和运行 ID 由调用方在发送请求前生成：工作台生成 32 位十六进制字符串（`web/src/lib/id.ts`），`kiteline-agent schedule` 使用 `--task-id`、`--run-id` 或随机 UUID。定时触发的运行由 agent 生成 UUID。

ID 只能包含 `A–Z`、`a–z`、`0–9`、`_`、`-`，长度 1 到 128 个字符（`agent/src/tasks/schedule.ts`）。ID 直接用作文件名，因此唯一性按 ASCII 大小写不敏感判断：已有任务 `Backup` 时不能创建 `backup`；运行 ID 在所有任务的保留运行和尚未删除的输出文件之间唯一。ID 按原拼写保存和显示。重复的 ID 返回 `conflict`，不会执行第二次。调用方失去回复时按原 ID 查询结果，规则见[结果语义](protocol.md#结果语义)。

## 调度

周期计划由 Croner 计算，版本固定在 `agent/package.json`（10.0.1）。agent 以 `mode: "5-part"` 和 `domAndDow: false` 创建 `Cron` 对象，日期与星期同时指定时按逻辑或匹配。表达式在合并空白后必须是五个只含数字、`*`、`,`、`/`、`-` 的字段，长度不超过 256 个字符；名称、秒和年份字段都会被拒绝。用户可写的语法见[计划规则](../guide/scheduled-tasks.md#计划规则)。

- **时区和单次时刻。** `timezone` 用 `Intl` 校验，创建时保存，之后不随设备或浏览器的时区变化；`at` 保存为 UTC。两者的输入规则见[计划规则](../guide/scheduled-tasks.md#计划规则)。创建时单次时刻必须在未来；周期计划没有未来发生点时同样拒绝。
- **计算下一次。** `nextOccurrence()` 从 `max(当前时间, lastScheduledAt)` 之后开始找。Croner 会把夏令时跳过的不存在时刻顺延，agent 用 `cron.match()` 再核对一次，因此不存在的时刻被跳过，重复的时刻只执行一次。`lastScheduledAt` 记录最近处理过的计划时刻并持久保存，系统时钟回拨后不会再次接纳已处理的时刻。预览（`tasks.preview` 返回 5 个时刻）、创建校验和实际定时使用同一个函数。
- **定时器。** 每个任务一个 `setTimeout`，延迟上限为 2,147,483,647 毫秒。回调先确认任务仍存在、`revision` 和 `nextRunAt` 未变、agent 没有在停止，否则放弃；回调早于计划时刻触发时重新设置定时器。
- **不补跑。** 回调接纳时，当前时间晚于计划时刻超过 `taskLimits.lateToleranceMs`（`agent/src/limits.ts`，数值见[限额](../guide/reference.md#限额)）时，记录一条 `skipped`/`missed` 运行，然后计算下一次。agent 启动或任务恢复时从当前时间向后计算，停机期间错过的周期时刻不逐条记录。
- **单次计划状态。** 定时触发后 `onceStatus` 变为 `consumed`，因重叠或名额不足而跳过时也是如此；因超时而跳过时变为 `missed`。单次时刻在暂停期间或 agent 停机期间过去时，agent 在下一次加载、修改、暂停、恢复或确认核查时把它标为 `missed`，并补记一条 `skipped`/`missed` 运行。手动运行不改变 `onceStatus`。修改计划（或修改周期计划的时区）会清除 `lastScheduledAt`，单次计划回到 `pending`。
- **暂停。** 暂停只取消定时器，不影响正在进行的运行，也不阻止手动运行。

## 接纳与并发

所有改变任务状态的操作在 `ScheduledTasks` 的同一个串行队列中执行。手动运行（`tasks.run`）和定时触发都经过 `admit()`，按以下顺序处理：

1. 任务有 `reviewRunId` 时返回 `busy`，details 带 `reviewRunId`。待核查任务的 `nextRunAt` 为 `null`，不会定时触发。
2. 运行 ID 与已有记录或未删除的输出文件重复时返回 `conflict`。
3. 判断是否需要跳过：定时触发晚于容差为 `missed`；同一任务已有进行中的运行为 `overlap`；设备上占用的运行名额达到 `taskRunsPerDevice` 为 `capacity`。占用名额的包括正在执行的进程、进行中状态的运行和所有任务的 `reviewRunId`，同一 ID 只计一次。
4. 手动运行遇到 `overlap` 或 `capacity` 时返回 `busy`，不写记录。定时触发遇到任何原因时写入一条 `skipped` 运行并设置下一次定时。
5. 可以启动时，先清理残留输出、整理本任务的历史记录并为输出腾出空间（见[记录留存](#记录留存)）。
6. 以 `starting` 状态保存运行记录，再启动进程。保存失败时不启动命令，直接返回错误。
7. 进程无法启动时，运行以 `failed`/`start_failed` 保存。
8. 进程启动后以 `running` 状态保存 `pid` 和 `startedAt`。这次保存失败时，命令已在运行，RPC 返回 `outcome: "unknown"`，details 带 `taskId` 和 `runId`。

不排队：重叠或名额不足的运行要么跳过，要么返回 `busy`，不会等待，也不会让已有运行让位。

`tasks.run` 和 `runs.stop` 成功只表示请求已被接纳，命令结果要通过 `runs.get` 查询。接纳之后，运行与发起请求的连接无关：取消 RPC、关闭网页、CLI 退出、server 断开或设备被删除，都不影响已接纳的运行和设备本地的定时。取消 RPC 只在操作还没开始执行时生效。

删除有进行中运行的任务返回 `busy`；任务数量达到 `tasksPerDevice` 时创建返回 `limit_exceeded`。调低 `tasksPerDevice` 只限制新建，已有任务照常管理。

## 执行与停止

命令由 agent 配置的 Shell 以非交互方式执行（`agent/src/tasks/process.ts`），Shell 的选择和参数见 [agent 配置文件](../guide/reference.md#agent-配置文件)。标准输入为空，标准输出和标准错误分别通过管道读取，没有 PTY，也不进入 tmux 或 recorder。命令继承 agent 进程的用户、环境变量和凭据。用户需要知道的影响见[执行环境](../guide/scheduled-tasks.md#执行环境)。

**进程集合。** Linux 和 macOS 上命令以新进程组启动（`detached`），进程组 ID 等于 Shell 的 PID。Windows 上命令在新建的 Job 对象中运行。怎样判断进程组或 Job 已空见[平台实现](platforms.md)（`agent/src/process-group.ts`）。

**结束判定。** 一次运行在三个条件都满足后才结束：Shell 已退出；进程集合已空；两条输出管道已关闭。

- 观察进程集合失败时，agent 记录诊断并继续等待，不把状态不明的进程集合当作已结束，运行名额一直占用。
- 进程集合结束后，输出管道最多再等 1 秒。Linux 和 macOS 上脱离进程组的后代进程仍持有管道时，agent 关闭自己的读取端，在 `output.error` 中记录输出不完整，然后完成这次运行；它不跟踪这类后台进程。

**停止。** `runs.stop` 把运行状态设为 `stopping` 并保存后返回，不等待进程结束。Linux 和 macOS 向进程组发送 SIGTERM，经过 `taskLimits.stopGraceMs` 仍未结束时发送 SIGKILL。Windows 直接终止整个 Job。进程集合结束后运行记为 `stopped`/`requested_stop`。任务没有默认的运行时长上限，输出超过上限也不会终止命令。

**agent 停止。** agent 正常停止时先拒绝新的写操作（返回 `cancelled`），取消全部定时器，再用同样的方式停止所有正在执行的运行（记为 `stopped`/`agent_stop`），等待它们结束并保存结果（停止 agent 的影响见[会话生命周期](terminal.md#会话生命周期)）。

## 持久化与恢复

**文件。** 任务数据保存在 agent 数据目录下的 `tasks/` 目录（权限 0700）：

| 文件             | 内容                                                       |
| ---------------- | ---------------------------------------------------------- |
| `<taskId>.json`  | `{task, lastScheduledAt?, runs[]}`，即定义和保留的运行记录 |
| `<runId>.stdout` | 这次运行的标准输出，权限 0600                              |
| `<runId>.stderr` | 这次运行的标准错误，权限 0600                              |

JSON 按 [JSON 状态](agent-lifecycle.md#目录与权限)的规则原子写入（`atomicJson()`）。输出文件以独占方式创建，只由这次运行写入。同一数据目录只运行一个 agent 实例，所有写入都经过上述串行队列。

**启动加载。** agent 在开放任务 RPC 和设置定时器之前完成以下步骤：

1. 读取全部 `*.json`。每个文件必须是普通文件，`task.id` 与文件名一致，`runs` 是数组，运行 ID 符合语法。读取全部输出文件的实际大小。
2. 在保存或删除任何文件之前，规范化每个任务：输出字节数按实际文件大小重算（文件变小时标记 `truncated`）；处于 `starting`、`running` 或 `stopping` 的运行记为 `unknown`/`unconfirmed`，任务设为 `paused`，`reviewRunId` 设为这次运行的 ID；处理过期的单次计划；计算 `nextRunAt`。
3. 保存规范化后的记录，整理历史，删除残留的 `.tmp` 文件和不属于任何记录的输出文件，然后设置定时器。

第 1、2 步出现任何错误时，整个任务子系统停用：所有任务 RPC（包括读取和预览）返回 `io_error`，消息固定为 `Scheduled task storage is unavailable`；摘要报告 `storageError`；磁盘上的文件保持原样；agent 的其他功能照常运行。详细原因在 agent 日志和 `kiteline-agent doctor` 中。修复后重启 agent 才会重新加载。

**核查。** agent 不根据旧 PID 查找或结束进程，异常退出前启动的命令可能仍在运行，所以未结束的运行一律记为 `unknown`，由拥有者核查。`reviewRunId` 存在期间：

- 定时不触发，手动运行返回 `busy`，`tasks.resume` 返回 `conflict`；
- `tasks.acknowledge` 必须携带等于当前 `reviewRunId` 的 `runId`，否则返回 `conflict`（details 带当前值）；成功后清除 `reviewRunId`，任务保持 `paused`，之后用 `tasks.resume` 恢复计划；
- `tasks.delete` 必须携带 `acknowledgeRunId` 且等于当前 `reviewRunId`；
- 这条运行记录保持 `unknown`，占用一个运行名额，不会因留存整理被删除。

操作步骤见 [agent 重启后的核查](../guide/scheduled-tasks.md#agent-重启后的核查)。

**保存失败。** 运行结果、跳过记录等已经确定的事实保存失败时，agent 保留内存中的结果并照常发布摘要，在 `kiteline-agent doctor` 中报告未保存的任务，下一次成功保存该任务时一并写入。这类失败不阻止后续的修改、接纳和留存整理。agent 停止时仍有未保存的事实，停止过程以错误结束。输出写入失败记入 `output.error`，不改变命令的退出结果。

## 记录留存

留存由 agent 配置文件 `limits` 中的以下键控制，数值见[限额](../guide/reference.md#限额)：

| 键                     | 作用                                       |
| ---------------------- | ------------------------------------------ |
| `taskHistoryRuns`      | 每个任务保留的已结束运行条数，含 `skipped` |
| `taskOutputBytes`      | 每次运行的输出上限，标准输出与标准错误合计 |
| `taskOutputTotalBytes` | 设备上所有任务输出文件的合计上限           |
| `taskRunsPerDevice`    | 设备同时占用的运行名额                     |
| `tasksPerDevice`       | 设备上的任务数量上限                       |

- **按任务整理。** 运行结束、接纳新运行、修改、暂停、恢复和确认核查之后，agent 只保留该任务最新的 `taskHistoryRuns` 条已结束运行，更早的记录连同输出文件一起删除。进行中的运行和 `reviewRunId` 对应的运行不计入、不删除。
- **输出写入。** 写入前先按两个上限预留字节，超出部分丢弃并设置 `truncated`，命令继续运行，管道继续读取。
- **跨任务腾空间。** 启动新运行前，如果删除所有可删除运行（已结束且不在核查中）的输出能为 `min(taskOutputBytes, taskOutputTotalBytes)` 腾出空间，agent 按 `acceptedAt` 从旧到新删除其中带输出的运行，跨所有任务，直到空间足够；否则一条也不删，新运行的输出可能被截断，甚至一字节也写不进去。
- **调低上限。** 新的上限只约束之后的写入，agent 不截短已有输出文件。
- **残留输出。** 删除运行时先改写 JSON 记录，再删除输出文件。没删掉的输出文件继续计入合计用量，并继续占用它的运行 ID，直到下一次接纳前清理成功。删除任务时输出文件删除失败，结果为 `partial`，`result` 为 `{removed:true}`。

**读取输出。** `runs.output` 从指定偏移读取一个流，单次最多 `taskLimits.outputReadBytes`（`agent/src/limits.ts`）。片段末尾不完整的 UTF-8 字符留到下一次读取。偏移超过当前文件长度，或输出文件已不存在时，从 0 开始返回，调用方应替换该流已显示的内容。响应中的 `finished` 表示输出已经停止增长，与命令是否成功无关。运行记录跨 agent 重启保留，但会按上述规则删除，`not_found` 不能证明某次运行从未发生。

## server 摘要

server 只保存每台设备的任务摘要，用于离线时显示最近状态和通知网页刷新。

- **发送。** agent 在每次收到 `welcome` 后，以及连接期间每次任务状态变化后，发送 `tasks.snapshot{revision, items, storageError?}`。`revision` 是 agent 内存中的计数器，每次变化加 1，agent 重启后从 0 开始。输出增长不产生摘要。
- **内容。** 每个任务一项，只含 `id`、`name`、`state`、`reviewRunId`、`nextRunAt`、`onceStatus`，以及当前运行和最近运行的摘要（`id`、`taskId`、`trigger`、`scheduledAt`、`acceptedAt`、`startedAt`、`endedAt`、`state`、`exitCode`、`signal`、`reasonCode`）。命令、工作目录、诊断文本和输出不在其中。
- **接收。** server 只保留上述字段（`projectTaskSnapshot()`，`server/src/task-summary.ts`）；带 `storageError` 的摘要统一保存为 `{revision, storageError:true, items:[]}`。server 只接受设备当前控制连接发来的摘要：每条连接的第一份摘要整体替换已有摘要，之后只接受 `revision` 更大的摘要。
- **保存与通知。** 摘要写入 SQLite 表 `taskSummaries(deviceId, snapshot, observedAt)`，每台设备一行，新摘要整体替换旧摘要；然后向所有网页事件连接发送 `tasks.changed{deviceId}`，网页收到后重新读取。
- **读取。** `GET /api/tasks[?deviceId=]` 为每台设备返回 `{deviceId, observedAt, snapshot, current}`；从未收到摘要时 `observedAt` 和 `snapshot` 为 `null`；`current` 只在设备当前的控制连接已经报告过摘要时为 true，不由设备在线状态推断。
- **详细数据。** 定义、运行列表和输出只通过设备 RPC 读取，经 server 内存转发，不写入 SQLite 或设备快照。
- **删除设备。** server 删除该设备的摘要行；设备上的任务定义、记录和定时不受影响。
