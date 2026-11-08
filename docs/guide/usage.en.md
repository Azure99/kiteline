# Use the workbench

[中文](usage.md)

This guide is for owners who have connected devices and want to use the workbench in a browser. See [Connect devices](devices.en.md) for device setup and [Scheduled tasks](scheduled-tasks.en.md) for scheduled commands.

## Browser and interface

### Supported browsers

The workbench requires at least Chromium 97. When accessing it over HTTPS or `localhost`, current Chrome versions can install it as an app from the browser menu.

### Sign-in and language

Origins with different hostnames or schemes, such as `http://192.168.1.10:8080` and `https://kiteline.example.com`, require separate sign-ins. Different ports on the same host and scheme share a login. Preferences such as language are stored separately in the browser per origin, including the port. Signing out asks you to confirm discarding unsaved files. It ends only this browser's login; terminal sessions keep running. For a forgotten password, see [Reset the setup token or password](server.en.md#reset-the-setup-token-or-password).

Language follows the browser by default: Simplified Chinese for Chinese locales, English otherwise. Choose system, light or dark appearance from Settings at the bottom of the left sidebar.

The address bar records the device, workspace, tool and open file, repository and session, so you can use Back, Forward and bookmarks.

After a server upgrade, an already open page shows the Web and Server versions and pauses remote operations. Copy unsaved content before clicking "Reload page".

Wide layouts switch between Work pages, Together and Terminal, and Together shows work pages and a terminal at the same time; narrow layouts show only work pages or a terminal.

Device names, workspaces, files and folders, Git changes and work page tabs support context menus for the pointed object. On a phone, long-press an object or use its More button.

### Where settings are stored

| Content                                                                     | Storage                               |
| --------------------------------------------------------------------------- | ------------------------------------- |
| Language, appearance, recent workspaces, terminal font size, file font size | Current browser                       |
| Terminal groups and splits                                                  | Current browser tab                   |
| Work-page tabs, content mode and Together layout                            | Current page, per workspace           |
| Unsaved changes, commit messages                                            | Current page; lost on reload or close |
| New-session scrollback lines, terminal shortcuts                            | Device; shared across origins         |
| Device name                                                                 | Server                                |
| Workspace names and paths                                                   | Device                                |

## Devices and workspaces

### Devices

For new devices, see [Connect using the web command](devices.en.md#connect-using-the-web-command). For a version mismatch, see [Upgrade the agent](devices.en.md#upgrade-the-agent).

Deleting a device removes its record, binding and scheduled-task summaries from the server and immediately disconnects remote access. The agent, terminal sessions, scheduled tasks and files remain on the device, but the agent cannot reconnect without binding again. Deleting the record does not [uninstall the agent](devices.en.md#uninstall).

### Workspaces

A workspace is a registered project directory on a device. Select the project directory in "Add workspace" on an online device. After editing the path, press Enter or "Go to directory"; select the currently listed directory after it loads successfully. The registered path is the real directory after resolving symbolic links. Adding the same directory again returns the existing workspace.

Use Search beside Devices and workspaces to filter registered workspaces by name or path, including those without terminal sessions. Full paths are also available in the object menu and device details.

Removing a workspace deletes only the registration, keeping directories and files. A workspace cannot be removed while the device is offline or it still has terminal sessions. If removal is rejected because of terminal sessions, select "Open workspace terminals", end the sessions, then retry removal.

A workspace is not a sandbox. Terminal, file and Git operations use the project user's permissions and can access any path that user can access.

Terminal sessions keep running when you switch tools, workspaces or devices; unsaved changes and Git commit messages remain until the page closes. Signing out clears saved terminal layouts.

## Terminal

Terminal sessions run on the device. Closing the page, losing the network, signing out, restarting the server or deleting the device does not end them. A session ends when its shell or shortcut command exits, you end it, the agent shuts down normally, or the device restarts. For abnormal exit, see [Clean up leftover terminal sessions](reference.en.md#clean-up-leftover-terminal-sessions). The same session can be open in multiple browsers and local terminals at once. All clients can type directly; simultaneous input is interleaved.

Press Ctrl+Shift+F6 in terminal input to move to the toolbar, then use Tab to navigate the workbench; normal Tab and Escape remain terminal input. If the terminal remains unresponsive, close displays of the same session that you are not using, then try again.

### Online reports

When a program sends OSC 7501 status records or OSC 9 or OSC 777 notifications, a badge appears beside its workspace in the sidebar. Hover over or tap the badge to see sources, and select a source to open its terminal. Sessions can report without an open display.

Each terminal counts once, in the state its list row shows: error, waiting, done or running. A retained historical report counts as “done or notified” only when there is no such current state. Counts are terminals, rather than agents or completed tasks; missing current reports do not imply that a program is idle. A historical report does not mean the program is still waiting.

Opening the list or reading details does not clear reports. Entering the terminal (selecting a source or “Open terminal” in details, or switching or reselecting to that terminal) activates it, clearing that terminal's existing report across clients; reports arriving afterward remain. Activation clears reports only, not the program's current status: while the program still reports done, the badge still counts it as done. Staying in the terminal does not automatically clear new reports.

Pending reports live in server memory and synchronize when a page returns or reconnects. A server restart loses them. Ended sessions retain historical reports; deleting a device removes its reports. Failed or unconfirmed activation requests show an error; synchronized reports reflect the current state.

### Create sessions and shortcuts

New sessions start in the workspace directory and inherit the agent's environment (from service configuration when running as a service; see [Run in the background](devices.en.md#run-in-the-background)). Linux and macOS use the project user's login shell; Windows uses PowerShell. See [Shell](reference.en.md#shell) for defaults and configuration.

Ordinary Shell sessions without an explicit name use the first available name Shell, Shell 2, Shell 3, and so on in their workspace. Names can be reused after a session ends.

Shortcuts run one command in the login shell; the session ends when that command exits. Install the AI CLI programs used by the default shortcuts yourself.

"Close display" closes only the display; the session continues and can be reopened through "Select terminal session". On desktop, split and arrange sessions from the terminal area menu; the phone shows one terminal at a time.

### Copy and paste

- Desktop: drag to select text. If a program such as htop handles the mouse, hold Shift while dragging, or Option on macOS. Copy through the context menu, or Cmd-C on macOS. Paste with Ctrl-V, Ctrl-Shift-V, Cmd-V or the context menu. Ctrl-C is sent to the program.
- Phone: tap the terminal to operate program controls that support mouse clicks and open the keyboard. Long-press text or blank space to open the menu and paste; adjust the selection with the handles if needed before copying. Paste appears when the browser supports reading the clipboard.

Oversized pastes are not sent and show "Pasted text exceeds the input limit". The web terminal does not display images from programs.

When a program requests a copy through OSC 52, “Program copy” and the line count appear at the top right of the terminal. Click it to write to your local clipboard; dismissing the prompt discards the request.

On desktop, Ctrl-click a URL in terminal output to open it, or Cmd-click on macOS; plain clicks operate the terminal. On a phone, select a complete HTTP(S) URL and choose “Open link” from the selection menu.

The phone shows two rows of terminal keys: a short tap sends a key once, and holding an arrow repeats it. Tap SHIFT, CTRL or ALT once to apply it to the next key, and again to cancel. In the web app, Ctrl-b goes directly to the program; it is not a tmux prefix.

### Compose multiline input

On desktop, press Ctrl/⌘+Shift+Enter inside the terminal or choose Compose from its context menu. On a phone, tap the pen button at the bottom right of the terminal keys. In the editor, Enter only adds a new line. Insert pastes the text into the program without Enter; Send or Ctrl/⌘+Enter pastes it and then presses Enter.

Closing the editor keeps its draft; return to the original terminal to continue. Drafts live only in the current page; reloading, closing the page or signing out clears them, and they do not sync to another device. Failure or an unconfirmed result keeps the draft and error with the original terminal. Check the program's actual input before deciding to resend. Success means tmux handled the input, not that the program finished processing it.

Choose files with the paperclip button, or paste or drop files into the draft. Uploads start at the source workspace root; change the subdirectory and file name in the [upload dialog](#upload-and-download). After the device confirms a successful write, its absolute path on the device replaces the draft's selection or is inserted at its caret. Paths are inserted as plain text; quote them according to your shell's rules when using them in a shell command.

### Open files from terminal output

On desktop, Ctrl/Cmd-click a path to open it in Files in the source workspace. On a phone, select the full path with a long press, then choose Open file from the menu. Relative paths always start at the workspace root; they do not follow shell `cd`, SSH or container directories.

Supported forms are `/`-separated relative paths, POSIX absolute paths inside the workspace, and local `file://` URIs. `:line` and `:line:column` position only the line. Ordinary paths containing `..` are not recognized. Desktop detection accepts complete ASCII paths without spaces; an exact phone selection may include spaces and Unicode. Use `./README` for an extensionless name. Windows workspaces accept `/`-separated relative paths, without drive letters or backslashes.

### Search and display

Terminal search covers currently loaded display content, including history, without case sensitivity; choose Search terminal from the terminal area menu. Ended sessions still support history navigation.

"Scrollback lines for new sessions" in "Terminal settings" controls the history retained per session (range in [Limits](reference.en.md#limits)). It affects only sessions created afterward. Increasing it makes terminal loading, reconnection, and heavy output processing slower and can pause other web terminals on the same device. If you need less history, lower it and create a new session.

A session has one row/column size, determined by the client that most recently typed or resized its window. Other clients reflow to it. Opening the phone keyboard does not resize the session.

If the keyboard covers a program control, close the keyboard, or long-press text and drag a selection handle to bring that area into view.

### Connection and recovery

Input is available after the session's display and history are restored. If a problem occurs:

- "Connection closed": click "Reconnect". While waiting or after a failed attempt, the last screen remains read-only and can still be scrolled, selected and copied. It is replaced once the new display is fully restored. A display that falls behind output for too long also disconnects on its own; the session and other displays are unaffected.
- "The session no longer exists": the session ended while disconnected, for example because the agent or device restarted. The display keeps the last screen read-only and cannot reconnect; use "Close display" to close it.
- Recording unavailable: click "Recover terminal". It rebuilds recording for the same program without restarting it; previous web history is no longer retained.
- History restoration exceeds capacity or times out: click "Retry with less history" to restore only the current screen; history on the device is unchanged.
- Connected but the display is garbled: use "Redraw program" in the terminal area menu. It briefly resizes the program to trigger a redraw, which can change other clients' displays and selections, so it requires confirmation. If that does not help, use "Close display" and reopen it.

A history gap means some output during a recorder failure was not captured in web history. Ended sessions are read-only and show their exit code.

"End session" in the session menu asks once, then ends the session and every program in it.

### Continue in CLI

The session menu’s “Continue in CLI” provides a complete command for the current device, workspace and session. Run it in a local terminal logged in to this server. If the CLI is not set up, choose “Install and log in” to open the guide; “CLI setup” in the Settings menu also opens the guide directly. CLI and Web operate the same shell, and the session keeps running after detaching. See [Remote CLI](cli.en.md#attach-to-an-existing-terminal) for keys, installation and credentials. Device-side workspace and session management commands are in the [command reference](reference.en.md#kiteline-agent-commands).

## Files

The Files sidebar browses the current workspace, with paths relative to its directory. Work-page tabs show only filenames; view the full path and source in the tab's context menu. “Copy device absolute path” in Details copies the path text on the device; quote it according to your shell's rules when using it in a shell command.

### Browse

Handle names that are not valid UTF-8, FIFOs, sockets and device nodes in a terminal. Windows reparse points unsupported by the workbench remain listed as “Unsupported type” and cannot be operated on.

The list refreshes automatically when other programs change files, and periodically while the page is visible. During refresh, the current file adopts the disk version if it has no unsaved content; otherwise, the draft stays and indicates that the disk changed. Adopting different text clears the previous undo and redo history. If the device cannot watch directory changes, "Live updates limited" appears; periodic refresh remains available.

### Open and edit

PNG, JPEG, GIF and WebP images are detected by content and previewed; images exceeding preview byte or pixel limits can only be downloaded. Other files open as UTF-8 text. Files containing NUL bytes, invalid UTF-8 or content exceeding editing limits (see [Limits](reference.en.md#limits)) can be downloaded but not edited.

In the editor, Tab indents; press Escape, then immediately press Tab or Shift+Tab to leave. Ctrl+M (Shift+Alt+M on macOS) toggles Tab focus mode.

The file editor and Git diffs highlight syntax by filename. Diffs contain partial context, so multiline comments or strings can be colored incorrectly; use the source text to interpret them.

Choose “Find / replace” from “More file actions” to search the current draft, including unsaved edits. Replacements change the draft; Save writes them to disk. File font size is also set in this menu (10–24px), independent of the terminal font size.

In the file source toolbar, “Copy code line reference” copies the whole lines touched by the selection (or the cursor line when nothing is selected), with the device, workspace, relative path and line numbers. It includes unsaved edits; paste it manually into the target terminal.

The editor preserves the original BOM, line endings and final newline. For mixed line endings, it indicates whether saves will use LF or CRLF. An edit that would exceed the editing limit is rejected in full.

New `.ps1` files on Windows devices use a UTF-8 BOM on their first save so Windows PowerShell 5.1 reads non-ASCII text correctly. Existing files and their saved copies keep their original format. UTF-16 files produced by default redirection in 5.1 can only be downloaded; use `Out-File -Encoding UTF8` when you need to edit the output in the workbench.

Saving replaces the original with a new file, so its parent directory must allow file creation and renaming. Ordinary permission bits are preserved; ownership, group, ACLs and extended attributes follow the rules for new files. Other hard links still point to the old content. Saving through a symbolic link writes to its target.

### Markdown preview

Switch `.md` and `.markdown` files between source and preview. The preview includes unsaved edits and renders `mermaid` code blocks as diagrams. Relative file links open their targets in Files. Raw HTML appears as text; external images in ordinary Markdown appear as links, while external images within diagrams load automatically.

### HTML preview

`.html` and `.htm` files open as source. Preview HTML runs the current draft, including unsaved edits. It supports inline JavaScript, styles, SVG/data images and external CDN resources allowed by the browser. Relative resources do not read neighboring workspace files. For a project server or multiple local resources, use [Access development services](#access-development-services).

The preview is isolated from the workbench, but document and CDN scripts can read and send the entire preview content. Modules, fetch and fonts remain subject to browser CORS rules; localStorage/sessionStorage are unavailable. Links, scripts and meta refresh can navigate within the frame, and browser Back may traverse frame history first. Form submission, new windows and top-level navigation are not enabled.

Switching to source, another draft or workspace, or hiding the content ends the current preview. Showing the preview again runs it anew, resetting form values and chart selections while preserving the source draft and undo history. Save writes the draft, while Download reads the file on disk; interactions inside the preview do not change the source.

### Drafts

Drafts are kept only in the current page's memory:

- They survive switching files, tools, workspaces and devices. "Open files" lets you find open drafts across all devices.
- Closing a file tab with unsaved content offers Cancel, Discard changes, or Save and close.
- With unsaved changes, the browser prompts before reloading, navigating away, or closing the page. Confirming that you want to leave loses the drafts. On mobile, the prompt may be skipped when you close the app or the system discards the page.
- While a device is offline, you can still edit, undo and copy. Save after it comes back online.
- After a device or workspace is deleted, you can still edit, undo and copy, but cannot save, save as or download. Use “Copy text” to create a file in another workspace.
- If a workspace shows a render error, use "Back to devices" to continue navigating. If the entire workbench shows an error page, drafts held in memory cannot be recovered.

### Save conflicts

Save submits a named file directly. Only when that save encounters a disk version conflict does it read the current disk content and offer to overwrite that version, view the disk content, or cancel. Cancel keeps the draft. When viewing the disk content, you can also load the disk version and discard the draft.

Overwrite applies only to the version read in the dialog. If that version changes again, the overwrite is rejected; check again before deciding. Overwrite is unavailable if the read fails. If the conflict dialog shows that the original file no longer exists, choose “Save as” and enter a new path.

If a save result is unconfirmed, for example after losing connection during saving, use "Check disk content" to read the original target. An exact byte match with the last submitted content confirms the save and keeps any input made after submission. Otherwise, the draft remains unsaved, and the workbench does not resend automatically. Background refresh does not confirm that save.

### Search

File search searches the workspace's files on disk by content or file name, with these rules:

- Matches literal text, case-sensitively. Whole word is off by default for content searches; enable it to match complete words only.
- "File name" finds files whose relative paths, including directories, contain the query. Results contain files only.
- Includes hidden files, excludes `.git`, and does not follow any symbolic links, whether to files or directories.
- `.gitignore` applies only inside Git repositories; `.ignore` and `.rgignore` always apply. Check "Include ignored files" to include files excluded by these rules.
- Results and search duration are limited (see [Limits](reference.en.md#limits)). Reaching a limit shows "incomplete results". Results with non-UTF-8 paths are omitted and also mark the results incomplete.

The current page keeps search conditions and successful results for each workspace; refreshing the page or signing out clears them. Opening a content result maps an unchanged disk match to its position in the current draft. If that position cannot be confirmed, the editor opens Find.

### Look up by name

In a file's source, place the cursor on a word or select text on one line, then choose “Find ‘name’ by name” from “More file actions.” On desktop, you can also press F12 or Ctrl+click (Cmd+click on macOS); Shift+F12 starts at “Other occurrences.” The list has two groups, “Possible definitions” and “Other occurrences”; select an item to preview it, and “Open file” opens the editable document. Afterward, continue the existing list through “Name navigation” in the file search panel.

Results match case-sensitive name text as complete words, without resolving which symbol each name belongs to. Namesakes, imports, comments and documentation can appear, so check the path and context.

### Create and rename

"New file" opens an unnamed draft. Enter its path on first save, starting in the directory shown in the file toolbar when you created the draft. "New directory" in a folder's context menu creates inside that folder. The device and Git cannot see the file until it is saved. First saves, directory creation, and renaming fail if the name exists; nothing is overwritten. On file systems that do not support renaming without overwriting (some NFS and 9p mounts), first saves, renames, and uploads, copies and moves that do not replace an existing item can fail; do them in a terminal instead. Open tabs follow renamed or moved paths. The workspace root and files currently being saved cannot be renamed, moved or deleted. Path inputs preserve line breaks in pasted text.

### Upload and download

Choose files from the toolbar or a folder's context menu, or drop them onto Files to upload; the confirmation dialog shows the device, workspace and starting directory, and lets you change destination paths. A drop containing any directory is rejected in full. To upload to another workspace, start a new upload from that workspace. When leaving or refreshing during an upload, choose to stay in the browser's confirmation to continue; after leaving, select the files again.

Downloads use the browser's download manager; directories cannot be downloaded. Batch downloads start one at a time: keep the page open until all have started, and allow multiple downloads in the browser. If blocked, enable them in the browser's site settings. Error notices include the device, workspace and path, so you can retry individual files from their menus. See [Limits](reference.en.md#limits) for size limits.

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

## Git

Git uses the device's Git installation and the project user's Git configuration, including hooks, signing and credentials. For installation requirements, see [Supported systems and prerequisites](devices.en.md#supported-systems-and-prerequisites).

### Discover and switch repositories

Git scans the workspace directory and all subdirectories, listing repositories including initialized submodules and linked worktrees within the workspace (marked `worktree`). Repositories outside the workspace are not used. If the workspace is only a subdirectory of a repository, it shows "No Git repositories found"; add the repository root as a workspace.

With several repositories, switch by path in the repository menu. If "Repository scan incomplete" appears, click "Continue scan"; resolve read errors or continue an incomplete scan before deciding that a repository is missing. Bare repositories are not supported.

### Status and diff

The Git sidebar manages changes, history, branches and repository operations; work pages show individual diffs, and you can keep multiple files or comparison sources open to compare them. Diffs start in Unified view; on wide screens you can switch to Split.

Diffs exceeding the limit show only part of the raw patch. When the change list has previous or next pages, the Staged changes count covers the whole repository; other group counts cover the current page. An empty group on one page does not mean the whole repository is clean. Entries with non-UTF-8 paths cannot be operated on.

A dot on a change row marks a related unsaved draft. Worktree comparisons read the device disk and index; staged comparisons read the index and HEAD. When a related unsaved draft exists, the diff explains this source and does not read the browser draft. A draft with an unconfirmed save may already be on disk; check it in Files.

In a regular text file's worktree diff, click the new-side line number of an added or context line to open and locate it in the file; deleted lines, staged comparisons, historical versions and raw patches have no line-number navigation. If the target has an unsaved draft, the action only opens it and preserves its reading position because diff line numbers come from disk.

### Stage and commit

- Staging reads disk files without saving browser drafts. If selected files have unsaved drafts, it first asks whether to stage the disk versions. Save first to include browser input; check any unconfirmed save result first.
- An action that would also change unselected paths does not proceed. Those paths and the required preceding actions are listed.
- Unstaging a rename affects both old and new paths. "Unstage the new path only" affects only the new path.

When staging, unstaging or discarding fails, partially completes or has an unconfirmed result, refresh to check the actual state.

The commit includes everything staged, regardless of the current page or selected rows. The dialog shows the repository, branch or detached HEAD, and the repository-wide staged file count.

### Discard changes

"Discard unstaged changes" restores the index version; "Discard all changes" restores the HEAD version. The confirmation lists deletions first, then restorations, with counts and the restore source. Review the actual lists; deleted files are not moved to the trash. If a file changes after review, the operation does not proceed and must be reviewed again.

### Branches and history

"Branches" lists local branches. "Create branch" in the branch navigation starts from the current HEAD; the action in history details starts from that commit. Branches checked out in other worktrees cannot be switched to or deleted. Switching does not force-overwrite local changes. Deletion runs `git branch -d`, which rejects unmerged branches; Git rejection shows [Result unconfirmed](#result-unconfirmed).

History file line counts and diffs compare against the same parent commit. For merge commits, you can choose the parent. Binary files do not show line counts.

### Synchronization and authentication

Pull runs `git pull`, using the default commit message for merges. Pull configured for interactive rebase fails. Push runs `git push`; force push is not available.

Authentication cannot be interactive: Git does not prompt for a username or password. SSH keys, ssh-agent or credential helpers must work without input in the agent's environment. If a credential helper waits for input, the operation hangs until the Git write time limit (10 minutes by default; see [Limits](reference.en.md#limits)) and is then canceled. When configuration is needed, open the workspace terminal from "Terminal" in the feedback or "Continue in Terminal" in the operation bar. The Shell keeps its directory and any text already entered. Change to the target repository manually as needed and run the same Git command to finish configuration, such as saving credentials in a helper, then return and retry. For service agents, see [Run in the background](devices.en.md#run-in-the-background).

### Conflicts and continuation

During merge, rebase, cherry-pick, revert or am, including operations begun in a terminal, the top shows the operation and reason, with "Continue", "Abort" and "Continue in Terminal":

1. Resolve and save conflicts in Files or a terminal.
2. Click the checkmark, "Stage as resolved", on the conflict row in Git to stage its disk content. This does not validate the resolution or check for remaining conflict markers.
3. Once no conflicts remain, click "Continue" to use the default commit message.

After confirmation, "Abort" asks Git to restore the pre-operation state; uncommitted content may be affected. The web app can continue only rebases consisting of ordinary pick steps. Finish rebases with edit, reword, squash, fixup, exec or other steps, and unrecognized operations, in a terminal, then refresh the web app.

### Result unconfirmed

Each repository executes one Git write at a time, queuing the rest. The workbench cannot determine the repository state in these cases and shows "Result unconfirmed"; refresh and check before deciding to retry:

- A Git command exits unsuccessfully, such as a rejected push, a commit rejected by a hook, or an existing `index.lock`.
- Contact is lost during execution.
- The operation is cancelled.
- The write deadline is exceeded (see [Limits](reference.en.md#limits)).

Feedback shows Git output and error diagnostics. A successful Fetch can still be followed by a separate status read failure. Use "Refresh Git" to check branches, commits and changes. Retry manually only after confirming that the operation did not take effect. The workbench does not retry automatically.

A partially completed multi-step operation retains its known progress and diagnostics. Use a terminal for stash, line staging and similar operations.

## Access development services

The workbench opens HTTP services listening on local device ports, including WebSocket (and hot reload) and SSE. Links require workbench sign-in and are not public shares. Closing a page does not stop the service. Signing out, login expiry or deleting the device disconnects open connections.

### Open a port

Right-click the device name in the left navigation, or use its More menu on a touch interface, choose "Open port", then enter a port. Candidates are a snapshot and may include non-HTTP services; unlisted ports can be entered manually.

The service must listen on `127.0.0.1`, `::1`, `0.0.0.0` or `::` on the agent's machine or container. See [Run in a container](devices-advanced.en.md#run-in-a-container).

In terminal output, `http:` links whose hosts are `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0` or `[::]` are converted to that device's port address. Ctrl-click on desktop, or Cmd-click on macOS; on phones, long-press to select the full link and tap "Open device port". Other links open their original addresses.

### Two path modes

| Mode           | Address                      | Path received by the service |
| -------------- | ---------------------------- | ---------------------------- |
| "Strip prefix" | `/proxy/DEVICE_ID/PORT/…`    | Prefix removed               |
| "Keep prefix"  | `/absproxy/DEVICE_ID/PORT/…` | Full prefix retained         |

"Strip prefix" suits pages using only relative URLs. If a page references resources with paths starting with `/`, requests go to the workbench root, causing blank pages or MIME-type errors. Use "Keep prefix" for these projects and set the project's base to the `/absproxy/DEVICE_ID/PORT/` shown in the dialog. Also check that application-generated resource and WebSocket URLs use this prefix.

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
- The page is still open, but API requests or hot reload return 401: the login has expired. In-page requests do not redirect to sign-in; reload the page to sign in.
- 502: check the target port and actual error shown, whether an HTTP service listens on that port at a reachable address, and the agent container's network.
- 503: device offline; check that device's agent connection. 426: agent/server version mismatch; see [Upgrade the agent](devices.en.md#upgrade-the-agent). 404: device ID does not exist.
- 504 or 429: connection timeout or device connection capacity reached. Retry later.
- Blank page or MIME-type error: use "Keep prefix" and configure the base.

Workbench-generated error pages are in English and show the target device name, port and actual error. Errors returned by the development service appear unchanged.

### Security

Development pages share the workbench's origin (scheme, domain and port). Their scripts can call workbench APIs with your access, including running commands and modifying files on any device. Pages for all projects and ports share `Path=/` cookies, localStorage and Service Workers and can overwrite each other's data. A page's `Clear-Site-Data` response can clear your workbench login. Open only projects you trust, and do not access unfamiliar services this way. See [Security boundary (Chinese)](../design/http-access.md#安全边界).
