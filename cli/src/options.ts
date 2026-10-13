import { parseArgs } from "node:util";
import { posix } from "node:path";
import {
  AppError,
  integer,
  limits,
  record,
  string,
  terminalKeys,
  type InputPosition,
  type ScreenPosition,
  type TerminalPosition,
} from "@kiteline/shared/protocol";

const options = {
  help: { type: "boolean" },
  version: { type: "boolean" },
  json: { type: "boolean" },
  server: { type: "string" },
  "token-stdin": { type: "boolean" },
  device: { type: "string" },
  workspace: { type: "string" },
  session: { type: "string" },
  path: { type: "string" },
  file: { type: "string" },
  output: { type: "string" },
  "replace-version": { type: "string" },
  name: { type: "string" },
  tail: { type: "string" },
  attrs: { type: "boolean" },
  "if-changed": { type: "string" },
  text: { type: "string" },
  paste: { type: "string" },
  enter: { type: "boolean" },
  key: { type: "string" },
  "if-input": { type: "string" },
  "timeout-ms": { type: "string" },
  mode: { type: "string" },
  after: { type: "string" },
  "quiet-ms": { type: "string" },
  cols: { type: "string" },
  rows: { type: "string" },
} as const;
type Option = keyof typeof options;

const workspace = ["device", "workspace"] as const;
const session = [...workspace, "session"] as const;
const screen = ["tail", "attrs"] as const;
const commands: Record<string, readonly Option[]> = {
  "auth login": ["server", "token-stdin"],
  "auth status": [],
  "auth logout": [],
  targets: [],
  inspect: workspace,
  "terminal list": workspace,
  "terminal create": [...workspace, "name"],
  "terminal snapshot": [...session, ...screen, "if-changed"],
  "terminal send": [...session, "text", "paste", "enter", "key", "if-input", "timeout-ms"],
  "terminal wait": [...session, ...screen, "mode", "after", "quiet-ms", "timeout-ms"],
  "terminal resize": [...session, "cols", "rows", "timeout-ms"],
  "terminal recover": session,
  "files download": [...workspace, "output"],
  "files upload": [...workspace, "file", "replace-version"],
  "web url": [...session, "path"],
};

function filePath(value: string | undefined) {
  if (value === undefined) return undefined;
  const path = string(value, "PATH");
  if (posix.isAbsolute(path) || path.split("/").includes(".."))
    throw new AppError(
      "invalid_argument",
      "PATH must be relative to the workspace without .. segments",
    );
  return posix.normalize(path).replace(/\/$/, "") || ".";
}

function keyOption(value: string | undefined) {
  if (value === undefined) return undefined;
  const key = terminalKeys.find((key) => key === value);
  if (!key)
    throw new AppError("invalid_argument", `--key must be one of: ${terminalKeys.join(", ")}`);
  return key;
}

function numberOption(value: string | undefined, name: string, min: number, max: number) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value))
    throw new AppError("invalid_argument", `--${name} must be an integer from ${min} to ${max}`);
  return integer(Number(value), `--${name}: expected ${min}..${max}`, min, max);
}

function terminalPosition(value: string): TerminalPosition {
  const match = /^([^:]+):(\d+)$/.exec(value);
  if (!match) throw new AppError("invalid_argument", "Expected a position in EPOCH:SEQ format");
  return {
    epoch: match[1]!,
    seq: integer(Number(match[2]), "position sequence", 0, Number.MAX_SAFE_INTEGER),
  };
}

function inputPosition(value: string): InputPosition {
  const { epoch, seq } = terminalPosition(value);
  return { epoch, inputSeq: seq };
}

function screenPosition(value: string): ScreenPosition {
  let position: Record<string, unknown>;
  try {
    position = record(JSON.parse(value));
  } catch {
    throw new AppError("invalid_argument", "--if-changed requires a position JSON object");
  }
  if (typeof position.attrs !== "boolean")
    throw new AppError("invalid_argument", "--if-changed position.attrs must be a boolean");
  return {
    epoch: string(position.epoch, "--if-changed position.epoch"),
    seq: integer(position.seq, "--if-changed position.seq", 0, Number.MAX_SAFE_INTEGER),
    tail:
      position.tail === null
        ? null
        : integer(position.tail, "--if-changed position.tail", 0, limits.terminalHistoryLines),
    attrs: position.attrs,
  };
}

export function parse(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, tokens: true });
  } catch (error) {
    throw new AppError("invalid_argument", (error as Error).message);
  }
  const { values: raw, positionals, tokens } = parsed;
  const fileCommand =
    positionals[0] === "files" && ["download", "upload"].includes(positionals[1] ?? "");
  const command = (fileCommand ? positionals.slice(0, 2) : positionals).join(" ");
  const showHelp = !!raw.help || argv.length === 0;
  if (!showHelp && !(raw.version && !positionals.length)) {
    const allowed = commands[command];
    if (!allowed)
      throw new AppError(
        "invalid_argument",
        `Unknown command: ${command || "(none)"}. Use --help.`,
      );
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name))
        throw new AppError("invalid_argument", `--${token.name} may only be specified once`);
      seen.add(token.name);
      if (token.name !== "json" && !allowed.includes(token.name))
        throw new AppError("invalid_argument", `--${token.name} is not valid for ${command}`);
    }
    if (fileCommand) {
      if (positionals.length !== 3)
        throw new AppError("invalid_argument", `${command} requires exactly one PATH`);
      const local = command === "files download" ? "output" : "file";
      if (raw[local] === undefined)
        throw new AppError("invalid_argument", `${command} requires --${local} LOCAL`);
    }
    if (command === "web url" && raw.path !== undefined && raw.session !== undefined)
      throw new AppError("invalid_argument", "--path cannot be combined with --session");
    if (command === "terminal send") {
      if ([raw.text, raw.paste, raw.key].filter((v) => v !== undefined).length !== 1)
        throw new AppError(
          "invalid_argument",
          "send requires exactly one of --text, --paste, or --key",
        );
      if (raw.key !== undefined && raw.enter)
        throw new AppError("invalid_argument", "--enter cannot be combined with --key");
    }
    if (command === "terminal wait") {
      if (raw.mode !== undefined && raw.mode !== "quiet" && raw.mode !== "change")
        throw new AppError("invalid_argument", "--mode must be quiet or change");
      if (raw.mode === "change") {
        if (raw.after === undefined)
          throw new AppError("invalid_argument", "--mode change requires --after EPOCH:SEQ");
        if (raw["quiet-ms"] !== undefined)
          throw new AppError(
            "invalid_argument",
            "--quiet-ms cannot be combined with --mode change",
          );
      } else if (raw.after !== undefined)
        throw new AppError("invalid_argument", "--after requires --mode change");
    }
    if (command === "terminal resize" && (raw.cols === undefined || raw.rows === undefined))
      throw new AppError("invalid_argument", "resize requires --cols and --rows");
  }
  const values = {
    ...raw,
    path: filePath(fileCommand ? positionals[2] : raw.path),
    file: raw.file === undefined ? undefined : string(raw.file, "--file"),
    output: raw.output === undefined ? undefined : string(raw.output, "--output"),
    "replace-version":
      raw["replace-version"] === undefined
        ? undefined
        : string(raw["replace-version"], "--replace-version"),
    key: keyOption(raw.key),
    tail: numberOption(raw.tail, "tail", 0, limits.terminalHistoryLines),
    cols: numberOption(raw.cols, "cols", 1, limits.terminalMaxCols),
    rows: numberOption(raw.rows, "rows", 1, limits.terminalMaxRows),
    "quiet-ms": numberOption(raw["quiet-ms"], "quiet-ms", 1, 10000),
    "timeout-ms": numberOption(raw["timeout-ms"], "timeout-ms", 1, 10000),
    "if-changed": raw["if-changed"] === undefined ? undefined : screenPosition(raw["if-changed"]),
    "if-input": raw["if-input"] === undefined ? undefined : inputPosition(raw["if-input"]),
    after: raw.after === undefined ? undefined : terminalPosition(raw.after),
  };
  return { command, values, help: showHelp };
}

export type Options = ReturnType<typeof parse>["values"];

const targetHelp = `Use --device D --workspace W --session S, or defaults in cwd .kiteline.json.
Full IDs come from targets and terminal list. Explicit options override this call.
`;
const observationHelp = `Text stdout contains only physical terminal lines, tail first. Metadata, positions,
wrapped 0-based line indices and requested named attrs go to stderr. --json keeps
all lines and metadata in one structured stdout result. Attributes use cell columns.
--tail N includes up to N normal-history lines; --attrs includes non-default styles.
recording_unavailable requires explicit terminal recover, then list/snapshot.
`;
const fileTargetHelp = `Use --device D --workspace W, or defaults in cwd .kiteline.json.
Ignores a cwd default session; rejects explicit --session.
PATH is workspace-relative, uses / separators and cannot contain .. segments.
`;
const commandHelp: Record<string, string> = {
  "auth login": `auth login --server ORIGIN [--token-stdin]\nImport a token issued in Web: Owner menu → CLI credentials. Prompt requires a TTY;\n--token-stdin explicitly reads a piped token. KITELINE_URL/KITELINE_TOKEN override saved credentials.\n`,
  "auth status": `auth status\nShow current credential access, source and expiry.\n`,
  "auth logout": `auth logout\nRevoke the active credential. Environment credentials must also be removed from\nthe calling environment; saved credentials are removed after revocation.\n`,
  targets: `targets\nList authorized devices and workspace metadata snapshots, including offline devices.\n`,
  inspect: `inspect --device D --workspace W\nShow a workspace from the device metadata snapshot and its terminals.\nIgnores a cwd default session; rejects explicit --session.\n`,
  "terminal list": `terminal list --device D --workspace W\nList terminals with actual state and recorder webStatus.\nIgnores a cwd default session; rejects explicit --session.\n`,
  "terminal create": `terminal create --device D --workspace W [--name NAME]\nCreate a persistent terminal in the workspace, shared with Web.\nIgnores a cwd default session; rejects explicit --session.\n`,
  "terminal snapshot": `terminal snapshot [--tail N] [--attrs] [--if-changed JSON]\n${targetHelp}${observationHelp}Copy the entire position JSON into --if-changed, using the same target and options.\nunchanged has empty stdout but current input metadata; a new epoch returns reset\nwith a full screen. Changing tail/attrs returns full data. There is no position cache.\n`,
  "terminal send": `terminal send (--text TEXT | --paste TEXT) [--enter] [--if-input EPOCH:INPUTSEQ] [--timeout-ms N]\nterminal send --key KEY [--if-input EPOCH:INPUTSEQ] [--timeout-ms N]\n${targetHelp}Keys: ${terminalKeys.join(", ")}. --key cannot use --enter.\n--text sends literal text; the word Enter is not a key. --paste uses terminal paste\nmode. --enter appends Enter after the text or paste. No stdin is read.\n--if-input compares input accepted by this recorder, including Web input; conflict\nmeans no input accepted. Reobserve before choosing a new condition. Acceptance\ndoes not mean echo, exclusivity or command completion. Local tmux input is uncounted.\nTimeout: 1..10000ms, default 5000ms. unknown may have sent input; observe before\ndeciding to repeat. No automatic resend or waiting. before is EPOCH:SEQ for wait,\nnot a conditional snapshot position. recording_unavailable requires explicit recover.\n`,
  "terminal wait": `terminal wait [--mode quiet] [--quiet-ms N] [--timeout-ms N] [--tail N] [--attrs]\nterminal wait --mode change --after EPOCH:SEQ [--timeout-ms N] [--tail N] [--attrs]\n${targetHelp}${observationHelp}quiet defaults to 300ms within a total 1000ms; values are 1..10000ms and timeout\nmay be shorter than quiet. Output/resize activity resets quiet, even for identical\ntext. change requires --after from snapshot.position or send.before; it rejects\n--quiet-ms. quiet rejects --after. quiet/changed/timeout/reset return full screens.\nA quiet terminal does not confirm program or command completion.\n`,
  "terminal resize": `terminal resize --cols N --rows N [--timeout-ms N]\n${targetHelp}Explicitly resize the same shared terminal; other CLI commands do not resize it.\ncols: 1..${limits.terminalMaxCols}; rows: 1..${limits.terminalMaxRows}. Timeout: 1..10000ms, default 5000ms.\nunknown requires observing the terminal before deciding to repeat.\n`,
  "terminal recover": `terminal recover\n${targetHelp}Request recorder recovery and show actual Session/webStatus. Acceptance does not\nconfirm availability; use terminal list/snapshot afterward. Recovery can reset\nepoch and report a history gap. Input is not resent; there is no automatic polling.\n`,
  "files download": `files download PATH --output LOCAL\n${fileTargetHelp}Stream the remote file into a new local file; an existing LOCAL is never overwritten.\nFailure may leave an empty or partial LOCAL. Download follows a leaf symlink.\nSuccess returns path, output and size; file bytes are not JSON output.\n`,
  "files upload": `files upload PATH --file LOCAL [--replace-version VERSION]\n${fileTargetHelp}Stream a local regular file. By default, create only; an existing target conflicts.\nTo choose replacement after conflict, copy error.details.current.targetVersion\nfrom the error into --replace-version. VERSION is not a download revision.\nReplacement checks the current target; a leaf symlink is replaced, not followed.\nAn unknown result may have published the file: observe through the terminal or\ndownload before deciding to repeat. Success returns path and size.\n`,
  "web url": `web url [--path PATH]\n${targetHelp}Without --path, validate this workspace/session and print its Web terminal URL.\nOpen it to use the same terminal. Focus terminal changes layout; click the actual\nterminal display to focus input. With --path, validate the workspace and print\nits Web file URL, without checking file existence or version. PATH is workspace-\nrelative with / separators and no .. segments. --path ignores a default session\nand cannot use explicit --session. This command does not open a browser or change focus.\n`,
};

export function help(command = "") {
  if (commandHelp[command])
    return (
      commandHelp[command] +
      "\nUse --json for structured outcome/error.code results. Help works offline.\n"
    );
  return `Kiteline — remote access to shared workspaces

Commands:
  auth login --server ORIGIN [--token-stdin]  Import a Web-issued CLI token
  auth status | auth logout                 Inspect or revoke current access
  targets                                   List authorized devices and workspaces
  inspect --device D --workspace W           Show workspace and terminals
  terminal create [--name NAME]              Create a persistent shared terminal
  terminal list                             List terminals and recorder status
  terminal snapshot [--tail N] [--attrs]     Observe screen and current positions
  terminal send --text TEXT [--enter]        Send input; also --paste or --key
  terminal wait [--mode quiet|change]        Wait for terminal activity conditions
  terminal resize --cols N --rows N          Resize the shared terminal
  terminal recover                          Explicitly request recorder recovery
  files download PATH --output LOCAL        Download into a new local file
  files upload PATH --file LOCAL            Create a remote file; see --help for replacement
  web url [--path PATH]                     Print a terminal or file Web URL

Use COMMAND --help for parameters and behavior. All commands accept --json.
Help and --version work offline. Owner menu → CLI credentials in Web issues tokens.
KITELINE_URL and KITELINE_TOKEN must be supplied together and override saved
credentials. Saved credentials: ~/.kiteline/credentials.json; KITELINE_CLI_HOME
changes that directory. Logout revokes the active token, including an env token.

Only .kiteline.json in the process working directory supplies default targets:
  {"device":"D","workspace":"W","session":"S"}
Explicit --device/--workspace/--session override this call without updating the
file. Parent directories are not searched. Create/list/inspect/files ignore a
default session and reject an explicit --session. web url --path also ignores a
default session and cannot use explicit --session. Copy full IDs from targets and list.
Workspace lists are device metadata snapshots, including when a device is offline.

Exit: 0 succeeded; 1 remote failed/partial; 2 local usage/configuration/I/O;
3 unknown result. Observe before deciding to repeat an unknown operation.
Results go to stdout; prompts and diagnostics go to stderr. No automatic retries.
`;
}
