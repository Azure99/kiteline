# 通信契约

本文是 server、agent、recorder、工作台和本机命令行之间接口的参考，供修改其中任何一方的人阅读。字段定义见 `shared/src/protocol/` 中的类型，这里不重复字段表；各工具请求的业务含义见对应的 design 文档。

## 契约来源

- `shared/src/protocol/index.ts`：`appVersion`、固定限额 `limits`、`Reply`、各对象类型、控制消息、浏览器事件、`ChannelKind` 和校验函数。
- `shared/src/protocol/rpc.ts`：RPC 方法及参数、结果类型，`rpcMutates`，`gitWriteMethods`。
- `shared/src/protocol/tasks.ts`：定时任务对象。`shared/src/protocol/ipc.ts`：recorder IPC 消息和终端帧。
- `shared/src/protocol/ws.ts`、`file-stream.ts`、`http-stream.ts`、`stdio.ts`：心跳、帧发送、文件帧队列、HTTP 字节流、逐行 JSON。
- `server/src/limits.ts`、`agent/src/limits.ts`、`agent/src/config.ts`：其他固定限额和可调限额。
- `shared/src/version.json`：产品版本号。

server 和 agent 中的实现位置见[仓库结构](architecture.md#仓库结构)。JSON 字段使用 camelCase。ID 是随机的不透明字符串。时间是 UTC 的 ISO 8601 字符串。文件路径的约定见[路径与列表](files.md#路径与列表)。

### 版本匹配

server、agent 和工作台使用同一个产品版本 `appVersion`，版本必须完全相同，不同版本之间没有兼容适配。

- agent 连接控制 WebSocket 时带 `?appVersion=`。版本不同时，server 返回 HTTP 426 和 `version_mismatch`，`details` 为 `{component: "agent", clientVersion, serverVersion}`。agent 记录原因并按退避间隔继续重连；server 记下观察到的 agent 版本（`Device.release`），工作台据此提示[升级 agent](../guide/devices.md#升级-agent)。最近一次观察的版本不同时，发往该设备的 RPC 和数据通道返回 `version_mismatch`，不返回 `offline`。
- 工作台的每个 `/api/` 请求、事件连接和终端连接都带 `?appVersion=`。版本检查之后的接口在版本不同时返回 426（`component: "web"`）；登录和升级引导用到的接口不检查版本，见 [HTTP 接口](#http-接口)。
- 入口地址解析成功后的普通 `/api/` HTTP 响应（包括错误响应）带 `X-Kiteline-Version: <server 版本>`。工作台发现它与自身版本不同时，停止事件连接并显示版本提示。
- agent 的数据通道连接不检查版本，它属于已经通过检查的控制连接。

## 结果语义

RPC、文件写入和本机 IPC 返回 `Reply`，字段定义见 `shared/src/protocol/index.ts`。调用方必须先按 `outcome` 区分以下结果，不能只根据是否收到错误判断有无副作用。

| `outcome`   | 含义                                      |
| ----------- | ----------------------------------------- |
| `succeeded` | 请求的目标已经完成，`result` 是成功结果   |
| `failed`    | 已确认没有完成，也没有已知的副作用        |
| `partial`   | 一部分已经完成，`result` 带能够确认的部分 |
| `unknown`   | 结果未确认：请求可能已经执行，也可能没有  |

`tasks.run` 和 `runs.stop` 的 `succeeded` 表示 agent 已经接受启动或停止请求，命令本身的结果在运行记录中，见[执行与停止](scheduled-tasks.md#执行与停止)。读取的内容超出上限时仍为 `succeeded`，由结果中的 `truncated` 表示。

以下情况产生结果未确认：

- 控制连接在 RPC 返回前断开或被替换：server 返回 `unknown` 和 `offline`。
- agent 的成功结果超过 `controlMessageBytes`：agent 返回 `unknown` 和 `limit_exceeded`，不返回结果正文；非成功结果超限时，agent 保留该结果的 `outcome`，同样返回 `limit_exceeded`。
- 文件写入在 server 发出 `end` 之后失败；在此之前失败为 `failed`。
- recorder 请求超时或 recorder 退出。
- 工作台发出写请求后没有收到可解析的响应（网络中断、反向代理返回非 JSON 错误页）：工作台记为 `io_error` 和 `unknown`。写请求指 `rpcMutates` 为 `true` 的 RPC 和其他非 GET、非 HEAD 请求。本机命令行对写方法采用同样规则。

**不自动重放。** server、agent、工作台和命令行都不会自动重发写请求：结果为 `failed` 或 `unknown` 时不重发，连接恢复后也不补发。正确的处理是先重新读取实际状态，再由拥有者决定是否重试。读取请求可以重试：工作台把读取遇到的网络错误和 502、503、504，以及 server 在转发前以 502、503、504 拒绝的请求，标为可重试（`ApiError.retryable`）。

RPC 的 `id` 只用于关联回复和取消。server 拒绝与进行中的请求相同的 ID（`conflict`）；请求结束后 server 忘记这个 ID，再次发送同一请求会再次执行。server 不识别 `Idempotency-Key` 请求头，反向代理和 HTTP 客户端不能重试非 GET 请求，带这个头的请求也一样。定时任务的 `taskId` 和 `runId` 由调用方生成，留存期内重复时返回 `conflict`。

### 错误码

`error.code` 只使用下列值。`error.message` 是英文诊断，可以为空字符串；工作台按 `code` 显示本地化说明。“状态码”列是管理接口（`/api/`）返回错误时的 HTTP 状态码（`errorStatus`，`server/src/http.ts`）。开发服务代理使用另一张表（例如 `unsupported` 为 501，表外的错误为 502），见[错误响应](http-access.md#错误响应)。

| `code`                  | 含义                                                 | 状态码 |
| ----------------------- | ---------------------------------------------------- | ------ |
| `invalid_argument`      | 请求格式或参数无效                                   | 400    |
| `unsupported`           | 不支持的方法、通道种类或操作                         | 400    |
| `unauthenticated`       | 未登录、登录已过期或设备凭据无效                     | 401    |
| `forbidden`             | Origin 不匹配、绑定码或初始化 token 无效、通道已失效 | 403    |
| `permission_denied`     | 设备上的权限不足                                     | 403    |
| `not_found`             | 目标不存在                                           | 404    |
| `conflict`              | 目标已存在或状态已变化                               | 409    |
| `limit_exceeded`        | 超过大小或数量限额                                   | 413    |
| `version_mismatch`      | 版本不一致                                           | 426    |
| `busy`                  | 达到并发上限、目标正忙或尝试次数过多                 | 429    |
| `offline`               | 设备不在线或连接中断                                 | 503    |
| `timeout`               | 超过期限                                             | 504    |
| `cancelled`             | 已取消                                               | 500    |
| `io_error`              | 读写失败或 server 内部错误                           | 500    |
| `command_failed`        | tmux 命令执行失败                                    | 500    |
| `recording_unavailable` | 终端记录不可用，终端程序可能仍在运行                 | 500    |

## 请求入口与认证

### 请求入口

server 为每个 HTTP 请求和 WebSocket 升级确定一个入口 origin（`requestOrigin`）：

- **协议**：默认为 `http`。只有 `KITELINE_TRUST_PROXY_PROTO=1` 时才读取 `X-Forwarded-Proto`：值必须恰好是 `http` 或 `https`，缺失时为 `http`，其他值（包括 `https, http` 这样的多个值）返回 400 `invalid_argument`。开启后 server 信任任何能直接访问它的客户端发送的这个头，所以 HTTP 端口只能对反向代理和可信客户端开放。
- **主机**：取 `Host` 头。请求必须只有一个 `Host` 头，值中不能有空白和 `/ @ ? # , \`，否则返回 400。非默认端口保留在 origin 中。server 不读取 `Forwarded`、`X-Forwarded-Host` 或客户端 IP。

入口 origin 用于 Origin 检查、选择 Cookie 名称，以及生成接入命令、升级命令和脚本中的地址。一个 server 可以同时通过多个入口访问，每个请求按自己的入口 origin 处理。工作台使用绝对路径（`/api/`、`/proxy/` 等），只能部署在 origin 的根路径。

**Origin 检查**：请求的 `Origin` 头必须与入口 origin 完全相同，否则返回 403 `forbidden`（`Origin mismatch`）。适用于除 `POST /api/agent/bind` 以外所有非 GET、非 HEAD 的 `/api/` 请求，事件和终端 WebSocket 的升级，以及开发服务代理的非 GET、非 HEAD 请求和升级。server 不发送 CORS 响应头。反向代理的配置要求见 [HTTPS 与反向代理](../guide/server.md#https-与反向代理)。

### 登录与 Cookie

- `POST /api/setup` 用初始化 token 创建唯一的拥有者并登录；token 无效或过期返回 403，已经初始化返回 409。初始化 token 只以摘要和到期时间保存，有效期为 `setupTokenLifetime`。
- `POST /api/login` 校验拥有者密码，密码错误返回 401。密码用 bcryptjs（cost 12）哈希，长度限制见[限额](../guide/reference.md#限额)。
- 登录成功后，server 生成 32 字节随机令牌，数据库只保存它的 SHA-256 摘要和绝对到期时间（`loginLifetime`），使用期间不延长。
- Cookie 名称按入口协议选择：HTTPS 入口用 `kiteline_session` 并加 `Secure`，HTTP 入口用 `kiteline_session_http`。两者都是 `HttpOnly; SameSite=Strict; Path=/`，不设 `Domain`（只属于当前主机），带 `Expires`。不同主机各自登录；同一主机的 HTTP 和 HTTPS 入口使用不同的 Cookie；Cookie 不区分端口，同一主机、同一协议的不同端口共享登录。浏览器 `localStorage` 中的偏好按 origin（含端口）分别保存。
- server 每秒清理一次到期的登录会话，效果与退出登录相同。

**退出登录**（`POST /api/logout`）只删除当前登录会话：server 以关闭码 4003 关闭该登录的事件连接，取消它的全部数据通道，对它进行中的 RPC 发送 `rpc.cancel`，并用 `Max-Age=0` 清除 Cookie。其他登录不受影响。重置密码会删除全部登录会话，见[重置初始化 token 与密码](../guide/server.md#重置初始化-token-与密码)。

### 尝试次数限制

`/api/setup` 和 `/api/login` 共用一个限制器，`/api/agent/bind` 使用另一个。每个限制器分别统计每分钟的全局次数和每个来源的次数，成功和失败都计数，超过后返回 429 `busy`。来源是 TCP 连接的对端地址；经过反向代理时所有请求来自同一个地址，每来源限制的效果与全局限制相同。数值见[限额](../guide/reference.md#限额)。

### 设备认证

- `POST /api/agent/bind` 接收 `{code, name}`，返回 `{deviceId, deviceToken}`。绑定码的消费和设备的创建在同一个事务中完成；绑定码无效、过期或已经使用时返回 403。这个接口不需要登录，也不检查 Origin。
- `deviceToken` 是 32 字节随机值，server 只保存摘要，agent 把它保存在 `connection.json`。
- agent 的所有连接都发送 `Authorization: Bearer <deviceToken>`。令牌无效时返回 401，agent 随后停止重连。
- `POST /api/bindings` 生成绑定码，有效期为 `bindingLifetime`。`GET /api/bindings/:bindingId` 返回 `pending`、`consumed` 或 `expired`，`consumed` 时带 `deviceId`；已消费的记录随设备一起删除。绑定结果不明时的处理见[重新绑定](../guide/devices.md#重新绑定)。

## HTTP 接口

“检查”列中，“登录”指有效的登录 Cookie，“Origin”指上一节的 Origin 检查，“版本”指 `appVersion` 查询参数必须与 server 相同。

| 方法   | 路径                                         | 用途                     | 检查               |
| ------ | -------------------------------------------- | ------------------------ | ------------------ |
| GET    | `/healthz`                                   | 返回 `{status, version}` | 无                 |
| GET    | `/connect.sh` 等脚本                         | 接入、安装、升级脚本     | 无                 |
| GET    | `/downloads/agent/<版本>/<文件名>`           | agent 发布包和 `.sha256` | 无                 |
| POST   | `/api/agent/bind`                            | 用绑定码换取设备凭据     | 尝试次数           |
| GET    | `/api/bootstrap`                             | 是否已经初始化           | 无                 |
| POST   | `/api/setup`、`/api/login`                   | 初始化拥有者、登录       | Origin、尝试次数   |
| GET    | `/api/session`                               | 当前登录的到期时间       | 登录               |
| POST   | `/api/logout`                                | 退出当前登录             | 登录、Origin       |
| GET    | `/api/devices`                               | 设备列表                 | 登录               |
| GET    | `/api/agent/upgrade-command`                 | 各平台的 agent 升级命令  | 登录               |
| GET    | `/api/tasks`                                 | 定时任务摘要             | 登录、版本         |
| POST   | `/api/bindings`                              | 生成绑定码和接入命令     | 登录、Origin、版本 |
| GET    | `/api/bindings/:bindingId`                   | 绑定状态                 | 登录、版本         |
| PATCH  | `/api/devices/:deviceId`                     | 修改设备名称             | 登录、Origin、版本 |
| DELETE | `/api/devices/:deviceId`                     | 删除设备                 | 登录、Origin、版本 |
| POST   | `/api/devices/:deviceId/rpc`                 | 调用 RPC                 | 登录、Origin、版本 |
| DELETE | `/api/devices/:deviceId/requests/:requestId` | 取消进行中的 RPC         | 登录、Origin、版本 |
| POST   | `/api/devices/:deviceId/channels`            | 建立数据通道             | 登录、Origin、版本 |
| GET    | `/api/devices/:deviceId/download`            | 下载文件                 | 登录、版本         |
| GET    | `/api/channels/:channelId/content`           | 接收 `file.read` 的内容  | 登录、版本         |
| PUT    | `/api/channels/:channelId/content`           | 发送 `file.write` 的内容 | 登录、Origin、版本 |
| DELETE | `/api/channels/:channelId`                   | 取消数据通道             | 登录、Origin、版本 |
| 任意   | `/proxy/…`、`/absproxy/…`                    | 开发服务代理             | 见下文             |
| GET    | 其他路径                                     | 工作台静态文件           | 无                 |

- 脚本为 `/connect.sh`、`/connect.ps1`、`/upgrade.sh`、`/upgrade.ps1`（按本次入口和当前版本生成）和 `/install.sh`、`/install.ps1`。安装资源和静态文件接受 GET 和 HEAD，其他方法返回 405 和 `Allow: GET, HEAD`。
- `/api/tasks` 可用 `deviceId` 查询参数筛选；下载用 `workspaceId` 和 `path` 查询参数指定文件。
- 开发服务代理要求登录，非 GET、非 HEAD 请求和升级还要通过 Origin 检查，不检查版本。路径格式为 `/proxy/:deviceId/:port/…` 和 `/absproxy/:deviceId/:port/…`，见[开发服务访问](http-access.md)。
- 通过 Origin、登录和版本检查后，其他 `/api/` 路径返回 404。

**响应**：`/api/` 返回 JSON 和 `Cache-Control: no-store`，错误响应为 `{error: {code, message, details?}}`，状态码见[错误码](#错误码)。`POST …/rpc` 和 `PUT …/content` 在请求到达 agent 后总是以 HTTP 200 返回 `Reply`，非 2xx 响应表示 server 在转发前拒绝了请求。响应已经开始发送后出错时，server 断开连接，不追加 JSON。非预期的内部异常返回 500 和 `io_error`（`Internal server error`），详细信息只写入 server 日志。

**请求体**：JSON 请求体不能超过 `controlMessageBytes`，否则返回 413；从开始读取起 30 秒内必须接收完毕，超时后 server 断开连接。server 在请求体读完之前结束响应时，带上 `Connection: close`。

**静态文件**：带 `Cache-Control: no-cache` 和 `X-Content-Type-Options: nosniff`；不存在的路径返回 `index.html`（状态 200），`/assets/` 下不存在的文件返回 404。

## WebSocket 连接

| 路径                                | 发起方 | 检查               |
| ----------------------------------- | ------ | ------------------ |
| `/api/agent/control`                | agent  | Bearer，然后版本   |
| `/api/agent/channels/:channelId`    | agent  | Bearer、通道归属   |
| `/api/events`                       | 浏览器 | Origin、登录、版本 |
| `/api/channels/:channelId/terminal` | 浏览器 | Origin、登录、版本 |
| `/proxy/…`、`/absproxy/…`           | 浏览器 | 与 HTTP 请求相同   |

- 单条消息不超过 `controlMessageBytes`；`http.proxy` 的数据通道连接为 `dataChunkBytes`。
- `/api/agent/channels/:channelId` 带 `?connectionId=`：通道必须属于该设备的当前控制连接且尚未有 agent 加入，否则返回 403。
- `/api/channels/:channelId/terminal` 要求通道是该登录的 `terminal.attach`、agent 已经就绪、尚未有浏览器加入；通道不存在返回 404，不能加入返回 409。
- 其他路径的升级返回 404。升级被拒绝时，server 返回对应的 HTTP 状态码和 JSON `{error}`，并关闭连接。
- 浏览器按页面协议选择 `ws` 或 `wss`，agent 按保存的 server 地址选择。

### 控制连接

1. agent 带 Bearer 和 `appVersion` 连接 `/api/agent/control`，握手期限为 `interactionTimeout`。
2. 连接打开后，agent 发送 `hello`。
3. server 在 30 秒内没有收到 hello 时，以 1008 `hello_timeout` 关闭连接；hello 不合法时以 1008 `invalid_control_message` 关闭，同一设备已有的连接不受影响。hello 合法时，server 以 4001 `connection_replaced` 关闭同一设备的旧连接，保存快照和 `lastSeenAt`，发送 `welcome`，再发送 `watch.set`。从这时起设备在线，RPC 和数据通道都关联这个 `connectionId`。
4. agent 收到 welcome 后发送 `tasks.snapshot`。

控制消息的类型和字段见 `shared/src/protocol/index.ts` 的 `AgentControlMessage` 与 `ServerControlMessage`。

- `metadata.snapshot` 是完整快照，server 只接受同一连接中 `revision` 更大的快照。`tasks.snapshot` 同样按连接内递增的 `revision` 接受，每条连接的第一份直接替换；server 只保留白名单字段，见 [server 摘要](scheduled-tasks.md#server-摘要)。
- `watch.set` 是所有浏览器正在查看的、该设备上的工作区的并集。
- server 校验已知事件的字段，只转发白名单中的字段：`request.progress` 只发给发起请求的登录；`workspace.changed`、`sessions.changed`、`watch.status` 只发给正在查看该工作区的浏览器。已知类型的字段不合法时，server 以 1008 `invalid_control_message` 关闭连接；hello 完成后不认识的类型被忽略，hello 之前的其他消息则关闭连接。
- agent 收到不合法的消息时同样以 1008 `invalid_control_message` 关闭连接。

### 浏览器事件

连接建立后，server 立即发送一次 `devices.changed`。浏览器只能发送 `watch.set`，声明正在查看的设备和工作区，每次替换上一次的列表；消息定义见 `BrowserControlMessage`。目标数超过 server 的上限或发送其他消息时，server 以 1008 `invalid_event_message` 关闭连接。

| 事件                                                    | 接收者                   |
| ------------------------------------------------------- | ------------------------ |
| `devices.changed`（完整设备列表）、`tasks.changed`      | 所有浏览器               |
| `workspace.changed`、`sessions.changed`、`watch.status` | 正在查看该工作区的浏览器 |
| `request.progress`                                      | 发起请求的登录           |
| `channel.failed`                                        | 发起文件读取的登录       |

事件只提示浏览器重新读取，断线期间的事件不会补发。连接关闭后，工作台等待 1.5 秒，读取 `/api/session` 和设备列表后重新连接；这两次读取失败时，3 秒后再试（`web/src/devices/use-devices.ts`）。

### 心跳与背压

- 控制连接（两端）、事件连接和终端数据连接（server 的两侧和 agent 一侧）按 `heartbeatInterval` 发送 ping，超过 `heartbeatTimeout` 没有收到 pong 时强制断开。文件和开发服务的数据连接不发送 ping。
- 升级后的 socket 和 agent 的数据连接启用 TCP keepalive，间隔由 `tcpKeepAliveDelayMs` 决定。
- 控制连接和事件连接的发送缓冲超过 `shared/src/protocol/ws.ts` 的控制消息预算时，发送方以 1013 `control_backpressure` 关闭连接。

### 关闭码

| 关闭码 | 原因                      | 发送方          | 对端行为                       |
| ------ | ------------------------- | --------------- | ------------------------------ |
| 1000   | 正常关闭                  | 任一方          | 无                             |
| 1008   | `hello_timeout`           | server          | agent 重连                     |
| 1008   | `invalid_control_message` | server 或 agent | agent 重连                     |
| 1008   | `invalid_event_message`   | server          | 工作台重连                     |
| 1013   | `control_backpressure`    | server 或 agent | 重连                           |
| 4001   | `connection_replaced`     | server          | agent 停止重连                 |
| 4003   | `session_expired`         | server          | 工作台重读登录状态，回到登录页 |
| 4003   | `device_deleted`          | server          | agent 停止重连                 |

`session_expired` 用于事件连接，`device_deleted` 用于控制连接。agent 的重连间隔从 1 秒开始翻倍，最长 30 秒，每次另加 0 至 300 毫秒随机延迟，收到 welcome 后复位。agent 收到 HTTP 401、关闭码 4001 或 4003 后停止重连，进程继续运行，本机 IPC 和定时任务照常工作，`kiteline-agent doctor` 显示断开原因。HTTP 426 不会停止重连。

## RPC

1. 工作台通过 `POST /api/devices/:deviceId/rpc` 发送 RPC 请求。
2. server 检查：设备在线（否则 `offline` 或 `version_mismatch`），`id` 不在进行中（否则 `conflict`），该连接进行中的 RPC 少于 `pendingRequestsPerDevice`（否则 `busy`），`rpc.request` 不超过 `controlMessageBytes`（否则 `limit_exceeded`）。server 不检查方法名和参数字段，也不设期限，只等待 agent 回复或连接断开。
3. agent 对未知方法返回 `unsupported`，其他方法按下表设置期限后执行，到期时以 `timeout` 结束。
4. 取消：调用 `DELETE /api/devices/:deviceId/requests/:requestId`（只能取消同一登录的请求），或者原 HTTP 请求在响应前关闭，server 都会向 agent 发送 `rpc.cancel`。原请求仍以自己的 `Reply` 结束，通常为 `cancelled`。
5. 进度：长操作通过 `request.progress` 报告排队或执行进度，只通知发起请求的登录；字段见 `FileProgress`。

| 期限              | 方法                                       |
| ----------------- | ------------------------------------------ |
| `searchTimeout`   | `files.search`                             |
| `gitWriteTimeout` | `gitWriteMethods` 中的 Git 写方法          |
| 无总期限          | `files.copy`、`files.move`、`files.delete` |
| `rpcTimeout`      | 其他方法                                   |

期限的数值见[限额](../guide/reference.md#限额)。方法、参数和结果类型以 `shared/src/protocol/rpc.ts` 的 `RpcMethods` 为准；`rpcMutates` 定义哪些方法按写请求处理，结果不明时遵守[结果语义](#结果语义)。

运行时分派入口是 `agent/src/agent.ts` 的 `perform()`；定时任务和 Git 分别交给 `agent/src/tasks/rpc.ts` 与 `agent/src/git/rpc.ts`。各方法的业务规则见相应的终端、文件、Git、定时任务和开发服务访问文档。

## 数据通道

数据通道是一条独立的 WebSocket，用于传输文件内容、终端数据和开发服务字节流，不占用控制连接。

- `terminal.attach`：由 `POST …/channels` 创建，浏览器用 WebSocket `/api/channels/:channelId/terminal` 加入；agent 处理代码为 `agent/src/terminal/channels.ts`。
- `file.read`：`purpose` 为 `open`、`text`、`image` 时由 `POST …/channels` 创建，浏览器用 `GET /api/channels/:channelId/content` 接收；`purpose` 为 `download` 时由 `GET /api/devices/:deviceId/download` 在内部创建。agent 处理代码为 `agent/src/files/channels.ts`。
- `file.write`：`purpose` 为 `save`、`upload`，由 `POST …/channels` 创建，浏览器用 `PUT /api/channels/:channelId/content` 发送。
- `http.proxy`：由 `/proxy/`、`/absproxy/` 请求在内部创建；agent 处理代码为 `agent/src/http/channels.ts`。

公开的 `POST …/channels` 只接受前三种。参数见 `shared/src/protocol/index.ts` 的 `ChannelParams`，`meta` 见同文件的 `TerminalMeta` 和 `FileMeta`；接收端仍按各自职责校验输入。

### 建立

1. server 登记通道：设备必须在线，`channel.open` 不超过 `controlMessageBytes`，该连接的通道数少于 `channelsPerDevice`（从登记时开始计数）。通道绑定发起的登录、设备和当前 `connectionId`，然后发送 `channel.open`。
2. agent 连接 `/api/agent/channels/:channelId`，准备完成后发送 `ready`，失败时发送 `error`。从登记到 `ready` 的期限为 `interactionTimeout`。
3. server 校验 `meta`：文件通道的 `size` 为非负整数，`targetPath` 为不含 `..` 的相对路径；`file.write` 的 `size` 必须等于声明的大小；`open` 和 `image` 的内容类型只允许 `image/png`、`image/jpeg`、`image/webp`、`image/gif`，`open` 另允许 `text/plain; charset=utf-8`。
4. 由 POST 创建的通道：server 在 POST 响应中返回通道 ID 和元数据，浏览器必须在下一个 `interactionTimeout` 内用同一登录加入一次。下载和代理请求本身就是接收方，没有这一步。
5. 两侧就绪后，server 向 agent 发送 `start`，开始传输。

### 帧

文本帧是 JSON 控制消息，二进制帧是不超过 `dataChunkBytes` 的数据块。每个方向只有一个发送者，按顺序发送。

- **`file.read`**：agent 发送二进制数据块，总长度等于 `meta.size`，没有表示成功的帧。agent 留住最后一块，直到读取完成且检查全部通过才发出；失败时改发 `error` 并关闭。server 收到恰好 `meta.size` 字节时结束 HTTP 响应，字节不足的断流按读取失败处理。细节见[上传与下载](files.md#上传与下载)。
- **`file.write`**：server 把 PUT 请求体分块转发，请求体长度等于声明大小后发送 `end`。agent 校验并发布文件，发送 `result`，server 把这个 `Reply` 作为 PUT 的响应返回。
- **`terminal.attach`**：agent 在连接后立即发送通道就绪帧 `ready`，收到 `start` 后才开始恢复。终端帧和浏览器输入类型见 `shared/src/protocol/ipc.ts` 的 `TerminalFrame` 与 `BrowserTerminalInput`；输出和普通输入使用二进制帧。恢复完成前不允许输入，帧的顺序和含义见[附着与恢复](terminal.md#附着与恢复)、[输入](terminal.md#输入)和[尺寸](terminal.md#尺寸)。
- **`http.proxy`**：`ready` 的 `meta` 为空对象。`start` 之后通道只传二进制帧，收到文本帧按失败处理；连接以 1000 或无关闭码关闭表示正常结束，其他关闭码表示失败。见[请求转发](http-access.md#请求转发)。

### 流控与期限

- **文件**：接收端处理完一帧才读取下一帧，未处理的帧最多 `filePendingFrames` 帧、`filePendingBytes`，超过时以 `limit_exceeded` 结束；HTTP 一侧的写入背压同样传到数据通道。传输开始后，在 `channelIdleTimeout` 内没有进展时以 `timeout` 结束。
- **终端**：未确认的输出由 recorder 按附着控制，浏览器用 `consumed` 推进。server 和 agent 每条 socket 的发送积压超过 `terminalPendingBytes` 时，以 `limit_exceeded` 关闭该附着。见[附着与恢复](terminal.md#附着与恢复)。
- **开发服务**：使用 WebSocket 流的背压，块大小为 `dataChunkBytes`，不设空闲期限，见[连接寿命](http-access.md#连接寿命)。

### 结束与取消

- 浏览器调用 `DELETE /api/channels/:channelId`，或者 POST、GET、PUT、终端 WebSocket 在完成前关闭时，server 取消通道。
- 登录结束时，server 取消该登录的全部通道（`unauthenticated`）；控制连接断开或被替换时，取消属于它的通道（`offline`）。
- 取消时，server 向 agent 发送 `channel.cancel` 并关闭两侧连接；终端的浏览器一侧尚未收到 `ended` 或 `error` 时，先收到一条 `error` 帧。agent 收到 `channel.cancel` 后停止仍在进行的准备，迟到的连接和文件句柄直接关闭。
- `file.read` 失败（包括设备离线、通道已满）时，server 向发起的登录发送 `channel.failed`。
- 正常完成后，server 在 HTTP 响应结束时释放通道，并以 1000 关闭 agent 一侧。

## 本机 IPC

`kiteline-agent` 的本机命令通过本机 IPC 调用正在运行的 agent（`agent/src/local.ts`）。

- **端点**：Linux 和 macOS 为 Unix socket `<运行目录>/agent.sock`，权限 0600，agent 启动时重新创建。Windows 为命名管道 `\\.\pipe\kiteline-<哈希>`，哈希是用户 SID 和运行目录真实路径的 SHA-256，访问控制见 [Windows](platforms.md#windows)。本机 IPC 不使用 TCP。
- **协议**：在端点上使用 HTTP/1.1，只有 `POST /rpc`。请求体为 `{method, params}`，不超过 `controlMessageBytes`；响应是 `id` 为 `"local"` 的 `Reply`。每次调用在 agent 内的期限为 `rpcTimeout`（定时任务方法也一样），连接断开时取消；命令行最多等待 `rpcTimeout` 加 1 秒，其中 `attach` 和 `doctor` 不读取 `config.json`，使用默认的 `rpcTimeout`。

| 方法                 | 参数 → 结果                                  | 命令                            |
| -------------------- | -------------------------------------------- | ------------------------------- |
| `doctor`             | `{}` → `{runtime, items}`                    | `kiteline-agent doctor`         |
| `workspaces.list`    | `{}` → `{workspaces}`                        | `kiteline-agent workspace list` |
| `sessions.list`      | 与 RPC 相同                                  | `kiteline-agent terminal list`  |
| `sessions.create`    | 与 RPC 相同                                  | `kiteline-agent terminal new`   |
| `sessions.end`       | `{sessionId}` → `{ended}`                    | `kiteline-agent terminal end`   |
| `terminal.attach`    | `{sessionId}` → `{socket, paneId, windowId}` | `kiteline-agent attach`         |
| 定时任务的 14 个方法 | 与 RPC 相同                                  | `kiteline-agent schedule`       |

- 其他方法返回 `unsupported`，agent 正在停止时返回 `cancelled`。`sessions.end` 不需要 `workspaceId`。
- `terminal.attach` 在会话仍在创建时返回 `busy`；它只返回 tmux socket 和窗格标识，命令行随后直接运行 tmux 附着。
- `doctor` 的结果为 `{runtime, items: [{name, status, detail}]}`，`status` 为 `ok`、`warn` 或 `error`；命令行连不上 agent 时自己生成 `runtime: false` 的结果。检查项和退出码见 [check 与 doctor](agent-lifecycle.md#check-与-doctor)。
- `kiteline-agent bind` 不使用本机 IPC，它只在 agent 停止时写入凭据，见[绑定与连接](agent-lifecycle.md#绑定与连接)。

## recorder IPC

agent 按需启动 recorder，并通过 `RecorderConfig` 传入配置；Windows 上 recorder 运行在 Job 对象中。消息类型见 `shared/src/protocol/ipc.ts` 的 `RecorderRequest` 和 `RecorderMessage`，启动入口见 `agent/src/terminal/recorder.ts`，终端行为见[终端](terminal.md)。

- **传输。** agent 写 recorder 的 stdin，recorder 写 stdout，每行一条 JSON，每行不超过 `controlMessageBytes`（`shared/src/protocol/stdio.ts`）。发送队列按附着分别计量：某个附着的积压超过 `terminalPendingBytes` 时，发往该附着的新消息被拒绝（agent 一侧返回 `limit_exceeded`），其他附着不受影响。recorder 的 stderr 只保留有界前缀，用作退出原因。
- **请求结果。** 需要回复的请求带 `id`，recorder 用 `reply` 返回 `Reply`。agent 最多等待 `interactionTimeout`，超时按 `timeout` 和结果未确认处理；recorder 退出时，所有等待中的请求以 `recording_unavailable` 和结果未确认结束。
- **附着数据。** 终端帧和输出按会话、附着路由到浏览器。普通输入、粘贴、尺寸和消费确认不等待独立回复；一次粘贴始终是一条消息，不能拆成普通输入。
- **撤销创建。** `cancelCreate` 的成功回复表示所指向的创建不会再启动 tmux；得不到回复时，agent 停止整个 recorder。随后的查证规则见[会话生命周期](terminal.md#会话生命周期)。
