# Git

本文说明 Git 工具的机制和必须保持的不变量。agent 调用设备上的原生 Git（最低版本由 `agent/src/prerequisites.ts` 的 `gitRequirement` 检查）。界面操作见[使用工作台](../guide/usage.md#git)，限额数值见[限额](../guide/reference.md#限额)。

## 仓库发现

### 扫描

- `repos.discover`（`agent/src/git/repos.ts`）从工作区根目录开始深度优先遍历。目录下存在 `.git`（目录或 gitfile），或同时存在 `HEAD` 文件和 `objects` 目录（裸仓库）时，agent 用 `git rev-parse` 取得 `--show-toplevel`、`--git-dir` 和 `--git-common-dir`。
- 找到仓库后继续向下遍历，嵌套仓库、已初始化的子模块和工作区内的 linked worktree 都作为独立仓库发现。遍历跳过 `.git` 本身；大小写不同的 `.git` 变体只有与 `.git` 是同一对象时才跳过。
- 扫描不进入符号链接，也不使用 ignore 规则或变化监听的排除列表，`node_modules` 等目录同样会被扫描。
- 仓库根目录在工作区之外时不被采用。工作区是外部仓库的子目录时，父仓库不会成为操作对象；linked worktree 只有位于工作区内才会被发现，它的 gitDir 和 commonDir 可以在工作区外。
- 无法读取的目录、无效的 gitfile 和名称不是 UTF-8 的目录作为 `issues` 单独返回，扫描继续。
- 裸仓库标记为 `available: false`，不进入其子目录，对它的读写返回 `unsupported`。
- 每次扫描受目录数 `discoveryDirectories`、时长 `discoverySlice` 和结果大小 `resultBytes` 限制，常量在 `agent/src/limits.ts`。本文的“结果上限”都指 `resultBytes`。未完成时返回 `scanCursor`，下一次调用从同一位置继续；只有 `complete` 为 true 才表示扫描完成。扫描游标与目录列表共用游标名额和存活期限（见[文件](files.md#路径与列表)），过期后返回 `conflict`，浏览器从根目录重新扫描。
- 浏览器为每个活跃工作区保留一轮扫描，每次刷新推进一步，直到完成；完成后的下一次刷新才开始新一轮，并以新一轮的结果替换仓库列表。仓库按路径排序；地址中没有指定仓库时，浏览器自动选择第一个可用仓库。

### 仓库身份与路径

- `repoId = SHA-256(rootPath, gitDir, commonDir, 三者的 dev 和 ino)`。每个工作树有自己的 repoId，linked worktree 不与主工作树合并。
- agent 只接受自己发现过、且仍属于某个活跃工作区的 repoId，其他返回 `not_found`。每次读写前 agent 重新解析仓库：身份不同返回 `conflict`，仓库已不可用返回 `not_found`。目录被移动或 gitfile 损坏后，旧 repoId 不会指向新位置。
- Git 条目的 `path` 和 `oldPath` 相对仓库根目录，文件工具的路径相对工作区根目录。浏览器打开文件时用 `Repo.path` 拼接，例如仓库 `services/api` 中的 `src/app.ts` 在文件工具中是 `services/api/src/app.ts`。

### Git 进程

- 所有 Git 命令由 `agent/src/git/process.ts` 用 argv 启动，不经过 Shell，工作目录是仓库根目录。stdin 只用于传入数据，写完即关闭。Linux 和 macOS 上 Git 在独立的进程组中运行，没有控制终端。
- 环境继承 agent 的环境，设置 `GIT_TERMINAL_PROMPT=0`，并删除会改变仓库定位或路径匹配方式的变量（如 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_LITERAL_PATHSPECS`，完整列表见源码），Windows 上按不区分大小写匹配变量名。用户的 Git 配置、身份、凭据、SSH、hooks 和签名保持不变。
- 读命令带 `--no-pager --no-optional-locks -c color.ui=false`，不顺带刷新 index，避免自己的读取触发变化事件；写命令只带 `--no-pager`。
- 一次性读取的 stdout 不超过结果上限，超出时返回 `limit_exceeded`；流式解析的命令逐条处理，单条记录不超过结果上限。stderr 保留前 32 KiB。
- 路径参数写成 `:(top,literal)<path>`，按字面匹配；`git diff --no-index` 的磁盘路径加 `./` 前缀。

## 状态与分页

### 读取

- `git.status` 每次都完整读取机器格式的 Git status 并流式解析到结束（`agent/src/git/status.ts`）：统计全仓库的 `totalCount`、`stagedCount` 和 `hasConflicts`，只保留从 `offset` 开始的一页（最多 `listPageEntries` 项，且不超过结果上限）。rename 的两个路径、同时有暂存和工作树变化的条目都只算一项。
- 每个条目包含 index 和工作树两侧的状态与类型（类型由 porcelain 的 mode 得出）、冲突各 stage 的类型和子模块状态，字段见 `shared/src/protocol/index.ts`。
- 未跟踪项的类型只对当前页的合法路径用 `lstat` 取得；`lstat` 失败时整页读取失败。
- 路径不是合法 UTF-8 的条目返回 `pathError`（`\xNN` 转义的诊断名），不返回 `path`，不能被选中，也不能跳转到文件工具；它仍参与计数、冲突判断和 token。rename 或 copy 任一端无效时整条无效。合法的 U+FFFD 字符是普通路径。
- 结果还包括 HEAD 身份（`symbolicRef` 和 `oid`；未提交过时 `oid` 为 null，detached 时 `symbolicRef` 为 null）、upstream、ahead 和 behind，以及[进行中的操作](#冲突与进行中的操作)。

### token

- `indexToken` 由 `agent/src/git/observe.ts` 的 `observeIndex()` 计算，包含仓库身份、HEAD、暂存内容和冲突状态。没有 HEAD 时，以本仓库对象格式的空树作为比较基准，计算不会写入对象。
- indexToken 只取决于 HEAD、可提交的内容和冲突，不取决于 index 文件的 mtime 或 inode；工作树变化不改变它，内容相同的 index 重建也不产生冲突。存在冲突时 status 不返回 indexToken。
- `listToken` 在 indexToken 基础上包含完整 status 的摘要，ahead 或 behind 的变化也会改变它。
- status 在读取 porcelain 之前计算 indexToken。读取期间的外部修改可能让条目与 token 不一致，因此写操作执行前都会重新检查。

### 翻页

- 首次读取和刷新不带 token。翻页时浏览器带上当前的 `listToken` 作为 `expectedListToken`；不一致时 agent 返回 `conflict`，浏览器在当前 offset 不带 token 重新读取，不拼接两次读取的结果。
- 刷新在当前 offset 重新读取，列表可以重排；offset 超出总数时浏览器回退到已访问过的较小 offset，没有则回到 0。
- 每页都带全仓库的计数和 indexToken，提交范围是完整的 index，与当前页显示了哪些条目无关。

### 选择

- 批量选择只在当前页内有效（`web/src/git/selection.ts`）。翻页、切换仓库、`symbolicRef` 变化，或 detached 状态下 OID 变化时清空选择；同一分支的 OID 前进不清空。
- 刷新后只保留各方面都未变的项，其余取消并提示数量；新出现的条目不会被自动选中。

## Diff 与历史

### 工作树与暂存区 diff

- `git.diff` 的 `side` 为 `worktree` 时比较 index 与磁盘，为 `staged` 时比较 HEAD 与 index（没有 HEAD 时暂存项全部显示为新文件），为 `commit` 时比较提交与所选父提交。
- 工作树和暂存区的 diff 先重读 status，确认所选条目仍在该区域；已不适用时返回 `conflict` 和 `details.reason = "change_unavailable"`，浏览器清除旧 patch 并显示中性的空状态。
- 未跟踪项只支持普通文件和符号链接，用 `git diff --no-index /dev/null ./<path>` 生成把整个文件作为新内容的 patch；目录等其他类型返回 `unsupported`。
- diff 的共同选项以 `agent/src/git/observe.ts` 的 `diffOptions` 为准：关闭颜色、外部 diff 和 textconv，按仓库根目录处理路径，并保留子模块变化。生成 patch 时保留空上下文行的前缀，避免解析器把它们丢弃（`agent/src/git/diff.ts`）。
- `summary`（`path`、`oldPath`、`status`、`binary`、`oldMode`、`newMode`）来自 `--raw` 和 `--numstat` 的机器输出，`binary` 按 numstat 的 `-` 标记判断。要操作的路径只来自 status，不从 patch 标题推导。
- patch 不超过结果上限减去 summary 的长度，超出时截断并标记 `truncated`。

### 浏览器显示

- patch 已截断、物理行数超过 `diffRenderLines`、解析失败或含无法解释的正文时，浏览器（`web/src/git/diff-view.tsx`）不渲染结构化 diff，只显示原因、summary 和不超过 `diffRawBytes` 的原始 patch 前缀。
- 没有文本 hunk 的纯 rename、mode 变化和二进制文件只显示 summary，不当作没有变化。
- 自己发起的 stage 或 unstage 成功且涉及当前预览的文件时，预览切到该文件的另一侧；期间用户另选了文件时不跳转。

### 历史与分支

- `git.history` 从固定的 `anchorOid`（首次为当前 HEAD）开始，用 `git log --no-show-signature --encoding=UTF-8 -z` 每页读取最多 `listPageEntries` 个提交（多读一个判断是否还有下一页），返回 OID、父提交、作者、时间和主题。翻页沿用同一个 anchor，不受之后新提交的影响。
- `git.commitFiles` 和提交 diff 只接受完整的 40 或 64 位十六进制提交 OID。根提交与空树比较；合并提交必须由浏览器指定父提交，否则返回 `invalid_argument`。
- `git.commitFiles` 的文本增删行数与 diff 使用同一父提交，来自完整 numstat，不受 patch 截断影响。纯 rename 或 mode 变化保留真实零值，二进制不返回行数。文件项按条目数和结果字节上限分页，预算包含稍后补入的统计字段。
- `git.branches` 用 `git for-each-ref refs/heads/` 一次返回全部本地分支和检出它的工作树路径，不分页，超过结果上限时返回 `limit_exceeded`。

## 写操作

### 队列

- 所有写方法（`shared/src/protocol/rpc.ts` 的 `gitWriteMethods`）都进入 `GitWriteQueue`（`agent/src/git/queue.ts`），按 `commonDir` 串行执行：同一仓库及其全部 linked worktree 的写操作一次只执行一个。轮到某个写操作时，agent 先重新核验仓库身份。
- 排队期间可以取消，被取消的写操作不执行。写超时 `gitWriteTimeout` 从 agent 收到请求开始计时，包括排队时间；读方法使用 `rpcTimeout`。
- 浏览器对每个仓库同时只发出一个写请求（`web/src/git/actions.ts`），取消时调用 `DELETE /api/devices/<deviceId>/requests/<requestId>`。
- 队列只协调本 agent 的写操作。外部写入者不加锁：终端或其他程序中的 Git 可以同时修改仓库，竞争由 Git 自己的 `index.lock` 和后续检查反馈。agent 不删除 `index.lock`，也不自动重试。

### 结果

- 写命令没能启动（没有进程）时结果为失败。进程启动后以非零退出码结束、被取消、超时或输出异常时，结果都是结果未确认（`unknown`），因为 Git 可能已部分生效；push 被拒绝、hook 拒绝提交、`index.lock` 已存在都属于这一类。
- 以下情况结果为 `partial`：stage、unstage、discard 已完成部分步骤后失败（结果带 `changedPaths`）；continue 或 abort 失败但 HEAD 或操作 token 已变化；创建分支成功而随后的切换失败。
- 写命令成功、但随后读取 HEAD 失败时，结果为结果未确认，并带上已知事实（如 `committed: true`）。不自动重放的通用规则见[结果语义](protocol.md#结果语义)。

### 进程结束

Linux 和 macOS 上，写操作在 Git 主进程退出时结束；hook 启动的后台进程和常驻的凭据 helper 可以继续运行。取消、超时或进程异常时，agent 先向进程组发送 `SIGTERM`，1 秒后发送 `SIGKILL`，等进程组为空后才让出队列。主进程退出后，agent 最多再等 1 秒让输出管道关闭，仍未关闭时关闭本端并报告输出不完整。Windows 上用 Job 对象管理进程，见[平台实现](platforms.md#windows)。

### 路径参数

stage、unstage、review 和 discard 的路径最多 `listPageEntries × 2` 个，序列化后不超过结果上限。路径不能是 `.`，也不能包含 `.git` 段（macOS 上与 `.git` 是同一对象的大小写变体同样拒绝）。

### stage 与 unstage

- 写前在队列内重读所选路径的状态，已不适用时返回 `conflict`。
- stage：精确移除磁盘上已不存在的路径；普通文件和符号链接暂存磁盘内容。子模块只有指针变化时才能暂存 gitlink，只有内部修改时返回 `unsupported`；gitlink 冲突返回 `unsupported`；目录和特殊文件返回 `conflict`，不递归暂存。
- unstage：恢复 HEAD 中同名的文件、链接或 gitlink；没有 HEAD、没有同名项或同名项是目录时，只移除该 index 项。普通的 rename 由浏览器传两端，“只取消暂存新路径”只传新路径。具体 Git 调用见 `agent/src/git/changes.ts`。
- 写前检查：对将要加入 index 的每个路径，agent 查找 index 中按 `/` 边界、按原始字节判断的严格祖先或后代。它们不在本次移除范围内时，整次请求返回 `conflict`，并返回受 `listPageEntries` 与结果大小预算限制的占用路径，超限标记 `truncated`，提示先暂存旧项的删除或先取消暂存新项。
- stage 和 unstage 只处理请求中列出的路径，不自行加入 rename 的另一端。每一步只改变明确的路径；unstage 不写工作树，两者都不递归子模块。

### discard

- 范围有两种：`worktree` 从 index 恢复工作树，`all` 从 HEAD 同时恢复 index 和工作树。没有单独丢弃未跟踪文件的范围：未跟踪的普通文件和符号链接在两种范围下都被删除。目录和嵌套仓库不会被删除。
- 浏览器先调用 `git.review`（读方法，不进队列），得到完整的确认路径（`all` 时包括 rename 的源路径）、每项动作（恢复或删除）和 `reviewToken`。`git.discard` 原样提交路径、范围和 reviewToken；agent 在队列内重新计算，路径或 token 不同时返回 `conflict`，需要重新审查。
- reviewToken 摘要 repoId、范围、路径集合、indexToken，以及每项的来源 index 或 HEAD 项、磁盘类型、文件内容的 SHA-256 或链接内容。只读取所选路径的内容。审查期间 HEAD 或 index 变化时返回 `conflict`。
- 路径占用检查：agent 从仓库根目录逐级 `lstat` 每个路径，不跟随链接。必经的祖先是文件、链接或特殊项，或者目标位置是目录或特殊项时，整次请求返回 `conflict` 和 `blockedPaths`（目录时附其子项名称），由用户先在文件工具中处理。`all` 还做与 stage 相同的 index 祖先和后代检查。
- 执行顺序：先移除需要移出 index 的项，再逐个删除确认要删除的普通文件和链接，最后从确认的来源恢复目标。删除直接在 Git 队列内调用 `fs.unlink`，不经过文件工具的删除流程和发布锁。具体 Git 调用见 `agent/src/git/changes.ts`。
- 父仓库不丢弃子模块内容，涉及 gitlink 时返回 `unsupported`。`worktree` 范围不处理冲突项。

### commit

- `git.commit` 执行 `git commit -F -`，提交说明从 stdin 传入，不传路径，不加 `-a`；hooks、签名和身份照常生效。
- 提交说明不能是空白，长度上限见[限额](../guide/reference.md#限额)。agent 在队列内重新计算 indexToken，与请求中的 `indexToken` 不同时返回 `conflict`；存在未解决的冲突，或没有暂存的变化时也返回 `conflict`，所以网页不能创建空提交。
- 成功时返回新提交的 OID；提交后读取 HEAD 失败时为结果未确认，结果带 `committed: true`。

### 分支

- 分支名先用 `git check-ref-format refs/heads/<name>` 检查，以 `-` 开头的名称被拒绝。
- 创建分支从指定提交或当前 HEAD 开始，仓库还没有提交时返回 `conflict`；可以选择随后切换。创建和切换都不递归子模块。
- 切换和删除带浏览器看到的 `refOid`，分支已指向其他提交时返回 `conflict`。切换不强制覆盖未提交的修改；删除使用 Git 的普通删除规则，不使用强制删除。具体调用见 `agent/src/git/refs.ts`。

### 三份独立状态

- 浏览器草稿、磁盘文件和 Git index 是三份独立的状态。stage 读取磁盘上的当前内容，不读取未保存的草稿；所选文件有未保存草稿时，浏览器先请用户确认暂存磁盘版本。commit 只提交 index。
- discard、pull、切换分支和 abort 修改磁盘后，打开的草稿只标记磁盘已变化，不被覆盖（见[文件](files.md#保存)）。草稿也不阻止这些操作。

## 同步与认证

- `git.remotes` 返回各 remote 的 fetch 和 push URL、当前 upstream、默认的 fetch 和 push remote。`pushTarget` 只在能确定时返回：`push.default` 为 `current`；或者推送 remote 就是当前分支的 remote 且存在 upstream，同时 `push.default` 为 `upstream`，或为 `simple` 且 upstream 与当前分支同名。推送 remote 配置了 `remote.<name>.push` 或 `remote.<name>.mirror` 时不返回。没有 `pushTarget` 时，界面说明推送目标由设备上的 Git 配置决定。
- fetch 可以使用默认 remote 或指定仍然存在的 remote；pull 和 push 按仓库配置执行。agent 不添加 `--rebase`、`--ff-only`、`--force` 等参数，合并策略和推送目标都由仓库配置决定（`agent/src/git/remotes.ts`）。
- pull 和 push 带 `expectedHead`（`symbolicRef` 和 `oid`）。agent 在队列内与当前 HEAD 完整比较，不同时返回 `conflict`，不执行同步。
- pull 设置 `GIT_EDITOR=true` 和 `GIT_SEQUENCE_EDITOR=false`：产生合并提交时接受默认说明，配置导致的交互式 rebase 会失败。
- 执行身份、`HOME`、`PATH`、Git 配置、SSH 和 HTTPS 凭据 helper、代理都来自 agent 进程的环境，由前台运行的终端、服务管理器或容器提供。Windows 上直接运行原生 Git，不经过 MSYS Bash。
- `GIT_TERMINAL_PROMPT=0`、stdin 已关闭且没有控制终端，因此需要交互的认证（输入密码、确认 host key、输入私钥口令）会失败并返回 Git 的错误。第三方 helper 如果仍在等待输入，会在 `gitWriteTimeout` 后被取消。解决方法是在与 agent 相同的用户和环境中用终端完成配置；在 Shell 中临时 `export` 的变量不影响已经运行的 agent。
- 失败或中断的同步可能已经取回部分 ref 或推送了部分分支，结果为结果未确认。浏览器刷新后显示真实的 refs，不自动重发。

## 冲突与进行中的操作

### 识别

每次 status 都从 gitDir 中的标记识别进行中的操作（`agent/src/git/in-progress.ts`），不依赖浏览器的记录，所以在终端中开始的操作同样能被识别。按下表从上到下取第一个匹配：

| 标记                                              | 操作                  | 计入 token 的文件                                     |
| ------------------------------------------------- | --------------------- | ----------------------------------------------------- |
| `rebase-merge/`                                   | rebase                | `rebase-merge/onto`、`REBASE_HEAD`                    |
| `rebase-apply/` 和 `applying`                     | am                    | `rebase-apply/patch`                                  |
| `rebase-apply/` 和 `rebasing`                     | rebase                | `rebase-apply/onto`、`rebase-apply/original-commit`   |
| `CHERRY_PICK_HEAD`、`REVERT_HEAD` 或 `sequencer/` | cherry-pick 或 revert | 对应的 `*_HEAD`；只剩 sequencer 时为 `sequencer/todo` |
| `MERGE_HEAD`                                      | merge                 | `MERGE_HEAD`                                          |

- 只剩 `sequencer/` 时，`sequencer/todo` 的命令全部是 `pick` 才识别为 cherry-pick，全部是 `revert` 才识别为 revert。无法识别或读取失败时操作为 `unknown`，不返回 token，继续和中止都不可用，界面只给出原因和终端入口。
- 操作 token 是 repoId、HEAD 身份、上表文件内容的摘要和操作类型的 SHA-256。编辑冲突文件和 stage 不改变 token。

### 继续与中止

- 继续要求没有未解决的冲突。rebase-merge 还要求 `git-rebase-todo` 和 `done` 中除空行和注释外的命令都是 `pick` 或 `p`；出现其他命令（如 reword、edit、squash、fixup、exec、break、drop 或保留合并结构的步骤）时不能在网页中继续，需要在终端完成。注释前缀由 `git stripspace --comment-lines` 探测（输出不超过 4 KiB），探测失败时同样不能继续。todo 或 done 中单行超过 64 KiB 时操作识别为 `unknown`。apply 后端的 rebase 和 am 不检查 todo。
- 中止对所有已识别的操作可用。
- `git.continue` 和 `git.abort` 带确认时的 `expectedOperation`（类型和 token）。agent 在队列内重新识别并比较，不同时返回 `conflict`，不执行命令；一致时执行 `git <操作> --continue` 或 `git <操作> --abort`，并设置 `GIT_EDITOR=true` 以接受已有的提交说明，hooks 和签名照常生效。
- 结果带执行后的 `headOid` 和 `operationAfter`。继续可能进入下一个冲突，一次成功不代表整个操作结束。
- 冲突的解决方式是在文件工具中编辑并保存，再在 Git 中 stage 该路径，或以删除作为解决。agent 不根据文件中是否还有冲突标记自动 stage。gitlink 冲突在子仓库或终端中处理。
- merge 的中止由 Git 执行，合并开始前未提交的修改可能无法被完整恢复。

## 自动刷新

- 事件的产生和浏览器的刷新节奏见[变化监听](files.md#变化监听)。工作树和 Git 元数据的变化都会产生包含 `git` 和 `repos` 范围的 `workspace.changed`，agent 自己的 Git 写操作结束时立即发送。
- 状态视图在收到刷新时于当前 offset 重新读取（见[翻页](#翻页)），仓库发现每次推进一轮扫描（见[扫描](#扫描)）。
- 自己发起的写操作结束后（无论结果如何），浏览器立即重读状态。写操作结果未确认时，刷新后显示的 HEAD、index 和 refs 就是判断依据。

## 范围外

- 在网页中使用 stash。
- 按行或按 hunk 暂存，以及递归暂存整个目录。
- 创建、删除或修复工作树；可以在终端中运行 `git worktree repair`。
- 子模块的初始化和更新，以及裸仓库的操作。
- 专门的合并编辑器、提交说明编辑器和 rebase todo 编辑器。
- amend、reset、交互式 rebase、强制推送、`git branch -D` 等改写历史或强制性的操作。
- 自动 stash、自动重试和删除 `index.lock`。
- 为了让操作成功而关闭 hooks、签名或认证：agent 从不添加 `--no-verify` 或 `--no-gpg-sign`，也不修改凭据配置。
