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
targets fail. `inspect` and `terminal list` ignore a default session and reject an
explicit `--session`. `auth`, `targets`, `--help`, and `--version` ignore the target file.

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
