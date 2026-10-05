# Use the workbench

[中文](usage.md)

This guide is for owners who have connected devices and want to use the workbench in a browser. See [Connect devices](devices.en.md) for device setup and [Scheduled tasks](scheduled-tasks.en.md) for scheduled commands.

## Browser and interface

### Supported browsers

The workbench supports desktop Chrome and Android Chrome, with Chromium 97 as the minimum (see [Browser compatibility (Chinese)](../design/architecture.md#浏览器兼容)). When accessing it over HTTPS or `localhost`, current Chrome versions can install it as an app from the browser menu and open it in a separate window. It still needs a connection to the server and has no offline functionality.

### Sign-in and language

Origins with different hostnames or schemes, such as `http://192.168.1.10:8080` and `https://kiteline.example.com`, require separate sign-ins. Different ports on the same host and scheme share a login. Preferences such as language are stored separately in the browser per origin, including the port. "Sign out" is in the top bar's overflow menu. If files have unsaved changes, it first asks "Discard unsaved changes and sign out?" Signing out ends only this browser's login; terminal sessions keep running. For a forgotten password, click "Sign-in recovery" on the sign-in page and follow [Reset the setup token or password](server.en.md#reset-the-setup-token-or-password).

Language follows the browser by default: Simplified Chinese for Chinese locales, English otherwise. In the overflow menu (the language icon on the sign-in page), choose "Use browser language", English or 简体中文. Switching does not affect open files or terminals.

### Top bar and three tools

- Kiteline logo: returns home. The home page has "Scheduled Tasks" and "Connect device" buttons, followed by "Recent workspaces" when available, then the device list.
- Current target: shows the current workspace and device. Click to switch through "Devices and workspaces", which lists full paths.
- Status dot: the browser's connection to the server ("Connected" or "Disconnected"), not whether a device is online.
- "Scheduled Tasks" icon, and "Open port" when a device is selected. On desktop, active uploads also show an upload-status icon that reopens the upload dialog.
- Overflow menu: "Open files", language and "Sign out".

Inside a workspace, the three tools are "Terminal", "Files" and "Git". Switching tools does not end terminal sessions or lose unsaved changes. The address bar records the device, workspace, tool and open file, repository and session, so you can use Back, Forward and bookmarks.

After a server upgrade, an already open page shows the Web and Server versions and pauses remote operations. Copy unsaved content before clicking "Reload page".

### Desktop and phone layouts

Windows narrower than 960 CSS pixels use the phone layout, regardless of device type. It has no device sidebar; switch targets from the top bar. Terminals show one session at a time with a key row. Files and Git navigate from lists into content, dialogs open from the bottom, and upload status is in the overflow menu. See [Layout (Chinese)](../design/interaction.md#布局).

### Where settings are stored

| Content                                                      | Storage                               |
| ------------------------------------------------------------ | ------------------------------------- |
| Language, recent workspaces, terminal font size              | Current browser                       |
| Terminal groups and splits, unsaved changes, commit messages | Current page; lost on reload or close |
| New-session scrollback lines, terminal shortcuts             | Device; shared across origins         |
| Device name                                                  | Server                                |
| Workspace names and paths                                    | Device                                |

## Devices and workspaces

### Devices

Device status is "Online", "Offline" or "Version mismatch". For new devices, see [Connect using the web command](devices.en.md#connect-using-the-web-command). The device page shows the last connection time and agent/server versions. Its upper-right menu offers "Upgrade agent", "Terminal settings", "Rename" and "Delete device".

The agent version must match the server. Otherwise the device cannot connect, shows "Version mismatch", and has "View update command" at the top of its device and workspace pages. Select the device's system in the upgrade dialog (Linux is the default), copy the command and run it on the device; see [Upgrade the agent](devices.en.md#upgrade-the-agent). Existing terminal sessions on the device are unaffected.

After one confirmation, "Delete device" removes its record, binding and scheduled-task summaries from the server and immediately disconnects remote access. The agent, terminal sessions, scheduled tasks and files remain on the device, but the agent cannot reconnect without binding again. The dialog then shows an uninstall command; see [Uninstall](devices.en.md#uninstall).

### Workspaces

A workspace is a registered project directory on a device. On an online device's page, click "Add" and browse the device filesystem in "Add workspace": enter an absolute path and click "Go to directory", or start from "Roots and home". Use "New directory" if needed, then "Select this directory". The name defaults to the directory name. The registered path is the real directory after resolving symbolic links. Adding the same directory again returns the existing workspace.

A workspace row's menu offers "Rename" and "Remove", unavailable when the device is offline. "Remove" deletes only the registration, keeping directories and files. A workspace cannot be removed while it still has terminal sessions.

A workspace is not a sandbox. Terminal, file and Git operations use the project user's permissions and can access any path that user can access.

### Recent workspaces and existing sessions

"Recent workspaces" on the home page lists workspaces recently used in this browser. Clicking one returns to its last-used tool. Its entry disappears once the workspace is confirmed removed. "Existing sessions" on a device page lists all running terminals on that device. Use "Filter sessions" and click a session to open it.

Terminal sessions keep running when you switch tools, workspaces or devices. Leaving a workspace closes its terminal displays; returning attaches again. Groups, splits, unsaved changes and Git commit messages remain until the page closes.

## Terminal

Terminal sessions run on the device. Closing the page, losing the network, signing out, restarting the server or deleting the device does not end them. A session ends when its shell or shortcut command exits, you end it, the agent stops, or the device restarts. See [Session lifecycle (Chinese)](../design/terminal.md#会话生命周期) for the full list. The same session can be open in multiple browsers and local terminals at once. All clients can type directly; simultaneous input is interleaved.

### Create sessions and shortcuts

Click "New terminal" (plus) and choose a shell or shortcut. Sessions start in the workspace directory and inherit the agent's environment (from service configuration when running as a service; see [Run in the background](devices.en.md#run-in-the-background)). Linux and macOS use the project user's login shell; Windows uses PowerShell 7. Change it in the [agent configuration file](reference.en.md#agent-configuration-file).

Shortcuts run one command in the login shell; the session ends when that command exits. Manage them in "Terminal settings" in the device or terminal menu. Each device has its own set. New devices include Claude Code, Codex and OpenCode shortcuts (`claude`, `codex`, `opencode`); install those programs yourself.

"Select terminal session" lists all sessions in the workspace, including those created in other browsers or locally. Use "Refresh sessions" to update it.

### Groups and splits

On desktop, each new session starts in its own group; group tabs appear when there is more than one. Under "New split terminal", "Split right" and "Split down" create a shell beside the current session, and splits can be subdivided. Drag session titles or group tabs to reorder, move to another group or form a new group; the session menu offers the same actions. "Maximize terminal" shows one split, and "Restore split" brings the layout back. "Close display" closes only the display; the session continues and can be reopened through "Select terminal session".

In Files or Git on desktop, click "Expand terminal panel" on the right of the tool row to show a terminal below. "Open in Terminal" switches to the Terminal tool.

"Focus terminal" hides the top bar, sidebar and tool row. On desktop it also enters fullscreen; leaving fullscreen leaves focus mode. On phones the same button progresses through "Focus terminal", "Enter fullscreen" and "Exit focus mode". Switching device, workspace or tool exits automatically.

### Copy and paste

Scroll up to view retained history. New output does not pull you to the bottom; use "Scroll to bottom" for the latest output. Each client's scrolling and selection are independent.

- Desktop: drag to select text. Hold Shift while dragging if a program such as htop handles the mouse. Copy through the context menu, or Cmd-C on macOS. Paste with Ctrl-Shift-V, Cmd-V or the context menu. Ctrl-C and Ctrl-V are sent to the program.
- Phone: long-press to select a word, drag the selection handles, then tap "Copy selected text". Tap the terminal or "Keyboard" to open the keyboard. A "Paste" button appears when the browser allows clipboard access.

Oversized pastes are not sent and show "Pasted text exceeds the input limit". Programs cannot display images or write to the clipboard through OSC 52 in the web terminal.

The phone's always-visible key row contains SHIFT, CTRL, ALT and ←, ↓, →. Expanding adds TAB, /, @, PGUP, ↑, PGDN and ESC. "Collapse terminal keys" also hides ↑. Tap SHIFT, CTRL or ALT once to apply it to the next key, and again to cancel. In the web app, Ctrl-b goes directly to the program; it is not a tmux prefix.

### Search and display

"Search terminal" searches currently loaded display content, including history, without case sensitivity. Enter advances, Shift-Enter goes back, and Esc closes search. "Increase font size" and "Decrease font size" in the session menu change this display and the size used for terminals subsequently opened in this browser.

"Scrollback lines for new sessions" in "Terminal settings" controls the history retained per session (range in [Limits](reference.en.md#limits)). It affects only sessions created afterward.

A session has one row/column size, determined by the client that most recently typed or resized its window. Other clients reflow to it. Opening the phone keyboard does not resize the session.

### Connection and recovery

Opening a session shows "Connecting". Input is available after its display and history are restored. Possible notices:

| Notice                                          | Action                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| "Connection closed"                             | Click "Reconnect"                                                                  |
| "Terminal recording is unavailable."            | The program is still running; click "Recover terminal"                             |
| Insufficient capacity, timeout or resource busy | Click "Reconnect", or "Retry with less history" to restore only the current screen |
| "Older history was reduced"                     | Older scrollback was omitted from this display; device history is unchanged        |
| "Some terminal history is missing"              | Some output was lost during a recorder failure                                     |
| "Ended"                                         | The session has ended and is read-only; parentheses show the exit code             |

"Recover terminal" rebuilds recording and reattaches to the same program without restarting it. If connected but the display is garbled, use "Redraw program" in the session menu. It briefly resizes the program to trigger a redraw, which can change other clients' displays and selections, so it requires confirmation. If that does not help, use "Close display" and reopen it. See [Recovery actions (Chinese)](../design/terminal.md#恢复动作).

"End session" in the session menu asks once, then ends the session and every program in it.

### Local attach

"Local attach command" in the web session menu gives a command to attach to that session. Run it in a real terminal on the device as the project user, without sudo. For example:

```sh
/usr/local/bin/kiteline-agent attach SESSION_ID --run-dir '/home/PROJECT_USER/.local/share/kiteline-agent/run'
```

Once attached, Ctrl-b d detaches while the session continues, Ctrl-b Ctrl-b sends Ctrl-b, and Ctrl-b [ opens tmux copy mode to browse history. While the agent is running, you can also manage sessions locally:

```sh
kiteline-agent workspace list
kiteline-agent terminal new --workspace WORKSPACE_ID
kiteline-agent terminal list --workspace WORKSPACE_ID
kiteline-agent attach SESSION_ID
kiteline-agent terminal end SESSION_ID
```

`workspace list` gives workspace IDs. `terminal new` creates a session and immediately attaches. See [kiteline-agent commands](reference.en.md#kiteline-agent-commands) for output and options.

On Windows in PowerShell 7, replace `kiteline-agent` with `& "$env:ProgramData\kiteline-agent\kiteline-agent.ps1"` (see both forms in [kiteline-agent commands](reference.en.md#kiteline-agent-commands)). Local commands and the agent must resolve to the same runtime directory (see [Agent environment variables](reference.en.md#agent-environment-variables)). If `KITELINE_AGENT_RUN_DIR` is set only in service configuration, set it for local commands too. `attach` also accepts `--run-dir`, included in the copied web command. For containers, see [Run in a container](devices.en.md#run-in-a-container).

## Files

Files browses and edits the current workspace, showing paths relative to its directory.

### Browse

Desktop has a directory tree on the left; phones navigate one level at a time. For large directories, click "Load more". Each row's menu has "Details" and other actions. Names that are not valid UTF-8 show "Unsupported name encoding"; FIFOs, sockets and device nodes show "Special file". Handle these in a terminal.

The list refreshes automatically when other programs change files, and periodically while the page is visible. If the device cannot watch directories, a notice says "Live updates are limited; periodic refresh remains available". "More file actions" includes "Refresh".

### Open and edit

PNG, JPEG, GIF and WebP images are detected by content and previewed. Other files open as UTF-8 text. Files containing NUL bytes, invalid UTF-8 or content exceeding editing limits (see [Limits](reference.en.md#limits)) cannot be edited; use "Download file".

The editor preserves the original BOM, line endings and final newline. Mixed line endings show "Mixed line endings; saves use {{format}}" (LF or CRLF). Save with "Save file" or Ctrl-S (Cmd-S on macOS). The toolbar also offers "Save as", "Copy text" and "Check disk content". An edit that would exceed the editing limit is rejected in full, with "Content exceeds the per-file editing limit".

After copying successfully, the current file or its entry in "Open files" shows "Copied". This does not mean the content was saved.

To save, the agent writes a temporary `.kiteline-<random ID>.tmp` file in the same directory, then replaces the original. The temporary file briefly appears in the directory; those left after an abnormal agent exit are cleaned up at the next startup. Saving through a symbolic link writes to its target and preserves the original file's ordinary permission bits.

### Drafts

Unsaved edits, or drafts, exist only in the current page:

- They survive switching files, tools, workspaces and devices. Unsaved tabs have a dot. "Open files" in the overflow menu lists open files across all devices for copying or closing.
- Closing an edited file asks "Save changes?", with "Discard changes" and "Save and close".
- Reloading or closing the page triggers a browser prompt. Confirming that you want to leave loses the drafts.
- If a device goes offline or a device/workspace is deleted, content remains viewable and copyable, but cannot be saved to its original location.

### Save conflicts

If a file changed since it was opened or last saved, saving does not proceed and shows "The current state has changed. Refresh and check before continuing." Click "Check disk content" to open "Disk content changed" and view the current disk text. "Load disk version" discards your changes; "Overwrite this version" replaces it with your content; "Cancel" defers the decision.

Changes to an open file produce "Disk content changed" above the editor, without reloading automatically. If a save result is uncertain, for example after losing connection during saving, the UI shows "Result unconfirmed". Click "Check disk content": matching content shows "Disk content matches the last submitted content"; otherwise the disk version is shown for your decision. See [Saving (Chinese)](../design/files.md#保存).

### Image preview

Image actions include "Fit to screen", "Actual size", "Zoom in", "Zoom out", "Reload image" and "Download file". Images exceeding preview byte or pixel limits can only be downloaded.

### Search

Click "Search files or content", choose "Content" or "File name", and enter a query. Click a result to open the file; content results go to the matching line. Rules:

- Matches literal text, case-sensitively.
- "File name" finds files whose relative paths, including directories, contain the query. Results contain files only.
- Includes hidden files, excludes `.git`, and does not follow any symbolic links, whether to files or directories.
- `.gitignore` applies only inside Git repositories; `.ignore` and `.rgignore` always apply. Check "Include ignored files" to include files excluded by these rules.
- Results and search duration are limited (see [Limits](reference.en.md#limits)). Reaching a limit shows "incomplete results". Results with non-UTF-8 paths are omitted and also mark the results incomplete.

### Create and rename

Use "New file" in the toolbar or "New directory" under "More file actions" to create entries in the current directory. New files open immediately. Creation and "Rename" fail if the name exists; nothing is overwritten. Open tabs follow renamed or moved paths. The workspace root and files currently being saved cannot be renamed, moved or deleted.

### Upload and download

Upload: choose "Upload files" under "More file actions" and select one or more files, not directories. You can edit each destination path. Click "Upload" to send them sequentially. Once data is sent, the status is "Waiting for device to finish", then "Uploaded" on completion. You can "Collapse" the dialog and reopen it through upload status, or "Cancel upload".

Download: "Download" in a file menu, "Download selected file" in selection mode, or "Download file" in the editor hands the download to the browser's download manager. Failures appear at the top of the page as "Download failed for {{path}}: {{error}}". Directories cannot be downloaded. See [Limits](reference.en.md#limits) for size limits.

### Organize files

Use "Copy", "Move" and "Delete" in a file's menu for one item. For several, choose "Select files" under "More file actions", select items and act. For copying and moving, fill in "Destination directory"; you can also edit individual destination paths. Copies within the same directory receive a non-conflicting name in advance. The operation dialog cannot close while running, but offers "Cancel operation".

- Directory copies are recursive. Symbolic links are copied as links; hard links become independent files.
- Moving within one filesystem renames the entry; moving across filesystems copies first, then deletes the source.
- An existing destination makes that item fail. Files are not overwritten and directories are not merged; see [Name conflicts](#name-conflicts).

Deletion requires one confirmation and is permanent, with no trash. Directories are deleted recursively, including data on other filesystems mounted inside them; the prompt then says "Permanently delete the selected items and any shared data mounted inside them? Mount points may remain." Deleting a symbolic link removes only the link. FIFOs, sockets and device nodes cannot be copied, moved or deleted; directories containing them can only be partially deleted.

### Name conflicts

When an upload, copy or move destination already exists, click "Resolve name conflict" for the item:

- "Keep both": uses "Path for the new copy", defaulting to a suggested name such as `config (2).json`, `src (2)` or `.env (2)`. If that name is taken by execution time, the item still fails.
- "Replace": overwrites the file and marks the item "Replacement of the target entry confirmed". Directories cannot be replaced. If the destination changes after confirmation, replacement does not proceed. For a symbolic link, the notice says "Replacing removes the symbolic link. Its original target is unchanged."

"Skip" beside an item leaves it unprocessed.

### Results and cancellation

Each result is "Completed", "Not completed" (not executed or confirmed failed, with no disk change), "Partially completed" (for example, only some files in a directory were processed), or "Result unconfirmed" (contact was lost during execution; inspect disk before deciding). Cancellation stops only work not yet started; completed work remains. Edit incomplete items and choose "Retry incomplete items".

### Symbolic links

Files follows symbolic links accessible to the project user, including links to directories outside the workspace. Directory links offer "Open linked directory". Opening and saving affect the target file; renaming, moving, deleting and replacing affect only the link.

Directory uploads, archive downloads and copying across workspaces are not provided by Files; see [Out of scope (Chinese)](../design/files.md#范围外).

## Git

Git uses the device's Git installation and the project user's Git configuration, including hooks, signing and credentials. Git 2.23.0 or later is required; see [Supported systems and prerequisites](devices.en.md#supported-systems-and-prerequisites).

### Discover and switch repositories

Git scans the workspace directory and all subdirectories, listing repositories including initialized submodules and linked worktrees within the workspace (marked `worktree`). Repositories outside the workspace are not used. If the workspace is only a subdirectory of a repository, it shows "No Git repositories found"; add the repository root as a workspace.

With several repositories, the first is selected automatically. Switch by path in the upper-left repository menu. "Discover repositories again" rescans; click "Continue scan" when "Repository scan incomplete" appears. Bare repositories are not supported.

### Status and diff

"Changes" shows the current branch, upstream and ahead (↑)/behind (↓) commit counts at the top. Entries are grouped into "Conflicts", "Staged changes" and "Changes", with untracked files in "Changes". Click an entry for a single-column diff. Large diffs show "Diff exceeds the display line limit" or "Diff data was truncated" and part of the raw patch. Use "Previous Git page" and "Next Git page" for many changes; group counts cover the whole repository. Entries with non-UTF-8 paths cannot be operated on. The list refreshes automatically; "Refresh Git" refreshes immediately.

### Stage and commit

The plus on each row stages it; the minus unstages it. Select multiple rows and use group-header buttons for batch actions.

- Staging uses files on disk. If selected files have unsaved drafts, it asks "Selected files have unsaved changes. Stage the disk versions on the device?"
- An action that would also change unselected paths does not proceed. Those paths and the required preceding actions are listed.
- For a staged rename, the minus unstages both old and new paths. "Unstage the new path only" in the row menu affects only the new path.

Enter a "Commit message" and click "Commit" (on phones, first tap "Commit" to open the input). The commit includes everything staged, regardless of the current page or selected rows. You cannot commit with an empty message, unresolved conflicts or no staged changes.

### Discard changes

The row menu offers "Discard unstaged changes" (restore the index version) and "Discard all changes" (restore the HEAD version). The dialog first lists whether each item will be restored or deleted; review and click "Discard". Files listed for deletion, such as untracked files, are permanently deleted. If a file changes after review, the operation does not proceed and must be reviewed again.

### Branches and history

"Branches" lists local branches. Branches checked out in other worktrees show their paths and cannot be switched to or deleted. Switching does not force-overwrite local changes. Deletion runs `git branch -d`, which rejects unmerged branches; Git rejection shows [Result unconfirmed](#result-unconfirmed). "Create branch" offers "Switch after creating", and history offers "Create branch from this commit".

"History" lists commits in pages. Click a commit for its changed files, then a file for the diff against its parent. Merge commits let you choose the parent.

### Synchronization and authentication

Fetch (with a remote choice), Pull and Push are on the right of the repository header; tooltips show the target. Pull runs `git pull`, using the default commit message for merges. Pull configured for interactive rebase fails. Push runs `git push`; force push is not available.

Authentication cannot be interactive: Git does not prompt for a username or password. SSH keys, ssh-agent or credential helpers must work without input in the agent's environment. If authentication fails, click "Terminal" in the feedback and run the same Git command in that workspace's terminal to finish configuration, such as saving credentials in a helper, then return and retry. For service agents, see [Run in the background](devices.en.md#run-in-the-background); for details, see [Synchronization and authentication (Chinese)](../design/git.md#同步与认证).

### Conflicts and continuation

During merge, rebase, cherry-pick, revert or am, including operations begun in a terminal, the top shows the operation and reason, with "Continue", "Abort" and "Continue in Terminal":

1. Resolve and save conflicts in Files or a terminal.
2. Click the plus on a conflict row in Git to mark it resolved.
3. Once no conflicts remain, click "Continue" to use the default commit message.

After confirmation, "Abort" asks Git to restore the pre-operation state; uncommitted content may be affected. The web app can continue only rebases consisting of ordinary pick steps. Finish rebases with edit, reword, squash, fixup, exec or other steps, and unrecognized operations, in a terminal, then refresh the web app. See [Conflicts and operations in progress (Chinese)](../design/git.md#冲突与进行中的操作).

### Result unconfirmed

Each repository executes one Git write at a time, queuing the rest. "Cancel operation" is available during execution. The workbench cannot determine the repository state in these cases and shows "Result unconfirmed. Refresh and check before trying again.":

- A Git command exits unsuccessfully, such as a rejected push, a commit rejected by a hook, or an existing `index.lock`.
- Contact is lost during execution.
- The operation is cancelled.
- The write deadline is exceeded (see [Limits](reference.en.md#limits)).

Expand "Git output" to read Git's original output, then "Refresh Git" to check branches, commits and changes. Retry manually only after confirming that the operation did not take effect. The workbench does not retry automatically.

A partially completed multi-step operation shows "The operation was only partially completed." See [Result semantics (Chinese)](../design/protocol.md#结果语义). Use a terminal for stash, line staging and other omitted functions; see [Out of scope (Chinese)](../design/git.md#范围外).

## Access development services

The workbench opens HTTP services listening on local device ports, including WebSocket (and hot reload) and SSE. Links require workbench sign-in and are not public shares. Closing a page does not stop the service. Signing out, login expiry or deleting the device disconnects open connections.

### Open a port

After selecting a device, click "Open port" in the top bar. Enter a "Port" or choose one under "Listening ports", select "Strip prefix" or "Keep prefix", then "Open" or "Copy link". Candidates are a snapshot; "Refresh listening ports" reads them again. They may include non-HTTP services, and unlisted ports can be entered manually.

The service must listen on `127.0.0.1`, `::1`, `0.0.0.0` or `::` on the agent's machine or container. See [Run in a container](devices.en.md#run-in-a-container) and [Port suggestions (Chinese)](../design/http-access.md#端口建议).

In terminal output, `http:` links whose hosts are `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0` or `[::]` are converted to that device's port address. Click on desktop; on phones, long-press to select the full link and tap "Open device port". Other links open their original addresses.

### Two path modes

| Mode           | Address                      | Path received by the service |
| -------------- | ---------------------------- | ---------------------------- |
| "Strip prefix" | `/proxy/DEVICE_ID/PORT/…`    | Prefix removed               |
| "Keep prefix"  | `/absproxy/DEVICE_ID/PORT/…` | Full prefix retained         |

"Strip prefix" suits pages using only relative URLs. If a page references resources with paths starting with `/`, requests go to the workbench root, causing blank pages or MIME-type errors. Use "Keep prefix" for these projects and set the project's base to `/absproxy/DEVICE_ID/PORT/`.

The service receives the workbench address as `Host`, such as `kiteline.example.com:8443`; the workbench login cookie is not forwarded. See [Addresses and path modes (Chinese)](../design/http-access.md#地址与路径模式) for full rules. Find the device ID in its page URL `/devices/DEVICE_ID`, or choose "Keep prefix" and "Copy link".

### Configure Vite

Use "Keep prefix" for Vite and set `vite.config.js`:

```js
export default {
  base: "/absproxy/DEVICE_ID/3000/",
  server: {
    port: 3000,
    strictPort: true,
    allowedHosts: ["kiteline.example.com"],
    proxy: {
      "/absproxy/DEVICE_ID/3000/api": {
        target: "http://127.0.0.1:8000",
        rewrite: (path) => path.replace("/absproxy/DEVICE_ID/3000", ""),
      },
    },
  },
};
```

- Replace `DEVICE_ID` with the device ID and `3000` with the development-service port.
- List every domain used to access the workbench in `allowedHosts`, without ports. This is unnecessary for IP addresses or `localhost`. Missing hosts cause Vite to return 403 and `Blocked request`.
- `server.proxy` keys must include the base prefix, or requests receive `index.html`. The example sends `/api/…` to the backend with the prefix removed.
- HTML resources processed by Vite get the base automatically. Hot reload uses the same address by default and needs no separate setup.

Build application-generated URLs from the base, and give the router the same prefix:

```js
const base = new URL(import.meta.env.BASE_URL, location.origin);
fetch(new URL("api/status", base));
const socketUrl = new URL("socket", base);
socketUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(socketUrl);
```

### Common errors

- Redirected to sign-in: the browser is not signed in or its login expired. Signing in returns to the original URL automatically.
- 502: no service on the port, the service listens only on another address, or it is not HTTP.
- 503: device offline. 426: agent/server version mismatch; see [Upgrade the agent](devices.en.md#upgrade-the-agent). 404: device ID does not exist.
- 504 or 429: connection timeout or device connection capacity reached. Retry later.
- Blank page or MIME-type error: use "Keep prefix" and configure the base.

Workbench-generated error pages are in English; errors returned by the development service appear unchanged. See [Error responses (Chinese)](../design/http-access.md#错误响应) for all status codes.

### Security

Development pages share the workbench's origin (scheme, domain and port). Their scripts can call workbench APIs with your access, including running commands and modifying files on any device. Pages for all projects and ports share `Path=/` cookies, localStorage and Service Workers and can overwrite each other's data. A page's `Clear-Site-Data` response can clear your workbench login. Open only projects you trust, and do not access unfamiliar services this way. See [Security boundary (Chinese)](../design/http-access.md#安全边界).
