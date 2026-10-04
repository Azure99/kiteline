# 界面交互

本文写工作台跨功能的界面约定，供修改 `web/src/` 的人参考，新界面应遵守这些约定。各功能的操作见[使用工作台](../guide/usage.md)，终端、文件、Git 的行为规则见各自的 design 文档。

## 布局

工作台按视口宽度分为桌面和手机两种布局，断点为 960 CSS 像素：`web/src/lib/use-mobile.ts` 的 `useMobile()` 以 `(max-width: 959px)` 判断，样式中使用同一断点（Tailwind 的 `max-[959px]:` 和 `min-[960px]:`，以及 `styles.css` 的 `@media (max-width: 959px)`）。布局只看可用宽度，不看设备类型或 UA，横屏手机按实际宽度使用对应布局。

| 区域       | 桌面（宽度至少 960 像素）                                              | 手机（宽度小于 960 像素）                                      |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| 顶栏       | 收起或展开设备侧栏的按钮、品牌、目标切换、连接状态、工具图标、更多菜单 | 品牌只显示图标；设备和工作区名称在同一个切换按钮内             |
| 设备侧栏   | 宽 210 像素，可收起                                                    | 不显示，通过目标切换对话框选择设备和工作区                     |
| 工具导航   | 固定三项：终端、文件、Git                                              | 同样三项，等宽排列                                             |
| 终端       | 一个工作区可有多个终端组；当前组可向右或向下递归分屏，可拖动整理       | 一次显示一个会话；分屏、移组和排列入口隐藏，桌面的分组数据保留 |
| 文件、Git  | 列表与内容并排；可在下方展开一个终端面板，高度可调                     | 列表和内容逐层进入；没有终端面板                               |
| 定时任务页 | 左侧列表，右侧详情                                                     | 列表、任务、运行详情逐层进入                                   |
| 对话框     | 居中模态框，最宽 560 像素                                              | 贴底全宽面板，底部留出安全区                                   |

工具导航固定为终端、文件、Git 三项（`web/src/terminal/sessions.tsx`），定时任务和开发服务访问是顶栏入口，不是工作区工具。终端面板（`terminal.expandDock`、`terminal.collapseDock`）只在桌面的文件和 Git 视图中出现，是一个单会话终端，“在终端展开”（`terminal.expandTerminal`）切到终端工具中该会话所在的组。分组和分屏的操作见[终端](../guide/usage.md#终端)，终端尺寸的计算见[尺寸](terminal.md#尺寸)。

文件和 Git 视图通过 `web/src/components/tool-layout.tsx` 把标题行和侧栏放进工具的固定区域；手机上侧栏内容直接显示在主区域中。终端专注模式会收起顶栏、设备侧栏和工具导航，见[输入与焦点](#输入与焦点)。

## 导航与上下文

导航层级是设备 → 工作区 → 工具。所有路由由 `web/src/lib/navigation.ts` 生成和解析，页面跳转使用 History API，浏览器的前进和后退可以切换视图。

| 路径                                                  | 视图                                             |
| ----------------------------------------------------- | ------------------------------------------------ |
| `/`、`/devices`                                       | 主页：最近工作区与设备                           |
| `/devices/<deviceId>`                                 | 设备详情                                         |
| `/devices/<deviceId>/workspaces/<workspaceId>/<tool>` | 工作区，`<tool>` 为 `terminal`、`files` 或 `git` |
| `/tasks`                                              | 定时任务                                         |

工作区视图的查询参数为 `session`、`repo`、`file`、`draft`、`folder`、`reveal`、`search`；定时任务页的查询参数为 `device`（列表筛选）、`target`、`task`、`run`。ID 一律经过 URL 编码。同一工作区内切换工具时，`navigateWorkspace()` 保留当前查询参数，各工具因此回到各自之前的目标。

其他路径显示“页面不存在”（`shell.pageMissing`）和“返回设备”（`shell.backDevices`）。`/login` 不是工作台路由：开发服务代理把未登录的页面导航重定向到 `/login?returnTo=…`，登录成功后 `returnToService()`（`web/src/lib/login-return.ts`）只在 `returnTo` 是同源的 `/proxy/<deviceId>/<port>…` 或 `/absproxy/<deviceId>/<port>…` 时用 `location.replace()` 跳转，否则留在 `/login` 并显示“页面不存在”。

### 登录状态

- 未登录时，任何路径都在原地显示登录或初始化表单（`web/src/auth.tsx`），登录后同一 URL 直接渲染，深链接因此不会丢失。读取登录状态失败时显示错误和重试，重试只重新读取，不重新提交表单。
- 任何接口返回 401 时，`api()` 发出 `kiteline:unauthenticated` 事件。工作台关闭打开中的对话框（绑定、目标切换、目录选择、设备操作、访问端口、上传、文件整理），在原地显示登录表单。草稿、终端布局和 Git 操作状态留在内存中，重新登录后继续可用。
- 退出登录时，有未保存草稿则先确认（`shell.discardLogout`），然后清空草稿、终端布局、Git 操作状态和上传列表。有未保存草稿时关闭或刷新页面会触发浏览器的离开确认。

### 切换时保留的状态

| 状态               | 保存在                     | 切换时的行为                                                                                                       |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 文件草稿与撤销历史 | 工作台内存（`DraftStore`） | 切换工具、工作区、设备，以及设备或工作区被移除后都保留；原目标失效时只能查看和复制                                 |
| 终端显示           | 当前工作区的组件树         | 同一工作区内切换工具只隐藏，不断开；离开工作区（换工作区、回主页、进入定时任务页）时断开显示，设备上的会话继续运行 |
| 终端分组布局       | 工作台内存，按工作区保存   | 回到工作区时恢复                                                                                                   |

语言、最近工作区和终端字号保存在浏览器 localStorage，终端历史行数和快捷方式保存在设备上，存储位置和 localStorage 键见[状态归属](architecture.md#状态归属)。读写 localStorage 都包在 `try` 中，浏览器禁用存储时使用默认值，当前页面的设置照常生效。草稿和终端布局不跨 origin、不跨浏览器转移。

### 迟到结果归原目标

异步请求在发出时固定目标（设备、工作区、文件、定时任务等的 ID），结果只作用于这个目标，不作用于用户此时正在看的页面。例如：

- 添加工作区成功后，只有 URL 仍是发起时的地址才跳到新工作区（`workbench.tsx` 的 `DirectoryDialog`）。
- 定时任务页新建运行后，只有页面仍在原地址才选中该运行（`tasks.tsx`）。
- 上传、文件整理对话框保存发起时的设备和工作区，进度和结果显示在原目标上。
- 设备列表用读取序号丢弃过期的读取结果（`use-devices.ts`）。

新代码必须遵守同一规则：浏览器路由变化不改变已发出请求的归属，写请求的结果不能写到新的选择上。

## 反馈与状态

工作台没有全局的通知队列或 toast。反馈显示在发起操作的视图、对话框或列表行内，成功通常直接体现为列表或状态的变化；复制等没有可见变化的操作就地显示“已复制”（`common.copied`）。

### 错误

`ErrorNotice`（`web/src/components/error-notice.tsx`）是统一的错误显示：第一部分是按错误码翻译的说明（`errors.*`），第二部分是 `[code] message` 形式的原始诊断，结果不确定或部分完成时再附加 `errors.unknown` 或 `errors.partial` 的说明。错误带有 `details`、`outcome` 或 `result` 时，提供可展开的“原始详情”（`common.details`），以 JSON 显示全部字段。

| 位置               | 用途                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| 视图或对话框内     | 该视图自己的操作和读取失败                                                                               |
| 主区域顶部的提示行 | 登录状态或设备列表读取失败、退出登录失败、下载失败（“下载 {{path}}：{{error}}”，`shell.downloadFailed`） |
| 工具视图的错误边界 | 视图代码加载或渲染失败                                                                                   |

某个工具视图的代码加载或渲染失败时（按需加载方式见[前端约定](architecture.md#前端约定)），只在该视图显示错误、“刷新前请复制未保存的内容。”（`release.reloadDrafts`）和“刷新页面”（`release.reload`），其他视图、草稿和终端不受影响。

### 加载与过期数据

- 首次读取成功之前显示“正在加载”（`common.loading`）、“正在读取”（`common.reading`）或读取失败，不显示为空列表；只有成功读到空结果才显示空状态文字（如 `schedules.noTasks`）。
- 刷新失败或设备离线时保留上一次的结果，并标出它是旧结果和读取时间，例如设备详情的“最近连接 {{time}}”（`devices.lastSeen`）、会话列表的“设备离线，显示上次结果。”（`devices.sessionsOffline`）、定时任务的“最后读取于 {{time}}，当前状态不可用。”（`schedules.stale`）。
- 顶栏的状态点表示浏览器与 server 的事件连接（“已连接”`common.connected`、“连接中断”`common.disconnected`），与设备在线状态无关。断开后的重连规则见[浏览器事件](protocol.md#浏览器事件)。

### 版本不一致

浏览器每个请求都带 `appVersion` 参数，server 在响应头 `X-Kiteline-Version` 中返回自己的版本（规则见[契约来源](protocol.md#契约来源)）。

- 工作台发现 server 版本与自身不同时，在顶部显示 `release.webMismatch`（“Web {{web}} / Server {{server}}：远程操作已暂停。刷新前请复制未保存的内容。”）和“刷新页面”按钮。此后工作台停止建立事件连接，也停止发起定时任务列表读取、文件下载，以及终端的重新连接和恢复（各处检查 `webCompatible()`）；server 对远程操作接口同样检查版本并返回 426。已有草稿、搜索结果和终端内容保留可复制，页面不会自动刷新或退出登录。
- 设备离线且最近一次连接尝试报告的 agent 版本与 server 不同时，设备详情和该设备的工作区页面显示“版本不匹配”（`devices.versionMismatch`）、双方版本和“查看升级命令”（`devices.viewUpgrade`）。两类提示互相独立，可以同时出现。

### 写操作结果

写操作的结果分为成功、失败、部分完成和结果未确认，定义见[结果语义](protocol.md#结果语义)。界面上的对应规则：

- 写请求发出后没有收到回复时，`api()` 生成 `outcome: "unknown"` 的错误，界面显示 `errors.unknown`（“结果未确认。请刷新核查后再决定是否重试。”）。界面不自动重发，由拥有者核查后决定。
- 部分完成显示 `errors.partial`；复制、移动、删除等多项文件操作逐项列出完成和未完成的项目（`web/src/files/operation-dialog.tsx`）。
- 确认成功的操作不会因为随后刷新列表失败而改显示为失败。
- 删除、停止运行、确认核查和放弃草稿退出登录等操作使用一次确认（原生 `window.confirm` 或确认对话框），不逐步重复确认。

## 输入与焦点

- **键盘。** 只有图标的按钮使用 `IconButton`（`web/src/components/icon-button.tsx`），同时提供 `aria-label` 和 tooltip。对话框、菜单和 tooltip 基于 `@base-ui/react`：对话框打开时焦点进入对话框（需要时用 `initialFocus` 指向输入框），关闭后焦点回到触发元素；没有触发元素的对话框用 `finalFocus` 指定返回位置。分屏分隔条可以获得焦点。
- **保持编辑焦点。** 作用于终端或编辑器的按钮（终端的粘贴和键盘按钮、复制命令或链接的按钮等）在 `pointerdown` 时调用 `preventDefault()`，点击不会夺走终端或编辑器的焦点，手机软键盘也不会因此收起。
- **软键盘与视口高度。** `trackViewport()`（`web/src/lib/viewport.ts`）根据 `visualViewport` 和浏览器支持时的 VirtualKeyboard API 计算可见区域，写入 CSS 变量 `--app-height` 和 `--app-top`。浏览器支持 `dvh`、页面没有缩放、可见区域顶端为 0 且软键盘没有遮住页面时，`--app-height` 为 `100dvh`，否则为测得的像素高度。工作台主体按这两个变量定位，始终占满可见区域，底部操作不被软键盘遮住。终端的软键盘和输入规则见[终端](terminal.md#输入)。
- **触控。** 手机布局加大按钮和输入框，尺寸见[尺寸](#尺寸)。
- **剪贴板。** 复制统一使用 `copyText()`（`web/src/lib/clipboard.ts`）：有 `navigator.clipboard.writeText` 时直接使用；没有时（例如通过 HTTP 访问的非安全上下文）在本次用户操作中用临时只读文本框和 `execCommand("copy")` 复制，之后恢复原焦点、选区及其方向。复制失败时调用方就地显示错误，原文保留供手动选择。终端的粘贴按钮只在 `navigator.clipboard.readText` 可调用时显示，浏览器拒绝读取时显示错误，不预先请求权限。是否可用按 API 能力判断，不按访问协议判断。
- **新标签页。** 打开开发服务链接使用 `window.open(url, "_blank", "noopener,noreferrer")`，在点击事件中同步调用，不先等待异步请求。
- **终端专注模式。** 专注模式收起顶栏、设备侧栏和工具导航，只留终端控制行和终端区域（`web/src/terminal/use-terminal-focus.ts`）。桌面进入时同时请求全屏；手机上同一按钮依次切换页面专注、全屏、退出。专注状态绑定当前设备和工作区的终端工具，切换设备、工作区或工具时自动退出。全屏请求失败时保留页面专注并提示“无法进入全屏”（`terminal.fullscreenFailed`）。

## 语言

工作台提供简体中文和英文两份资源：`web/src/i18n/en.ts` 和 `web/src/i18n/zh-CN.ts`，由 i18next 和 react-i18next 加载（`web/src/i18n/index.ts`）。

- **选择规则。** 语言是浏览器级设置。没有手动选择时，按 `navigator.languages[0]` 判断：`zh` 或 `zh-` 开头的标签（包括 `zh-TW`、`zh-Hant-HK`）使用简体中文，其他使用英文；浏览器语言变化时（`languagechange` 事件）重新判断。手动选择保存在 `kiteline.language`，选“跟随浏览器”（`common.browserLanguage`）时删除该键。`<html lang>` 随当前语言更新。登录页和工作台的更多菜单都提供语言选择。
- **键与类型。** 英文资源是键的来源，`zh-CN.ts` 以 `satisfies TranslationResources` 保证两份资源的键一致。代码用选择器形式 `t(($) => $.group.key)` 引用文案，不存在的键和缺少插值参数会在类型检查中报错（`web/test/i18n.typecheck.ts`）。`web/test/i18n.test.ts` 检查每个键都有非空译文、两种语言的插值参数一致。
- **插值与复数。** 插值写作 `{{name}}`，数字用 `{{count, number}}` 按当前语言格式化。复数使用 i18next 的后缀键，例如 `shell.uploadStatus_one` 和 `shell.uploadStatus_other`。i18next 的转义关闭（`escapeValue: false`），由 React 负责转义，路径和用户输入原样显示。
- **渲染时翻译。** 文案在渲染时生成，组件通过 `useTranslation()` 订阅语言变化。错误对象只保存错误码、原始消息和附加数据，`errorMessage()` 在显示时才翻译，所以切换语言后已经显示的错误也会更新。切换语言只触发重新渲染，不重新挂载终端、编辑器或其他视图，草稿、撤销历史、选区和终端内容都保留。
- **不翻译的内容。** 文件内容、路径、用户起的名称、提交消息、命令输出、来自 server 和 agent 的原始诊断（英文）保持原样。开发服务代理的错误页由 server 生成，只有英文，见[错误响应](http-access.md#错误响应)。
- **第三方组件。** CodeMirror 的界面文字来自 `editor` 资源组：`editorPhrases()` 返回当前语言的短语，切换语言时通过 Compartment 重新配置 `EditorState.phrases`，不重建编辑器状态（`web/src/files/editor-state.ts`、`text-editor.tsx`）。xterm.js 的无障碍文字通过 `Terminal.strings.promptLabel` 和 `Terminal.strings.tooMuchOutput` 设置，并同步终端输入框的 `aria-label`（`web/src/terminal/terminal-view.tsx`）。
- **尺寸稳定。** 工作台提示行和终端提示行固定高度为 4rem（`.workbench-notice`、`.terminal-notice`），译文长短不同也不会改变终端尺寸，从而不会清除终端选区。

## 视觉

颜色、尺寸和动效的数值在 `web/src/styles.css` 和 `web/src/components/ui/` 中，修改时遵守以下规则。本地 UI 组件的来源和维护方式见[本地 UI 组件](../../web/src/components/ui/README.md)。

### 颜色

颜色在 `styles.css` 的 `@theme` 中定义为 Tailwind 主题变量，并在 `:root` 上提供同名的短变量（如 `--primary`）；组件通过 `bg-background`、`border-border` 这类类名使用这些变量。

| 变量                                  | 用途                     |
| ------------------------------------- | ------------------------ |
| `--color-background`                  | 顶栏、内容背景           |
| `--color-foreground`                  | 正文                     |
| `--color-primary`                     | 主色、焦点环、当前项标记 |
| `--color-primary-soft`                | 当前项背景               |
| `--color-border`                      | 边框、分隔线             |
| `--color-muted`                       | 侧栏、工具栏等次级背景   |
| `--color-muted-foreground`            | 次要文字                 |
| `--color-destructive`                 | 错误、危险操作、失败状态 |
| `--terminal`、`--terminal-foreground` | 终端深色背景与文字       |

页面只使用浅色主题（`color-scheme: light`）。终端页面把 `html` 和 `body` 背景也设为终端色，软键盘动画露出的区域不会闪白。

### 尺寸

- 手机布局中按钮、图标按钮和输入框的最小高度为 44 像素，输入框字号为 16 像素；桌面上普通按钮和图标按钮为 32 像素，输入框最小高度为 36 像素。
- 对话框在桌面最宽 560 像素，最高为视口的 85% 且不超过 760 像素；在手机上为全宽，最高为视口的 90%。
- 正文字号为 14 像素。
- 登录页、错误页和对话框的高度使用 `--viewport-height`（支持时为 `100dvh`，否则 `100vh`）；工作台主体使用 `trackViewport()` 写入的 `--app-height` 和 `--app-top`（见[输入与焦点](#输入与焦点)）。

### 状态与焦点

- 状态不只靠颜色表达，始终同时有文字或符号：定时任务的失败结果用 `--color-destructive`，结果未知用组件内写定的 `#8c6515`，两者都显示状态文字。顶栏的连接状态点带 `title` 和 `aria-label`，主页最近工作区的设备状态点带 `aria-label`，设备列表和设备详情在状态点旁显示状态文字；设备侧栏的状态点只有颜色。
- 当前项（定时任务列表的当前任务、Git 历史中的当前文件）使用 `--color-primary-soft` 背景加 3 像素的左侧内阴影标记；悬停只改变背景色，当前项靠标记区分。
- 按钮和输入框获得键盘焦点时显示 2 像素主色焦点环（`focus-visible`）；终端辅助键使用 2 像素浅蓝色轮廓；分隔条聚焦时变为主色。
- 图标使用 `lucide-react`。

### 动效

对话框、菜单和 tooltip 在打开和关闭时做短时的透明度和小幅位移过渡（时长见 `styles.css`）。系统开启减少动态效果的设置（`prefers-reduced-motion: reduce`）时，这些过渡和按钮的颜色过渡全部关闭。工具内容区和终端容器的尺寸变化不做动画。
