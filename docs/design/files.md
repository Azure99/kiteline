# 文件

本文说明文件工具的机制和必须保持的不变量。界面操作见[使用工作台](../guide/usage.md#文件)，可配置限额见[限额](../guide/reference.md#限额)，内部阈值见 `agent/src/limits.ts` 和 `shared/src/protocol/index.ts`。

文件操作由 agent 以项目用户的权限在设备上执行；server 只转发 RPC 和数据通道，不保存文件内容。写操作的成功、失败和结果未确认按[结果语义](protocol.md#结果语义)处理。

## 路径与列表

### 路径模型

- 请求中的路径相对工作区根目录，使用 UTF-8 和 `/` 分隔，根目录写作 `.`。agent 拒绝绝对路径和含 `..` 段的路径（`relativePath`），名称中的空格、换行和 Unicode 原样保留。路径等字符串参数的长度限制由 `shared/src/protocol/index.ts` 的 `string()` 检查。
- 只有 Windows 上的 agent 检查 Windows 的保留名称和字符。Windows 路径规则和 macOS 的名称拼写解析见[平台实现](platforms.md)。
- agent 按原始字节读取目录项名称。名称不是合法 UTF-8 时，条目返回 `path: null` 和 `unavailableReason: "invalid_utf8"`；显示名只用于展示，浏览器不能用它构造请求路径。
- agent 解析路径时跟随符号链接，工作区内的链接可以指向工作区外。文件工具不是沙箱，访问范围就是项目用户的权限。
- 读取和保存跟随整条路径，保存写入链接指向的文件并保留链接本身。整理操作只解析父目录，最后一级按 `lstat` 处理：删除、重命名、移动和替换作用于链接本身，复制把链接复制为链接。

### 目录选择器

`directories.list` 和 `directories.mkdir` 接受设备平台的绝对路径，用于登记工作区前浏览和新建目录，起点是设备上报的 `homePath` 和 `rootPaths`。`workspaces.add` 把路径解析为真实路径；与已登记工作区的路径相同或是同一目录对象（`dev` 和 `ino` 相同）时，返回已有工作区。

### 分页与游标

- `files.list` 和 `directories.list` 都由 `Directories`（`agent/src/files/directories.ts`）分页读取。每页最多 `listPageEntries` 项，且不超过 `resultBytes`（`agent/src/limits.ts`）；单个条目超过上限时返回 `limit_exceeded`。
- 每页内目录排在前面，文件、链接和其他类型按名称（`localeCompare`）混排。浏览器把已加载的各页合并后按同一规则重排，所以大目录只对已加载部分排序。还有下一页时 `truncated` 为 true，界面标明列表未读完。
- 首页创建游标，后续页通过 `nextCursor` 续读。游标的存活期（`cursorLifetime`）从每次取得读取权时重新计时，到期后回收，读完最后一页立即释放。同一游标同时只允许一个读取，否则返回 `busy`。每台设备最多同时存在 `cursorsPerDevice` 个游标（`agent/src/limits.ts`），与 Git 仓库发现的扫描游标共用。
- 续页时目录的 `dev`、`ino` 或 `mtime` 已变化，或游标已过期、已释放，agent 返回 `conflict`；浏览器从首页重读，不拼接两次读取的结果。刷新时浏览器至少重读到此前已显示的条目数。
- 浏览器放弃一次浏览时用 `cursors.release` 归还游标。agent 释放游标时先停止后续读取，等进行中的读取结束并关闭目录句柄，再归还名额。

## 打开与编辑

### 内容识别

- 列表、搜索结果、文件 URL 和 Git 的打开入口都使用 `file.read` 数据通道的 `open` 用途。agent 在同一个只读句柄上读取前 32 字节：PNG、JPEG、GIF、WebP 文件头按图片处理，其他按文本处理。识别不看扩展名，无扩展名的图片同样可以预览。
- 文本受 `editorBytes` 限制，图片受 `imageBytes` 和 `imagePixels` 限制，下载受 `transferBytes` 限制；编辑上限不限制下载。
- agent 用 `O_NONBLOCK` 打开文件并只读取普通文件，FIFO 等特殊文件返回 `unsupported`，不会阻塞。
- 已有同一设备、工作区和路径的打开文件时，浏览器直接切换到它，不读取磁盘；迟到的读取结果不覆盖已打开的文件。

### 文本格式

- 判定规则在 `shared/src/protocol/text.ts`：含 NUL 字节视为二进制，不是合法 UTF-8 视为不支持，两者都不能编辑。BOM 单独记录。
- CRLF 的数量多于 LF 与单独 CR 之和时采用 CRLF，否则采用 LF。存在多种换行（包括任何单独的 CR）时标记 `mixedLineEndings`，保存时统一为采用的风格。编辑器内部统一使用 LF，文件末尾是否有换行随正文原样保留。
- 读完全部字节后，agent 在同一句柄上再次读取 `size` 和 `mtime`，有变化返回 `conflict`。返回的内容、元数据（含 `resolvedPath` 和普通权限位 `mode`）和 revision 对应同一份缓冲。

### revision

`revision` 由 `agent/src/files/read.ts` 的 `revisionOf()` 计算，表示解析后的路径、文件系统与内容。同一路径、同一文件系统、内容相同的原子重建得到相同的 revision，inode 变化本身不造成保存冲突。整理操作使用的 targetVersion 另有定义，见[整理操作](#整理操作)。

### 编辑容量

- 文本大小一律按 UTF-8 字节计算，包含 BOM 和保存时采用的换行。打开时，文件字节数和按保存风格重新编码后的字节数都不超过 `editorBytes` 才能编辑。
- 编辑器（`web/src/files/text-editor.tsx`）在应用每个修改前测量结果大小。结果超过上限且比当前内容更大时，整次修改被拒绝，文档和撤销历史都不变，粘贴不会被截断；撤销和重做同样适用。
- 浏览器使用草稿所属设备上报的 `editorBytes`，取得之前不允许修改，设备离线时沿用最后已知的值。上限下调到现有内容以下时草稿保留，只允许不增加大小的修改，内容降到上限以内才能保存。

### 草稿

草稿保存在当前页面的内存中（`web/src/files/drafts.ts`），以设备、工作区和路径标识，记录基准文本（打开或上次保存时的磁盘文本）、revision、编辑器状态和保存状态；显式退出登录时清空全部草稿。关闭草稿会释放正文、编辑器和撤销历史，迟到的请求结果只属于发出请求的那个打开实例，不会重新创建已关闭的草稿。草稿的用户可见寿命见[使用工作台](../guide/usage.md#文件)。

## 保存

### 保存流程

1. 浏览器固定本次保存的目标路径、基准 revision 和编码后的字节，之后的输入不影响这次发送。覆盖已有文件时带 `expectedRevision`；新建或另存时使用 `createOnly`，不带 revision。
2. 浏览器用 `file.write` 的 `save` 用途建立数据通道。agent 检查声明大小不超过 `editorBytes`（保存不使用 `transferBytes`）；覆盖时解析目标的真实路径，文件已不存在返回 `conflict`；新建时目标已存在返回 `conflict`。然后在目标所在目录创建临时文件，写入收到的正文，超过声明大小时失败。
3. 正文结束后，agent 读回临时文件并按文本规则校验，然后在发布锁内重新解析路径，对当前文件完整计算 revision。revision 与 `expectedRevision` 不同、文件已不是普通文件、或解析出的目标与准备时不同，都返回 `conflict`；revision 不同时附当前条目、targetVersion 和 revision。
4. 检查通过后，agent 把临时文件的权限设为原文件的普通权限位，用原子重命名替换目标（新建时用不覆盖重命名），返回按发布后的路径、`st_dev` 和本次字节计算的 revision。
5. 浏览器把本次发送的文本记为新的基准文本；发送期间又有编辑时，草稿仍为未保存。

原子替换会改变 inode：属主、属组、ACL 和 xattr 按新建文件的规则确定，其他硬链接路径仍指向旧内容。保存成功表示重命名已完成，agent 不调用 `fsync`。父目录不能创建临时文件或重命名失败时（例如只挂载了单个文件），保存失败、草稿保留，agent 不会退回到截断原文件后原地写入的方式。

### 发布锁

- 每个 agent 进程只有一把发布锁（`agent/src/files/publish.ts`）。改变目录项的步骤都在锁内执行：新建、重命名、目录选择器中的新建目录、临时文件的创建与登记、保存和上传的最终检查与发布、复制移动删除中每一步的检查与变更、临时文件清理。传输正文、复制正文和遍历目录在锁外进行。
- 因此同一 agent 上的保存与重命名、移动、删除不会交错：保存先完成时，重命名带走新内容；重命名或删除先完成时，之后的保存返回 `conflict`，不会在旧位置重新生成文件。
- 等待锁的请求被取消时立即返回；已经开始的发布动作执行到结束才释放锁。
- 外部写入者不加锁。终端、Git 和其他程序可以在检查与发布之间修改文件；revision、targetVersion 检查和不覆盖重命名只防止工作台自身的过期写入覆盖新内容。

### 不覆盖发布

- 新建和未明确选择替换的发布使用原子的不覆盖重命名，目标已存在返回 `conflict`。Linux 和 macOS 由随包的 `rename-noreplace` helper 执行，Windows 由原生模块执行，实现见[平台实现](platforms.md)。明确替换使用普通的原子重命名。
- 文件系统不支持不覆盖重命名时（部分 NFS、9p 挂载）发布失败，不退化为先检查再覆盖。helper 异常退出时结果为结果未确认。
- 挂载的 I/O 卡在内核中时，发布调用可能在请求超时后仍未结束，发布锁一直被占用，该设备上后续的文件写入会等待或超时。处理方法是修复挂载。

### 临时文件

- 保存、上传、复制文件和跨文件系统移动都先在目标所在目录独占创建 `.kiteline-<UUID>.tmp`（权限 `0600`；复制链接时创建临时链接），并在同一次持锁期间把父目录绝对路径和名称登记到 agent 数据目录的 `temporary-files.json`。登记失败时，创建者关闭并删除该临时项。
- 操作结束后，未发布的临时项被删除，已发布的只移除登记。清理失败时记录日志并保留登记，agent 下次启动时在后台逐项清理，停止时等待清理完成；读取登记失败时记录日志并忽略。
- 登记按路径记录，不跟踪之后的移动。清理结果不改变原操作的结果。

### 冲突与结果未确认

- 冲突后的覆盖是带上当前磁盘 revision 的再次保存，不是强制写入开关；原文件已消失时默认保存返回冲突，另存为新文件是单独的选择。界面选项见[使用工作台](../guide/usage.md#文件)。
- 发送后失去确认（连接中断，或数据通道在正文结束后才失败）时，浏览器保留这次发送的快照，草稿显示结果未确认。用户检查时浏览器读取原目标，磁盘文本与快照逐字节相同即确认已保存，否则保持未保存。浏览器不自动重发。
- 保存成功之后的刷新或读取失败只标记显示可能过期，不推翻保存成功的结论。

## 整理操作

### 新建与重命名

- `files.create` 在发布锁内独占创建（目录用 `mkdir`，文件用 `wx` 打开），同名时返回 `conflict`。`files.rename` 在同一目录内用不覆盖重命名改名，结果中的 `from` 是请求路径，`to` 是实际的新路径。
- 路径为 `.`，或最后一级与工作区根目录是同一目录对象时，重命名、移动和删除都被拒绝；指向根目录的符号链接仍按链接处理。

### 批量请求

- `files.copy` 和 `files.move` 的每一项给出源路径、同一工作区内的目标路径和 `collision`（`error` 或 `replace`），`replace` 必须带确认时的 `expectedTargetVersion`；`files.delete` 给出路径列表。
- 每批最多 `listPageEntries` 项，请求大小由 `agent/src/files/operations.ts` 的 `parseItems()` 限制。一批内逐项按顺序执行；每个 agent 同时最多执行 `pendingRequestsPerDevice` 批，超出返回 `busy`。这三个方法没有总超时，可以取消。执行中合并进度通知，每项结束时另发一次。
- 提交后的批次固定，列表刷新不会扩大选择。

### targetVersion 与替换

- `targetVersion` 由 `agent/src/files/paths.ts` 的 `versionOf()` 计算，经 `files.inspect` 返回，表示确认时目标的路径和文件系统状态。替换前 agent 在发布锁内重新计算，与确认值不符时返回 `conflict`，并附当前条目和新的 targetVersion。它与保存 revision 不同，对象身份或元数据变化也会造成冲突。
- 只能替换非目录项，目录不会被替换或合并，源或目标是目录时同名即冲突。替换最终符号链接只替换链接本身。
- 源与目标相同、把目录复制或移动到自身或其子目录，都被拒绝。

### 复制与移动

- 复制目录时递归处理，每个子项单独检查和发布。普通文件经临时文件复制，复制前后比较 `size`、`mtime` 和 `ctime`，有变化返回 `conflict`。复制保留普通权限位（目录先以 `mode | 0700` 创建，子项完成后恢复原权限）；属主、ACL 和 xattr 按新建规则确定，硬链接复制为独立文件，符号链接复制为内容相同的链接。设备节点、socket 和 FIFO 返回 `unsupported`。
- 同一文件系统内的移动在发布锁内重新检查后直接重命名，`replace` 时覆盖，否则不覆盖。只有 `EXDEV` 错误转为跨文件系统流程，其他错误照实返回。
- 跨文件系统移动先复制再删除源。复制普通文件时记录实际读取的对象；目标发布后，agent 在发布锁内确认源仍是该对象且 `size`、`mtime`、`ctime` 未变，才删除源，否则源和目标都保留，该项记为部分完成并报告冲突。目录先创建目标、递归移动子项，最后只在源目录仍是原对象时 `rmdir`，移动期间新出现的子项会使它失败。

### 删除

- 删除逐项 `lstat`，用 `opendir` 遍历并 `unlink`，目录在子项处理完后 `rmdir`。每一步都在发布锁内确认父目录和当前对象仍是开始时的对象，被替换的路径跳过并报告 `conflict`。
- 删除不跟随最终符号链接，但会进入目录下的全部可见子项，包括同设备的 bind 挂载和其他设备的挂载点。
- 设备节点、socket 和 FIFO 返回 `unsupported`，包含它们的目录因此无法完全删除。名称不是合法 UTF-8 的子项被保留并报告。
- 单项失败后继续处理兄弟项。遍历不是快照，删除期间新出现的子项会使 `rmdir` 失败。

### 保留两份

`files.inspect` 带 `suggestCopyName` 时，agent 在真实目标目录中从名称序号 2 开始尝试，最多尝试 `copyNameAttempts` 次，返回第一个不存在的名称。普通文件的序号放在最后一个不在开头的 `.` 之前（`config (2).json`、`a.tar (2).gz`），目录、无扩展名文件和 `.env` 这类点文件把序号加在末尾。遇到 `ENAMETOOLONG` 或尝试用尽时不返回建议。建议不预留名称：执行时仍用不覆盖方式发布，名称已被占用时返回 `conflict`，不自动换名。

### 结果与取消

- 每项结果为 `succeeded`、`failed`、`partial`（部分子项已完成）或 `unknown`，附完成数和失败详情。详情受条数和整批结果预算限制，超出时标记 `truncated`；预算分配见 `agent/src/files/operations.ts`。整体结果：全部成功为成功；任一项为 `unknown` 时为 `unknown`；否则有已完成内容为 `partial`，没有为 `failed`。
- 取消（用户取消、连接断开、agent 停止）立即给出结果：没有开始或确认没有副作用的项为 `failed`，已完成一部分的为 `partial`，正在执行文件系统变更的项为 `unknown`，取消前已全部完成的项仍为 `succeeded`。
- 给出结果后，执行体停止安排后续步骤，但已发出的 I/O、文件句柄、helper 和锁保持到真正结束，期间仍占用 `pendingRequestsPerDevice` 的批次名额。结束后 agent 发送工作区变化事件，不回送第二份结果。已完成的部分不回滚。

### 与打开文件的协调

- 本页有保存正在进行时，浏览器拒绝重命名、移动或删除保存源、保存目标及它们的祖先目录，移动的替换目标同样检查。复制和上传依靠各自的版本检查。
- 本页重命名或移动成功后，浏览器把受影响的打开文件改到新路径并保留草稿内容，再读取新路径：新路径的磁盘原始文本与草稿的基准文本相同才采用新的 revision，否则标记磁盘已变化。删除成功后草稿保留并标记文件已删除；结果为部分完成或结果未确认时，浏览器用 `files.inspect` 核对原路径。
- 新路径上已有另一个打开的草稿时，浏览器提示重复，两份都不覆盖。其他浏览器通过刷新发现变化。

## 搜索

`files.search`（`agent/src/files/search.ts`）在工作区根目录运行随包的 ripgrep（程序目录下的 `dist/native/bin/rg`），不使用 `PATH` 中的 `rg`。

- 名称模式用 `rg --files` 列出文件（不含目录），返回相对路径中包含查询字符串的文件，比较区分大小写。正文模式用 `--fixed-strings`，不带 `-i`。
- 两种模式都使用 `--no-config --hidden -g !.git`，`includeIgnored` 为 true 时另加 `--no-ignore`；macOS 上与 `.git` 是同一对象的大小写变体也被排除。命令不带 `--follow`，符号链接不进入结果。忽略文件的语义（包括 Git 全局的 `core.excludesFile`）和二进制文件的处理都由 rg 决定。用户可见的规则见[使用工作台](../guide/usage.md#文件)。
- 结果最多 `searchMatches` 条，总量约为 `resultBytes`，运行时间受 `searchTimeout` 限制。达到任一上限时 agent 停止 rg，返回已得到的结果并标记 `truncated`。用户取消返回 `cancelled`，与无匹配和超时都可区分。
- 正文结果每条只返回该行开头不超过 `searchLineBytes` 的片段和最多 `searchRanges` 个高亮区间，区间是片段内的 UTF-16 索引。命中位置在片段之外时，结果仍给出真实路径和行号并标记 `truncated`。
- 路径不是合法 UTF-8 或超过 `searchPathBytes` 的结果被省略，整个结果标记 `truncated`。rg 退出码 0 和 1 都表示正常结束，其他退出码返回 `io_error`，附 stderr 不超过 `searchErrorBytes` 的前缀。
- 浏览器发出新查询时取消旧查询并丢弃迟到的结果。打开搜索结果走[内容识别](#内容识别)。

## 图片预览

- agent 用 `image-size` 只解析文件头，得到类型和宽高，不解码像素。类型不是 PNG、JPEG、WebP、GIF 或文件头无法解析时返回 `unsupported`；文件超过 `imageBytes` 或宽乘高超过 `imagePixels` 时返回 `limit_exceeded`。
- 像素数据损坏只能在浏览器解码时发现，浏览器此时显示解码失败，原文件仍可下载。
- 响应的 `Content-Type` 只能是识别出的格式对应的 `image/png`、`image/jpeg`、`image/webp` 或 `image/gif`。SVG 不在识别范围内，按文本打开。

## 上传与下载

### 上传

- 浏览器一次上传一个文件，每个文件使用一个 `file.write` 的 `upload` 用途通道，建立时声明 `size`，以及 `createOnly` 或确认时的 `expectedTargetVersion`。agent 检查大小不超过 `transferBytes`，在发布锁内按[替换规则](#targetversion-与替换)检查目标，再创建临时文件。
- 正文结束后，agent 在发布锁内确认目标父目录仍是同一对象，重新检查目标和 targetVersion，然后发布。替换普通文件时保留它的普通权限位；新建文件或替换符号链接时使用默认创建权限（`0666 & ~umask`）。属主、属组、ACL、xattr 和特殊权限位按新建规则确定。
- 只有 agent 返回的结果表示成功，界面把正文发送完毕和设备完成写入分开显示。server 在转发正文结束帧之前失败时结果为失败，之后失败时为结果未确认（`server/src/file-transfer.ts`）。
- 取消时浏览器先停止安排后续文件，再删除当前通道，agent 删除未发布的临时文件。取消请求失败时可以再次取消；当前文件的结果仍以原上传请求的响应为准。

### 下载

- 下载地址 `/api/devices/<deviceId>/download?workspaceId=…&path=…` 是稳定的 GET 地址。浏览器用同源的 `a[download]` 交给浏览器的下载管理器，工作台不跟踪下载进度。每次 GET 重新鉴权并创建新的 `file.read` `download` 通道，不复用句柄或缓存。
- agent 打开文件时从句柄取得长度并检查 `transferBytes`，然后按偏移读取直到读满这个长度：短读继续读取，提前遇到 EOF 或 I/O 错误时失败。之后追加的内容不包含在本次下载中，读满后文件被替换或缩短不影响已读结果；期间被就地修改的文件可能混合新旧字节。
- 响应为 `200`，`Content-Length` 是打开时的长度，带 `Cache-Control: no-store`。server 忽略 `Range`。

### 响应头

`Content-Type` 按用途确定：`open` 为识别出的图片类型或 `text/plain; charset=utf-8`，`text` 为 `text/plain; charset=utf-8`，`image` 为识别出的图片类型，`download` 为 `application/octet-stream`。下载响应还带 `Content-Disposition: attachment; filename="download"; filename*=UTF-8''<编码后的文件名>`。所有文件内容响应都带 `X-Content-Type-Options: nosniff`，HTML 和 SVG 不会在工作台的源下执行。开发服务代理不使用这条规则，见[开发服务访问](http-access.md)。

### 通道名额

`open`、`text`、`image`、`download`、`save`、`upload` 共用每台设备 `transfersPerDevice` 个文件通道名额，通道清理完成前仍占用名额，超出时返回 `busy`。消费方变慢时来源暂停读取。帧格式、配对、server 的通道上限与空闲超时，以及读取完成的判定见[数据通道](protocol.md#数据通道)。

## 变化监听

- 浏览器通过事件 WebSocket 的 `watch.set` 声明正在使用的设备和工作区。server 汇总所有浏览器的目标，按设备下发，agent 只监听其中仍登记的工作区。监听实现位于 `agent/src/watch-roots.ts`，使用 chokidar，不跟随符号链接，不轮询。Linux 在独立 worker 内处理监听建立、文件系统事件和关闭，避免这些工作阻塞 agent 的交互请求；其他平台在主线程运行。
- 工作树监听排除 `agent/src/watch-roots.ts` 的 `excluded` 目录、`.git` 内部，以及工作区内已发现仓库的 gitDir 和 commonDir。agent 同时监听根目录的上一级，根目录被替换后能重新挂上。Linux 的 Chokidar 补丁按目录身份变化重建监听，并更新共享底层 handle，避免同名新目录继续引用旧 inode。被排除的目录仍可浏览，只靠定时刷新更新。
- Linux 工作树只为目录建立 watch，通过 Chokidar raw 事件接收目录内的文件变化，再按同一工作树边界和排除规则合并通知。初次遍历仍检查每个文件；目录数量本身很大时仍可能耗尽系统监听配额。Git 元数据不使用此目录模式。
- Git 元数据监听覆盖每个已发现仓库的 gitDir 和 commonDir，只看顶层文件和 `gitTrees` 指定的状态目录，不看 `objects/`。多个工作区共享同一元数据目录时共用一个监听。
- 文件系统事件按 `watchDebounce` 合并为 `workspace.changed`，通知文件、Git 和仓库发现刷新，不带文件内容。agent 自己完成写操作时立即发送事件。
- 全部监听就绪后 agent 发送 `watch.status` 为 `normal`；任一监听报错时为 `degraded` 并附原因，界面显示监听退化。Linux 保留同一监听的首次错误原因，抑制后续重复错误报告，已建立的部分监听继续工作。worker 异常退出也报告 degraded，不自动重启；后续明确订阅可重新建立 worker。
- 没有订阅或控制连接断开时释放监听；Linux 同时结束当前 worker，最终停止等待关闭中的 worker 全部退出。重连后的新订阅与旧 worker 的退出分开处理，旧状态不会覆盖新订阅。agent 写操作的即时变化通知仍直接由主线程发出。
- 浏览器的刷新节奏在 `web/src/lib/use-workspace-refresh.ts`：事件合并使用 `watchDebounce`，可见页面还按 `visibleRefreshInterval` 定时刷新；进入工具立即刷新，重新连接和页面恢复可见时也触发刷新。同一视图同时只有一个刷新请求，期间到达的事件在它完成后再触发一次。
- 文件工具刷新当前目录，并重新读取当前显示的打开文件：revision 与草稿的基准 revision 不同时只标记磁盘已变化，不替换编辑器中的内容。草稿、磁盘和 Git index 的关系见 [Git 写操作](git.md#写操作)。

## 范围外

- 上传目录，或把目录打包下载。
- 跨工作区或跨设备的复制和移动。
- 回收站：删除是永久的。
- PDF、音频、视频等图片以外的预览，以及图片编辑。
- 跨工作区搜索、正则搜索和不区分大小写的搜索。
- 下载断点续传。
- 编辑权限、属主或 ACL。
- 持久保存草稿，或恢复已关闭的草稿。
- 在文件工具中处理名称不是合法 UTF-8 的文件，以及删除设备节点、socket 和 FIFO；这些需要在终端中处理。
