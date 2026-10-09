# Use the workbench

[中文](usage.md)

This guide is for owners who have connected devices and want to use the workbench in a browser. See [Connect devices](devices.en.md) for device setup and [Scheduled tasks](scheduled-tasks.en.md) for scheduled commands.

## Browser and interface

### Supported browsers

The workbench supports desktop Chrome and Android Chrome, with Chromium 97 as the minimum. When accessing it over HTTPS or `localhost`, current Chrome versions can install it as an app from the browser menu and open it in a separate window. It still needs a connection to the server and has no offline functionality.

### Sign-in and language

Origins with different hostnames or schemes, such as `http://192.168.1.10:8080` and `https://kiteline.example.com`, require separate sign-ins. Different ports on the same host and scheme share a login. Preferences such as language are stored separately in the browser per origin, including the port. Signing out asks you to confirm discarding unsaved files. It ends only this browser's login; terminal sessions keep running. For a forgotten password, see [Reset the setup token or password](server.en.md#reset-the-setup-token-or-password).

Language follows the browser by default: Simplified Chinese for Chinese locales, English otherwise. Switching language does not affect open files or terminals.

The address bar records the device, workspace, tool and open file, repository and session, so you can use Back, Forward and bookmarks. The top bar's status dot represents the browser's connection to the server, not whether a device is online.

After a server upgrade, an already open page shows the Web and Server versions and pauses remote operations. Copy unsaved content before clicking "Reload page".

Layout follows the available window width. Below 960 CSS pixels, it shows one terminal session at a time, without a terminal panel in Files or Git. At 960 pixels or wider, split terminals and the terminal panel are available.

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

For new devices, see [Connect using the web command](devices.en.md#connect-using-the-web-command). For a version mismatch, see [Upgrade the agent](devices.en.md#upgrade-the-agent).

Deleting a device removes its record, binding and scheduled-task summaries from the server and immediately disconnects remote access. The agent, terminal sessions, scheduled tasks and files remain on the device, but the agent cannot reconnect without binding again. Deleting the record does not [uninstall the agent](devices.en.md#uninstall).

### Workspaces

A workspace is a registered project directory on a device. Select the project directory in "Add workspace" on an online device. The registered path is the real directory after resolving symbolic links. Adding the same directory again returns the existing workspace.

Removing a workspace deletes only the registration, keeping directories and files. A workspace cannot be removed while the device is offline or it still has terminal sessions.

A workspace is not a sandbox. Terminal, file and Git operations use the project user's permissions and can access any path that user can access.

Terminal sessions keep running when you switch tools, workspaces or devices. Leaving a workspace closes its terminal displays; returning attaches again. Groups, splits, unsaved changes and Git commit messages remain until the page closes.

## Terminal

Terminal sessions run on the device. Closing the page, losing the network, signing out, restarting the server or deleting the device does not end them. A session ends when its shell or shortcut command exits, you end it, the agent shuts down normally, or the device restarts. For abnormal exit, see [Clean up leftover terminal sessions](reference.en.md#clean-up-leftover-terminal-sessions). The same session can be open in multiple browsers and local terminals at once. All clients can type directly; simultaneous input is interleaved.

If the terminal remains unresponsive, close displays of the same session that you are not using, then try again.

### Create sessions and shortcuts

New sessions start in the workspace directory and inherit the agent's environment (from service configuration when running as a service; see [Run in the background](devices.en.md#run-in-the-background)). Linux and macOS use the project user's login shell; Windows uses PowerShell. See [Shell](reference.en.md#shell) for defaults and configuration.

Shortcuts run one command in the login shell; the session ends when that command exits. Install the AI CLI programs used by the default shortcuts yourself.

"Close display" closes only the display; the session continues and can be reopened through "Select terminal session".

### Copy and paste

Scroll up to read retained history; new output does not pull you back to the bottom. Each client's scrolling and selection are independent.

- Desktop: drag to select text. Hold Shift while dragging if a program such as htop handles the mouse. Copy through the context menu, or Cmd-C on macOS. Paste with Ctrl-V, Ctrl-Shift-V, Cmd-V or the context menu. Ctrl-C is sent to the program.
- Phone: long-press to select a word, drag the selection handles, then tap "Copy selected text". Tap the terminal or "Keyboard" to open the keyboard. A "Paste" button appears when the browser allows clipboard access.

Oversized pastes are not sent and show "Pasted text exceeds the input limit". Programs cannot display images or write to the clipboard through OSC 52 in the web terminal.

On the phone key row, tap SHIFT, CTRL or ALT once to apply it to the next key, and again to cancel. In the web app, Ctrl-b goes directly to the program; it is not a tmux prefix.

### Search and display

The Focus terminal button cycles through focus within the window, browser fullscreen, and exit. The first step hides the rest of the workbench while keeping the browser window's position and size, so several windows can monitor output at once. Leaving fullscreen through the browser keeps window focus active; click the button again to exit.

Terminal search covers currently loaded display content, including history, without case sensitivity.

"Scrollback lines for new sessions" in "Terminal settings" controls the history retained per session (range in [Limits](reference.en.md#limits)). It affects only sessions created afterward.

A session has one row/column size, determined by the client that most recently typed or resized its window. Other clients reflow to it. Opening the phone keyboard does not resize the session.

### Connection and recovery

Input is available after the session's display and history are restored. Reconnect after a connection failure. If capacity is insufficient, retry with less history to restore only the current screen; history on the device is unchanged. A history gap means some output was lost during a recorder failure. Ended sessions are read-only and show their exit code.

"Recover terminal" rebuilds recording and reattaches to the same program without restarting it. If connected but the display is garbled, use "Redraw program" in the session menu. It briefly resizes the program to trigger a redraw, which can change other clients' displays and selections, so it requires confirmation. If that does not help, use "Close display" and reopen it.

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

For this section's interactive commands in a Windows PowerShell console, replace `kiteline-agent` with `& "$env:ProgramData\kiteline-agent\kiteline-agent.ps1"`; see [kiteline-agent commands](reference.en.md#kiteline-agent-commands) for choosing the invocation form. Local commands and the agent must resolve to the same runtime directory (see [Agent environment variables](reference.en.md#agent-environment-variables)). If `KITELINE_AGENT_RUN_DIR` is set only in service configuration, set it for local commands too. `attach` also accepts `--run-dir`, included in the copied web command. For containers, see [Run in a container](devices.en.md#run-in-a-container).

## Files

Files browses and edits the current workspace, showing paths relative to its directory.

### Browse

Handle names that are not valid UTF-8, FIFOs, sockets and device nodes in a terminal.

The list refreshes automatically when other programs change files, and periodically while the page is visible. Periodic refresh remains available if the device cannot watch directories.

### Open and edit

PNG, JPEG, GIF and WebP images are detected by content and previewed; images exceeding preview byte or pixel limits can only be downloaded. Other files open as UTF-8 text. Files containing NUL bytes, invalid UTF-8 or content exceeding editing limits (see [Limits](reference.en.md#limits)) can be downloaded but not edited.

The editor preserves the original BOM, line endings and final newline. For mixed line endings, it indicates whether saves will use LF or CRLF. An edit that would exceed the editing limit is rejected in full. Copying content does not mean it was saved.

Saving replaces the original with a new file, so its parent directory must allow file creation and renaming. Ordinary permission bits are preserved; ownership, group, ACLs and extended attributes follow the rules for new files. Other hard links still point to the old content. Saving through a symbolic link writes to its target.

In narrow layouts, the Focus file button cycles through focus within the window, browser fullscreen, and exit. Focus hides workbench navigation and draft tabs while keeping editing, preview, and save actions available. Opening another file or leaving Files exits focus and keeps unsaved drafts.

### Markdown preview

Switch `.md` and `.markdown` files between source and preview. The preview includes unsaved edits and supports tables, task lists, strikethrough, local images and section links. Relative file links open their targets in Files. Returning to source locates the paragraph you were reading; switching back to preview lets you continue there.

Raw HTML appears as text. External images appear as links that open in a new tab.

### Drafts

Unsaved edits, or drafts, exist only in the current page:

- They survive switching files, tools, workspaces and devices. "Open files" lets you find open drafts across all devices.
- Reloading or closing the page triggers a browser prompt. Confirming that you want to leave loses the drafts.
- If a device goes offline or a device/workspace is deleted, content remains viewable and copyable, but cannot be saved to its original location.

### Save conflicts

If a file changed since it was opened or last saved, saving does not proceed and the file is not automatically reloaded. Use "Check disk content" to read the current disk text, then decide whether to load it and discard your draft, overwrite that version, or defer the decision.

If a save result is uncertain, for example after losing connection during saving, compare the disk content with the last submitted content before deciding what to do next.

### Search

File search supports content and file names, with these rules:

- Matches literal text, case-sensitively.
- "File name" finds files whose relative paths, including directories, contain the query. Results contain files only.
- Includes hidden files, excludes `.git`, and does not follow any symbolic links, whether to files or directories.
- `.gitignore` applies only inside Git repositories; `.ignore` and `.rgignore` always apply. Check "Include ignored files" to include files excluded by these rules.
- Results and search duration are limited (see [Limits](reference.en.md#limits)). Reaching a limit shows "incomplete results". Results with non-UTF-8 paths are omitted and also mark the results incomplete.

### Create and rename

Creation and renaming fail if the name exists; nothing is overwritten. Open tabs follow renamed or moved paths. The workspace root and files currently being saved cannot be renamed, moved or deleted.

### Upload and download

Choose files or drop them onto Files to upload. The confirmation dialog defaults to the current directory and lets you change destination paths. A drop containing any directory is rejected in full. Uploads send files sequentially. After data is sent, the device still needs to finish. Collapsing the dialog does not cancel the upload. Downloads use the browser's download manager; directories cannot be downloaded. See [Limits](reference.en.md#limits) for size limits.

### Organize files

- Directory copies are recursive. Symbolic links are copied as links; hard links become independent files.
- Moving within one filesystem renames the entry; moving across filesystems copies first, then deletes the source.
- An existing destination makes that item fail. Files are not overwritten and directories are not merged; see [Name conflicts](#name-conflicts).

Deletion is permanent, with no trash. Directories are deleted recursively, including data on other filesystems mounted inside them; mount points may remain. Deleting a symbolic link removes only the link. FIFOs, sockets and device nodes cannot be copied, moved or deleted; directories containing them can only be partially deleted.

### Name conflicts

When an upload, copy or move destination already exists, click "Resolve name conflict" for the item:

- "Keep both": uses another path. If that path is taken by execution time, the item still fails.
- "Replace": overwrites the file; directories cannot be replaced. If the destination changes after confirmation, replacement does not proceed. For a symbolic link, only the link is replaced; its original target is unchanged.

### Results and cancellation

Each result is "Completed", "Not completed" (not executed or confirmed failed, with no disk change), "Partially completed" (for example, only some files in a directory were processed), or "Result unconfirmed" (contact was lost during execution; inspect disk before deciding). Cancellation stops only work not yet started; completed work remains. Edit incomplete items and choose "Retry incomplete items".

### Symbolic links

Files follows symbolic links accessible to the project user, including links to directories outside the workspace. Opening and saving affect the target file; renaming, moving, deleting and replacing affect only the link.

Directory uploads, archive downloads and copying across workspaces are not provided by Files; see [Out of scope (Chinese)](../design/files.md#范围外).

## Git

Git uses the device's Git installation and the project user's Git configuration, including hooks, signing and credentials. For installation requirements, see [Supported systems and prerequisites](devices.en.md#supported-systems-and-prerequisites).

### Discover and switch repositories

Git scans the workspace directory and all subdirectories, listing repositories including initialized submodules and linked worktrees within the workspace (marked `worktree`). Repositories outside the workspace are not used. If the workspace is only a subdirectory of a repository, it shows "No Git repositories found"; add the repository root as a workspace.

With several repositories, the first is selected automatically. Switch by path in the repository menu. "Discover repositories again" rescans; click "Continue scan" when "Repository scan incomplete" appears. Bare repositories are not supported.

### Status and diff

Diffs exceeding the limit show only part of the raw patch. Changes are paginated, but group counts cover the whole repository. Entries with non-UTF-8 paths cannot be operated on.

### Stage and commit

- Staging uses files on disk, not unsaved drafts.
- An action that would also change unselected paths does not proceed. Those paths and the required preceding actions are listed.
- Unstaging a rename affects both old and new paths. "Unstage the new path only" affects only the new path.

The commit includes everything staged, regardless of the current page or selected rows. You cannot commit while status is refreshing, with an empty message, unresolved conflicts or no staged changes.

### Discard changes

"Discard unstaged changes" restores the index version; "Discard all changes" restores the HEAD version. Before proceeding, review whether each item will be restored or deleted. Files listed for deletion, such as untracked files, are permanently deleted. If a file changes after review, the operation does not proceed and must be reviewed again.

### Branches and history

"Branches" lists local branches. Branches checked out in other worktrees show their paths and cannot be switched to or deleted. Switching does not force-overwrite local changes. Deletion runs `git branch -d`, which rejects unmerged branches; Git rejection shows [Result unconfirmed](#result-unconfirmed).

History file line counts and diffs compare against the same parent commit. For merge commits, you can choose the parent. Binary files do not show line counts.

### Synchronization and authentication

Pull runs `git pull`, using the default commit message for merges. Pull configured for interactive rebase fails. Push runs `git push`; force push is not available.

Authentication cannot be interactive: Git does not prompt for a username or password. SSH keys, ssh-agent or credential helpers must work without input in the agent's environment. If authentication fails, click "Terminal" in the feedback and run the same Git command in that workspace's terminal to finish configuration, such as saving credentials in a helper, then return and retry. For service agents, see [Run in the background](devices.en.md#run-in-the-background).

### Conflicts and continuation

During merge, rebase, cherry-pick, revert or am, including operations begun in a terminal, the top shows the operation and reason, with "Continue", "Abort" and "Continue in Terminal":

1. Resolve and save conflicts in Files or a terminal.
2. Click the plus on a conflict row in Git to mark it resolved.
3. Once no conflicts remain, click "Continue" to use the default commit message.

After confirmation, "Abort" asks Git to restore the pre-operation state; uncommitted content may be affected. The web app can continue only rebases consisting of ordinary pick steps. Finish rebases with edit, reword, squash, fixup, exec or other steps, and unrecognized operations, in a terminal, then refresh the web app.

### Result unconfirmed

Each repository executes one Git write at a time, queuing the rest. "Cancel operation" is available during execution. The workbench cannot determine the repository state in these cases and shows "Result unconfirmed. Refresh and check before trying again.":

- A Git command exits unsuccessfully, such as a rejected push, a commit rejected by a hook, or an existing `index.lock`.
- Contact is lost during execution.
- The operation is cancelled.
- The write deadline is exceeded (see [Limits](reference.en.md#limits)).

Expand "Git output" to read Git's original output, then "Refresh Git" to check branches, commits and changes. Retry manually only after confirming that the operation did not take effect. The workbench does not retry automatically.

A partially completed multi-step operation shows "The operation was only partially completed." Use a terminal for stash, line staging and other omitted functions; see [Out of scope (Chinese)](../design/git.md#范围外).

## Access development services

The workbench opens HTTP services listening on local device ports, including WebSocket (and hot reload) and SSE. Links require workbench sign-in and are not public shares. Closing a page does not stop the service. Signing out, login expiry or deleting the device disconnects open connections.

### Open a port

Enter a port in the device's "Open port" dialog. Candidates are a snapshot and may include non-HTTP services; unlisted ports can be entered manually.

The service must listen on `127.0.0.1`, `::1`, `0.0.0.0` or `::` on the agent's machine or container. See [Run in a container](devices.en.md#run-in-a-container).

In terminal output, `http:` links whose hosts are `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0` or `[::]` are converted to that device's port address. Click on desktop; on phones, long-press to select the full link and tap "Open device port". Other links open their original addresses.

### Two path modes

| Mode           | Address                      | Path received by the service |
| -------------- | ---------------------------- | ---------------------------- |
| "Strip prefix" | `/proxy/DEVICE_ID/PORT/…`    | Prefix removed               |
| "Keep prefix"  | `/absproxy/DEVICE_ID/PORT/…` | Full prefix retained         |

"Strip prefix" suits pages using only relative URLs. If a page references resources with paths starting with `/`, requests go to the workbench root, causing blank pages or MIME-type errors. Use "Keep prefix" for these projects and set the project's base to `/absproxy/DEVICE_ID/PORT/`.

The service receives the workbench address as `Host`, such as `kiteline.example.com:8443`; the workbench login cookie is not forwarded. Find the device ID in its page URL `/devices/DEVICE_ID`, or choose "Keep prefix" and "Copy link".

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

Workbench-generated error pages are in English; errors returned by the development service appear unchanged.

### Security

Development pages share the workbench's origin (scheme, domain and port). Their scripts can call workbench APIs with your access, including running commands and modifying files on any device. Pages for all projects and ports share `Path=/` cookies, localStorage and Service Workers and can overwrite each other's data. A page's `Clear-Site-Data` response can clear your workbench login. Open only projects you trust, and do not access unfamiliar services this way. See [Security boundary (Chinese)](../design/http-access.md#安全边界).
