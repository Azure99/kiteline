# Remote CLI

`kiteline` connects to the server with a device credential issued in Web. Use
`kiteline-agent` for local device operation and maintenance, and `kiteline-server`
for server administration. After building from source, substitute
`node cli/dist/main.js` for `kiteline` below.

## Connect

In Web, open “Owner menu → CLI credentials”, select devices, and issue a token:

```sh
kiteline auth login --server https://desk.example
# Non-interactive input must be explicit:
kiteline auth login --server https://desk.example --token-stdin < credential.txt
kiteline auth status
```

The first command prompts to paste a token only on a TTY; without one it fails
immediately. Import verifies the credential before saving it to
`~/.kiteline/credentials.json`, separately from the device agent identity.
`KITELINE_CLI_HOME` selects a dedicated credential directory. New Unix directories
use 0700 and files use 0600; Windows inherits access from the user's directory.
Keep the credential file outside shared working directories and repositories.

For unattended use, set both `KITELINE_URL` and `KITELINE_TOKEN`. They override saved
credentials; setting only one fails instead of combining it with the file.
The CLI uses `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and Node's
`NODE_EXTRA_CA_CERTS`. Supply the exact server origin; redirects are not followed.

`auth logout` revokes the active token and removes its saved credential file.
Logging out an environment token leaves unrelated saved credentials intact;
remove the environment variables in the caller. An already invalid token can also
be removed locally. An unknown network result retains the file. Web owners can
revoke individual credentials. See [device operation credentials](server.en.md#issue-a-cli-credential)
for permission and expiry details.

## Discover and select targets

```sh
kiteline targets
kiteline inspect --device DEVICE_ID --workspace WORKSPACE_ID
kiteline terminal list --device DEVICE_ID --workspace WORKSPACE_ID
```

`targets` shows full IDs, names, online status, and workspace paths from device
metadata snapshots. An offline path is not a current filesystem check. `inspect`
adds the actual terminal list for the workspace; that list requires an online
device. Distinguish identical names by full IDs; the CLI does not guess by name.

Put `.kiteline.json` in the calling process's working directory to reuse targets:

```json
{ "device": "DEVICE_ID", "workspace": "WORKSPACE_ID", "session": "SESSION_ID" }
```

Only that directory is read, without searching parents, a Git root, or home. These
are shared directory defaults. Explicit `--device`, `--workspace`, and `--session`
override individual fields for this call without changing the file. Mismatched
targets fail. `inspect`, `terminal list`, and `terminal create` ignore a default session and reject an
explicit `--session`. `auth`, `targets`, `--help`, and `--version` ignore the target file.

## Work in the same terminal

```sh
kiteline terminal create --name work
# Put the returned session ID in cwd .kiteline.json, then:
kiteline terminal snapshot
kiteline terminal send --text 'pwd; git status --short' --enter
kiteline terminal wait
kiteline terminal snapshot --tail 40
kiteline web url
```

Each call is a short command; the terminal and shell state persist. Calls preserve
the current size unless you use `terminal resize --cols 100 --rows 30`, which
changes the shared terminal for everyone. Browse, read, edit, run Git, build and
test with native terminal tools. The CLI has no dedicated Git or task/run commands.

`send` selects exactly one of `--text TEXT`, `--paste TEXT`, or `--key KEY`. Text
and paste may append `--enter`; the literal word `Enter` is never a key. See
`terminal send --help` for named keys. Paste uses existing bracketed paste behavior
when the program enables it. Success confirms only remote input handling, not
command completion. Observe the screen to choose the next operation. There is no
automatic resend, input exclusivity, or completion detector.

`snapshot` returns the active screen. Text stdout contains terminal text, with any
requested normal-history tail before the screen. Stderr describes line counts,
wrapping, size, cursor and positions; no markers are inserted in the text. Trailing
empty rows may be folded; internal blank rows, indentation and physical lines stay
intact. `--attrs` adds non-default style intervals to stderr, useful for a TUI whose
selection is shown only by highlighting. Use `--json` to distinguish history from
screen explicitly or process the result. Attribute intervals use 0-based cell
columns with an exclusive end, not string character indices.

```sh
kiteline terminal snapshot --attrs --json > observation.json
kiteline terminal snapshot --attrs --if-changed "$(jq -c .result.position observation.json)"
kiteline terminal send --key Down --if-input "$(jq -r '.result.input | "\(.epoch):\(.inputSeq)"' observation.json)"
```

Reuse the complete `--if-changed` position only for the same target and observation
options. Changing tail/attrs returns full data. `unchanged` omits the screen but
still supplies current inputSeq. Advancing seq need not change visible text. A new
recorder epoch returns a full `reset` screen. Optional `--if-input` checks admission:
if another input was accepted since observation, it returns conflict. Observe again
before choosing a new send. Web input counts; direct local tmux input does not.
A new inputSeq with an old screen can mean input has not echoed yet, so a successful
condition does not prevent mixed input.

`wait` defaults to 300ms of output quiet within 1000ms total. Adjust `--quiet-ms`
and `--timeout-ms` up to 10000ms. `--mode change --after EPOCH:SEQ` waits for an
output-position change, using snapshot.position or send.before. All reasons—quiet,
changed, timeout and reset—include a current screen. Quiet does not mean business
completion. send/resize default to 5000ms and accept `--timeout-ms` from 1–10000ms.

For optional Bash logging, first enter the workspace path shown by `targets`, so
file operations can access the log:

```bash
cd '/absolute/workspace/path'
(set +e
  mkdir -p logs || exit
  make test 2>&1 | tee logs/test.log
  rc=${PIPESTATUS[0]}
  printf '\nFOREGROUND_RETURNED rc=%s\n' "$rc"
  exit "$rc"
)
```

Read `PIPESTATUS[0]` immediately after the pipeline. The marker means only that
this foreground command returned, not that background work it launched completed.
The CLI does not wrap input or interpret this marker automatically.

## Continue in Web and recover recording

`web url` returns the same terminal's link without a handoff workflow. Log into Web
and click the actual terminal display before typing; “Focus terminal” only changes
layout. Both sides share input and size. Closing the CLI leaves the shell running.

For `recording_unavailable`, check `terminal list`, then explicitly use
`terminal recover` as needed. Recovery reuses the pane, may resize it briefly for a
redraw, loses the old recorder history and changes epoch. A `recovering` reply is
acceptance, not readiness; use later list/snapshot calls to observe. The CLI does
not poll or replay earlier input. A mismatched target returning not_found does not
prove the shell is gone. Observations over 1MiB return limit_exceeded while the
terminal keeps running. Explicitly request less tail/attrs or a smaller size as
appropriate; the CLI does not crop automatically.

## Output and failures

Default output is readable text. With `--json`, stdout contains a structured reply
with `outcome`, `result`, or `error.code`. Prompts and diagnostics use stderr. The
CLI has no background process, automatic retries, or implicit interaction.

| Exit | Meaning                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 0    | The operation or observation succeeded.                                                                |
| 1    | A remote failure or partial failure; partial results and diagnostics remain available.                 |
| 2    | A local argument, configuration, target, or file I/O error.                                            |
| 3    | The request may have taken effect, but its result is unknown. Observe before deciding what to do next. |

HTTP requests, including response body consumption, have a 30-second deadline.
`--help` and `--version` work offline.
