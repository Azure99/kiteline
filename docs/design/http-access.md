# 开发服务访问

server 用路径代理把浏览器请求转给设备上监听本机端口的开发服务，支持普通 HTTP、WebSocket 和 SSE。修改 `server/src/http-proxy.ts`、`server/src/proxy-headers.ts` 或 `agent/src/http/` 前阅读本文；使用方法和 Vite 配置见[使用工作台](../guide/usage.md#访问开发服务)。

## 地址与路径模式

| 路径                                 | 本地服务收到的请求目标            | 界面名称                            |
| ------------------------------------ | --------------------------------- | ----------------------------------- |
| `/proxy/<deviceId>/<port>/<rest>`    | `/<rest>`，去掉前缀               | “普通路径”（`devices.stripPrefix`） |
| `/absproxy/<deviceId>/<port>/<rest>` | 完整路径，保留 `/absproxy/…` 前缀 | “保留路径”（`devices.keepPrefix`）  |

- `<deviceId>` 是设备 ID（server 生成的 UUID），`<port>` 是 1 到 65535 的十进制端口。路径格式不符或端口越界时返回 400。
- 端口段后必须是 `/`。请求只写到端口（`/proxy/<deviceId>/3000`）或端口后直接跟查询串（`/proxy/<deviceId>/3000?x=1`）时，server 返回 308，`Location` 是补上 `/` 的地址（`/proxy/<deviceId>/3000/?x=1`）。308 在登录、Origin 和设备检查通过之后才发出。
- server 只解析前缀这一段。之后的路径和查询串按浏览器发出的原始请求目标转发：不解码，不合并重复的 `/`，不处理 `.` 和 `..` 段，末尾空的 `?` 也保留。
- 两种模式只差是否去掉前缀。server 不保存服务配置，也不按 Referer 或最近打开的页面推测目标。没有前缀的请求（例如普通路径模式下页面里写死的 `/script.js`）由工作台自身处理：对 `/assets/` 之外不存在路径的 GET 请求得到状态 200 的工作台 `index.html`，而不是 404，脚本和样式因此报 MIME 类型错误。

工作台生成链接的规则在 `web/src/lib/device-service.ts`：

- `serviceURL()` 生成以 `/` 结尾的根入口，用于“访问端口”对话框。
- `deviceServiceLink()` 转换终端里的本地链接。它只接受 `http:` 协议、主机为 `localhost`、`127.0.0.1`、`[::1]`、`0.0.0.0` 或 `[::]` 的 URL；没有端口时取 80；保留路径、查询串和片段标识（`#…`），去掉用户名和密码。路径已经以同一设备、同一端口的 `/absproxy/<deviceId>/<port>` 开头时，链接保持保留路径模式，不重复加前缀；其余链接使用普通路径模式。`https:` 链接和其他主机不转换。

agent 只连接自己网络命名空间里的回环地址：先连 `127.0.0.1:<port>`，这次连接在建立前失败时再试一次 `[::1]:<port>`，不查询 DNS（`agent/src/http/channels.ts`）。连接建立后不更换地址，也不重发请求。同一端口上 IPv4 和 IPv6 是两个不同程序时，代理总是到达 IPv4 那一个。监听 `0.0.0.0` 或 `::` 的服务可以通过回环地址到达；只监听其他网卡地址的服务到达不了。容器内 agent 能到达的范围见[在容器中运行](../guide/devices.md#在容器中运行)。

## 请求转发

一次代理请求按以下顺序处理（[请求流程](architecture.md#请求流程)有全局视图）：

1. server 依次检查：方法是否为 CONNECT、路径格式、入口的 Host 与 `X-Forwarded-Proto`（规则见[请求入口与认证](protocol.md#请求入口与认证)）、登录 Cookie、写请求和所有 WebSocket 升级请求的 Origin、设备是否存在、是否需要 308、Upgrade 是否为 `websocket`。不升级的 GET 和 HEAD 请求不要求 Origin。代理入口不检查浏览器的 `appVersion` 参数，版本不一致通过设备状态反映为 426（见[错误响应](#错误响应)）。
2. server 为这次请求创建一个 `http.proxy` 类型的内部数据通道，绑定当前登录会话、设备和设备当前的控制连接，向 agent 发送 `channel.open{kind:"http.proxy",params:{port}}`。浏览器不参与配对，公开的通道接口也不能创建或加入这种通道。
3. agent 先建立到 `/api/agent/channels/<channelId>` 的数据 WebSocket，再连接本地端口。连接成功后发送文本帧 `ready`，失败时发送 `error{code,message}` 后关闭。
4. server 发送 `start`。之后数据 WebSocket 只传二进制帧，server 用 Node 的 `http.request()` 发出请求，`createConnection` 直接返回这条字节流；agent 在字节流和本地 TCP 连接之间双向复制。帧大小、文本帧拒绝和关闭码规则见[数据通道](protocol.md#数据通道)。

每个上游请求使用一个新通道，不复用、不池化连接。到本地服务的协议固定为明文 HTTP/1.1，不使用 TLS 或 HTTP/2。

### 请求头

| 头                                            | 处理                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `Host`、`X-Forwarded-Host`                    | 设为浏览器访问工作台用的 host，含非默认端口                                    |
| `X-Forwarded-Proto`                           | 设为入口的 scheme，`http` 或 `https`                                           |
| `Forwarded`、浏览器发来的其他 `X-Forwarded-*` | 删除；代理不添加 `X-Forwarded-For` 和 `X-Forwarded-Prefix`                     |
| `Cookie`                                      | 删除 `kiteline_session` 和 `kiteline_session_http`，其他 Cookie 原样保留       |
| 逐跳头（见表下）                              | 删除；WebSocket 升级时重建 `Connection: Upgrade` 和 `Upgrade: websocket`       |
| `Content-Length`                              | 保留；没有 `Content-Length` 的分块请求重新以 `Transfer-Encoding: chunked` 发送 |
| `Origin`、`Referer`、`Authorization` 及其他头 | 原样转发                                                                       |

逐跳头指 `Connection`、`Proxy-Connection`、`Keep-Alive`、`Proxy-Authenticate`、`Proxy-Authorization`、`TE`、`Trailer`、`Transfer-Encoding`、`Upgrade`，以及 `Connection` 列出的头。入口 host 与 scheme 的确定方式见[请求入口与认证](protocol.md#请求入口与认证)。

### 响应头与正文

| 头                                                           | 处理                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `Set-Cookie`                                                 | 删除名为 `kiteline_session`、`kiteline_session_http` 的条目，其余保留                           |
| `Location`                                                   | 普通路径模式下，以单个 `/` 开头的值（不含 `//` 开头）前面加上代理前缀；其他值和保留路径模式原样 |
| 逐跳头（同请求）                                             | 删除                                                                                            |
| 状态码、`Service-Worker-Allowed`、`Clear-Site-Data` 及其他头 | 原样                                                                                            |

代理不改写 HTML、JavaScript、CSS 或 JSON 正文，也不注入 `<base>`。请求正文直接从浏览器连接流向上游，不经过管理接口的 JSON 正文限制，也不受文件上传限额约束。server 收到上游响应头后立即发给浏览器（`flushHeaders()`），正文按到达顺序以数据块转发，SSE 和流式 fetch 因此不需要等待完整响应。背压沿 Node 流和 WebSocket 传递，server 和 agent 都不缓存完整正文。

### WebSocket 升级

升级请求按普通请求转发。上游返回 101 且 `Upgrade` 为 `websocket` 时，server 先把过滤后的 101 头写给浏览器 socket，再依次写入随握手一起到达的两侧字节，然后双向连接两个 socket。`Sec-WebSocket-Protocol` 等端到端头原样通过，WebSocket 消息不受内部数据块大小限制。上游对升级请求返回非 101 状态时，server 把该响应原样写回浏览器并加 `Connection: close`。上游返回其他协议的 101 时按 502 处理。

## 连接寿命

- server 的 `requestTimeout` 为 0，代理请求没有总时长限制。唯一的时限在准备阶段：从创建通道到 agent 发出 `ready`，超过 `interactionTimeout`（`shared/src/protocol/index.ts`）返回 504。
- 进入字节流阶段后，代理不设空闲超时，文件通道的空闲时限和终端的确认规则都不适用于它。没有数据往来的 WebSocket 和 SSE 可以一直保持。
- server 对经过 Upgrade 的浏览器 socket、agent 对数据 WebSocket 和本地 TCP 连接开启 TCP keepalive，间隔为 `tcpKeepAliveDelayMs`（20 秒，`shared/src/protocol/index.ts`）。keepalive 只用于发现已经断开的对端，不会关闭安静但存活的连接。
- 每个代理请求从创建通道到结束都占用设备的一个数据通道名额（`serverLimits.channelsPerDevice`，`server/src/limits.ts`），终端显示和文件读写的数据通道共用这个上限，长时间打开的 WebSocket 和 SSE 一直占用。名额用满时新请求返回 429，已有连接不受影响。数值见[限额](../guide/reference.md#限额)。

连接在以下情况结束：

| 事件                                        | 结果                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| 上游响应完整结束                            | server 释放通道                                                              |
| 浏览器关闭连接或取消请求                    | server 中止上游请求并取消通道，agent 关闭本地连接                            |
| 本地服务提前关闭，或数据 WebSocket 异常关闭 | 尚未发出响应头时返回错误页；已发出响应头时直接断开浏览器连接，不追加错误内容 |
| 登录会话结束（退出登录或到期）              | 该登录会话的所有代理连接被关闭，其他登录会话不受影响                         |
| 设备控制连接断开或被替换、设备被删除        | 该连接上的所有代理通道被关闭                                                 |
| agent 停止                                  | agent 关闭所有代理通道                                                       |

已经按 `Content-Length` 或分块编码完整结束的响应，不会因为随后的关闭被改判为失败。关闭代理连接不会停止开发服务进程，也不会撤销上游已经完成的操作；WebSocket 和 SSE 断开后由项目自己的客户端决定是否重连。代理不自动重发请求，原因见[结果语义](protocol.md#结果语义)。

## 端口建议

“访问端口”对话框打开时通过 RPC `ports.list` 读取一次设备的 TCP 监听快照，之后只有点击“刷新监听端口”（`devices.refreshPorts`）才再次读取（`web/src/devices/port-dialog.tsx`）。关闭对话框或切换设备会取消正在进行的读取。工作台不保存端口列表，agent 不持续扫描，也不向端口发送 HTTP 探测。点击候选端口只填入输入框。

| 系统    | 来源                                                                        | 计入的监听地址                      |
| ------- | --------------------------------------------------------------------------- | ----------------------------------- |
| Linux   | `/proc/net/tcp` 和 `/proc/net/tcp6` 中状态为 LISTEN 的行                    | `0.0.0.0`、`127.0.0.1`、`::`、`::1` |
| macOS   | `LC_ALL=C /usr/sbin/netstat -an -p tcp`，超时 3 秒，输出上限 4 MiB          | `*`、`127.0.0.1`、`::1`             |
| Windows | 原生模块调用 `GetTcpTable` 和 `GetTcp6Table`（`native/windows/network.cc`） | `0.0.0.0`、`127.0.0.1`、`::`、`::1` |

实现位于 `agent/src/http/ports.ts`。其他 `127.x` 地址和具体网卡地址上的监听不计入。结果按端口去重、升序排列，最多返回 `agentLimits.listPageEntries` 项（`agent/src/limits.ts`），超出时 `truncated` 为 true，界面显示“仅显示部分端口”（`devices.partialPorts`）。Linux 上不存在 `/proc/net/tcp6`（IPv6 未启用）时按没有 IPv6 监听处理；其他读取或解析错误使整次读取失败。

候选只反映 agent 所在网络命名空间里的监听 socket。通过 NAT 发布、在本命名空间没有监听 socket 的端口不会出现；手工输入端口始终可用。

## 错误响应

server 在向浏览器发出响应头之前遇到的错误按下表返回（映射表在 `server/src/http-proxy.ts` 的 `failure()`）。检查顺序与[请求转发](#请求转发)第 1 步一致，因此格式错误的路径和无效的入口即使未登录也返回 400。

| 情况                                                              | 状态                                  | 错误码             |
| ----------------------------------------------------------------- | ------------------------------------- | ------------------ |
| 方法为 CONNECT（任何路径），或 Upgrade 不是 `websocket`           | 501                                   | `unsupported`      |
| 路径格式不符、端口越界，或 Host、`X-Forwarded-Proto` 无效         | 400                                   | `invalid_argument` |
| 未登录或登录已过期，且请求是页面导航                              | 302 到 `/login?returnTo=<原请求目标>` | `unauthenticated`  |
| 未登录或登录已过期，其他请求                                      | 401                                   | `unauthenticated`  |
| 写请求或 WebSocket 升级的 Origin 与入口不符                       | 403                                   | `forbidden`        |
| 设备 ID 不存在                                                    | 404                                   | `not_found`        |
| 设备未连接，且它最近一次连接尝试报告的 agent 版本与 server 不一致 | 426                                   | `version_mismatch` |
| 设备未连接，或控制连接在准备期间断开                              | 503                                   | `offline`          |
| 设备的数据通道名额已满                                            | 429                                   | `busy`             |
| 准备阶段超时                                                      | 504                                   | `timeout`          |
| 连接失败、上游异常或其他错误                                      | 502                                   | 其他               |

- 502 包括本地端口拒绝连接、本地服务在请求前关闭连接、返回非 HTTP 数据或无效状态码。
- 页面导航指带 `Sec-Fetch-Mode: navigate` 或 `Sec-Fetch-Dest: document` 的 GET 请求。登录成功后，工作台只在 `returnTo` 是同源的 `/proxy/…` 或 `/absproxy/…` 路径时跳回原地址（`web/src/lib/login-return.ts`），其他情况见[导航与上下文](interaction.md#导航与上下文)。
- 426 依据的版本记录只在 server 内存中（`Connections.releases`）。server 重启后，在 agent 再次尝试连接之前，未连接的设备返回 503。版本一致规则见[契约来源](protocol.md#契约来源)。
- 页面导航得到一个英文 HTML 错误页：标题为 `Device port <port>`，显示设备 ID 和错误消息，提供返回设备详情的 `Back to device` 链接和重新加载的 `Reopen` 按钮。其他请求得到 `text/plain` 消息。502 的消息末尾附加 `; check the port, listening address, and container network.`。所有错误响应带 `Cache-Control: no-store` 和 `Connection: close`；升级请求的错误响应直接写在原始 socket 上。
- 响应头已经发出或 WebSocket 已经升级后，任何失败都只能断开连接。
- 上游自己返回的状态码和正文（包括应用自己的 401 和 5xx）原样转发，不属于上表。
- 管理接口使用另一张映射表（`unsupported` 为 400，未列出的错误码为 500），见[结果语义](protocol.md#结果语义)的错误码表。

## 安全边界

- **项目页面与工作台同源。** 代理页面和工作台共用浏览器访问的同一个 origin。项目页面里的脚本可以像工作台一样调用 `/api/…`，浏览器会附带登录 Cookie，同源请求的 Origin 也能通过检查，所以这些脚本具有拥有者在工作台中的全部能力，包括操作其他设备。代理从转发请求中删除登录 Cookie，只是不让开发服务本身拿到登录凭据，不隔离页面脚本。
- **路径不是隔离边界。** 所有设备、所有端口的代理页面共用一个 origin。`Path=/` 的 Cookie、localStorage、IndexedDB 和 Service Worker 在项目之间、项目与工作台之间互相可见。`Service-Worker-Allowed` 和 `Clear-Site-Data` 原样转发，项目可以注册作用于整个 origin 的 Service Worker，也可以清除包括登录 Cookie 在内的全部 Cookie，使拥有者退出登录。
- **访问需要登录。** 复制出的地址仍要求登录会话，不是公开分享链接。退出登录、登录会话到期和删除设备都会关闭相关的代理连接；设备上的开发服务进程继续运行。
- **目标只在设备本机。** 代理只连接 agent 所在网络命名空间的回环地址，不接受其他主机。agent 只主动发起出站连接，不监听 TCP 端口。
- **代理不保存数据。** 请求和响应正文只以数据块经过 server 和 agent 的内存，不写入磁盘。

修改代理时必须保持以上性质，并保持：登录 Cookie 既不转给上游，也不接受上游设置同名 Cookie；写请求和升级请求检查 Origin；代理请求只通过当前控制连接创建的通道到达设备。
