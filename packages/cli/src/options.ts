import { parseArgs } from "node:util";
import { posix } from "node:path";
import {
  AppError,
  defaultTerminalOperationTimeoutMs,
  defaultTerminalQuietMs,
  defaultTerminalWaitTimeoutMs,
  limits,
  maxTerminalQuietMs,
  maxTerminalTimeoutMs,
  parseInputPosition,
  parseScreenPosition,
  parseTerminalCols,
  parseTerminalKey,
  parseTerminalPosition,
  parseTerminalQuietMs,
  parseTerminalRows,
  parseTerminalTail,
  parseTerminalTimeoutMs,
  parseTerminalWaitMode,
  string,
  terminalKeys,
  type RpcParams,
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
const commands = {
  "auth login": { target: "none", options: ["server", "token-stdin"] },
  "auth status": { target: "none", options: [] },
  "auth logout": { target: "none", options: [] },
  targets: { target: "none", options: [] },
  inspect: { target: "workspace", options: workspace },
  "terminal list": { target: "workspace", options: workspace },
  "terminal create": { target: "workspace", options: [...workspace, "name"] },
  "terminal attach": { target: "session", options: session },
  "terminal snapshot": { target: "session", options: [...session, ...screen, "if-changed"] },
  "terminal send": {
    target: "session",
    options: [...session, "text", "paste", "enter", "key", "if-input", "timeout-ms"],
  },
  "terminal wait": {
    target: "session",
    options: [...session, ...screen, "mode", "after", "quiet-ms", "timeout-ms"],
  },
  "terminal resize": { target: "session", options: [...session, "cols", "rows", "timeout-ms"] },
  "terminal recover": { target: "session", options: session },
  "files download": { target: "workspace", options: [...workspace, "output"] },
  "files upload": { target: "workspace", options: [...workspace, "file", "replace-version"] },
  "web url": {
    target: { terminal: "session", file: "workspace" },
    options: [...session, "path"],
  },
} as const satisfies Record<
  string,
  {
    target: "none" | "workspace" | "session" | { terminal: "session"; file: "workspace" };
    options: readonly Option[];
  }
>;

export interface WorkspaceSelection {
  kind: "workspace";
  device?: string;
  workspace?: string;
}
export interface SessionSelection {
  kind: "session";
  device?: string;
  workspace?: string;
  session?: string;
}
export type TargetSelection = WorkspaceSelection | SessionSelection;

function selectTarget(kind: "workspace", raw: RawOptions): WorkspaceSelection;
function selectTarget(kind: "session", raw: RawOptions): SessionSelection;
function selectTarget(kind: TargetSelection["kind"], raw: RawOptions): TargetSelection {
  const selection = { device: raw.device, workspace: raw.workspace };
  return kind === "session" ? { kind, ...selection, session: raw.session } : { kind, ...selection };
}

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

function optionValue<T>(name: string, parseValue: () => T): T {
  try {
    return parseValue();
  } catch (error) {
    if (error instanceof AppError)
      throw new AppError(error.code, `--${name}: ${error.message}`, error.details);
    throw error;
  }
}

function keyOption(value: string | undefined) {
  return value === undefined ? undefined : optionValue("key", () => parseTerminalKey(value));
}

function numberOption(
  value: string | undefined,
  name: string,
  parseValue: (value: unknown) => number,
) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value))
    throw new AppError("invalid_argument", `--${name} must contain only decimal digits`);
  return optionValue(name, () => parseValue(Number(value)));
}

function positionParts(value: string) {
  const match = /^([^:]+):(\d+)$/.exec(value);
  if (!match) throw new AppError("invalid_argument", "Expected a position in EPOCH:SEQ format");
  return { epoch: match[1]!, seq: Number(match[2]) };
}

function inputPosition(value: string) {
  return optionValue("if-input", () => {
    const { epoch, seq } = positionParts(value);
    return parseInputPosition({ epoch, inputSeq: seq });
  });
}

function screenPosition(value: string) {
  let position: unknown;
  try {
    position = JSON.parse(value);
  } catch {
    throw new AppError("invalid_argument", "--if-changed requires a position JSON object");
  }
  return optionValue("if-changed", () => parseScreenPosition(position));
}

function parseArguments(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, tokens: true });
  } catch (error) {
    throw new AppError("invalid_argument", (error as Error).message);
  }
  return parsed;
}

type RawOptions = ReturnType<typeof parseArguments>["values"];

function normalizeValues(raw: RawOptions, path: string | undefined) {
  const after = raw.after;
  return {
    ...raw,
    path: filePath(path),
    file: raw.file === undefined ? undefined : string(raw.file, "--file"),
    output: raw.output === undefined ? undefined : string(raw.output, "--output"),
    "replace-version":
      raw["replace-version"] === undefined
        ? undefined
        : string(raw["replace-version"], "--replace-version"),
    key: keyOption(raw.key),
    tail: numberOption(raw.tail, "tail", parseTerminalTail),
    cols: numberOption(raw.cols, "cols", parseTerminalCols),
    rows: numberOption(raw.rows, "rows", parseTerminalRows),
    "quiet-ms": numberOption(raw["quiet-ms"], "quiet-ms", parseTerminalQuietMs),
    "timeout-ms": numberOption(raw["timeout-ms"], "timeout-ms", parseTerminalTimeoutMs),
    "if-changed": raw["if-changed"] === undefined ? undefined : screenPosition(raw["if-changed"]),
    "if-input": raw["if-input"] === undefined ? undefined : inputPosition(raw["if-input"]),
    after:
      after === undefined
        ? undefined
        : optionValue("after", () => parseTerminalPosition(positionParts(after))),
  };
}

function parseSend(raw: RawOptions) {
  if ([raw.text, raw.paste, raw.key].filter((value) => value !== undefined).length !== 1)
    throw new AppError(
      "invalid_argument",
      "send requires exactly one of --text, --paste, or --key",
    );
  if (raw.key !== undefined && raw.enter)
    throw new AppError("invalid_argument", "--enter cannot be combined with --key");
  const values = normalizeValues(raw, raw.path);
  let input: RpcParams<"sessions.send">["input"];
  if (values.key !== undefined) {
    input = { type: "key", key: values.key };
  } else if (values.paste !== undefined) {
    input = { type: "paste", text: values.paste, enter: values.enter };
  } else {
    input = { type: "text", text: values.text!, enter: values.enter };
  }
  return {
    input,
    ifInput: values["if-input"],
    timeoutMs: values["timeout-ms"],
  };
}

type WaitObservation =
  | Omit<Extract<RpcParams<"sessions.wait">, { mode: "change" }>, "workspaceId" | "sessionId">
  | Omit<Extract<RpcParams<"sessions.wait">, { mode?: "quiet" }>, "workspaceId" | "sessionId">;

function parseWait(raw: RawOptions) {
  const mode =
    raw.mode === undefined ? undefined : optionValue("mode", () => parseTerminalWaitMode(raw.mode));
  if (mode === "change") {
    if (raw.after === undefined)
      throw new AppError("invalid_argument", "--mode change requires --after EPOCH:SEQ");
    if (raw["quiet-ms"] !== undefined)
      throw new AppError("invalid_argument", "--quiet-ms cannot be combined with --mode change");
  } else if (raw.after !== undefined)
    throw new AppError("invalid_argument", "--after requires --mode change");
  const values = normalizeValues(raw, raw.path);
  const observation: WaitObservation =
    mode === "change" ? { mode, after: values.after! } : { mode, quietMs: values["quiet-ms"] };
  return {
    ...observation,
    tail: values.tail,
    attrs: values.attrs,
    timeoutMs: values["timeout-ms"],
  };
}

function parseResize(raw: RawOptions) {
  if (raw.cols === undefined || raw.rows === undefined)
    throw new AppError("invalid_argument", "resize requires --cols and --rows");
  const values = normalizeValues(raw, raw.path);
  return {
    cols: values.cols!,
    rows: values.rows!,
    timeoutMs: values["timeout-ms"],
  };
}

export function parse(argv: string[]) {
  const { values: raw, positionals, tokens } = parseArguments(argv);
  const fileCommand =
    positionals[0] === "files" && ["download", "upload"].includes(positionals[1] ?? "");
  const requestedCommand = (fileCommand ? positionals.slice(0, 2) : positionals).join(" ");
  const path = fileCommand ? positionals[2] : raw.path;
  const showHelp = !!raw.help || argv.length === 0;
  if (!showHelp && !(raw.version && !positionals.length)) {
    const allowed = Object.hasOwn(commands, requestedCommand)
      ? (commands[requestedCommand as keyof typeof commands].options as readonly Option[])
      : undefined;
    if (!allowed)
      throw new AppError(
        "invalid_argument",
        `Unknown command: ${requestedCommand || "(none)"}. Use --help.`,
      );
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name))
        throw new AppError("invalid_argument", `--${token.name} may only be specified once`);
      seen.add(token.name);
      if (token.name !== "json" && !allowed.includes(token.name))
        throw new AppError(
          "invalid_argument",
          `--${token.name} is not valid for ${requestedCommand}`,
        );
    }
    if (fileCommand) {
      if (positionals.length !== 3)
        throw new AppError("invalid_argument", `${requestedCommand} requires exactly one PATH`);
      const local = requestedCommand === "files download" ? "output" : "file";
      if (raw[local] === undefined)
        throw new AppError("invalid_argument", `${requestedCommand} requires --${local} LOCAL`);
    }
    if (requestedCommand === "terminal attach" && raw.json)
      throw new AppError("invalid_argument", "terminal attach does not accept --json");
    if (requestedCommand === "web url" && raw.path !== undefined && raw.session !== undefined)
      throw new AppError("invalid_argument", "--path cannot be combined with --session");
  }
  if (showHelp || raw.version) {
    normalizeValues(raw, path);
    return showHelp
      ? { command: "help" as const, requestedCommand }
      : { command: "version" as const };
  }
  const command = requestedCommand as keyof typeof commands;
  const json = raw.json;
  if (command === "terminal send")
    return {
      command: "terminal send" as const,
      json,
      target: selectTarget(commands[command].target, raw),
      params: parseSend(raw),
    };
  if (command === "terminal wait")
    return {
      command: "terminal wait" as const,
      json,
      target: selectTarget(commands[command].target, raw),
      params: parseWait(raw),
    };
  if (command === "terminal resize")
    return {
      command: "terminal resize" as const,
      json,
      target: selectTarget(commands[command].target, raw),
      params: parseResize(raw),
    };
  const values = normalizeValues(raw, path);
  switch (command) {
    case "auth login":
      return { command, json, server: values.server, tokenStdin: values["token-stdin"] };
    case "auth status":
      return { command, json };
    case "auth logout":
      return { command, json };
    case "targets":
      return { command, json };
    case "inspect":
      return { command, json, target: selectTarget(commands[command].target, raw) };
    case "terminal attach":
      return { command, target: selectTarget(commands[command].target, raw) };
    case "terminal list":
      return {
        command,
        json,
        target: selectTarget(commands[command].target, raw),
      };
    case "terminal create":
      return {
        command,
        json,
        target: selectTarget(commands[command].target, raw),
        params: { name: values.name },
      };
    case "terminal snapshot":
      return {
        command,
        json,
        target: selectTarget(commands[command].target, raw),
        params: { tail: values.tail, attrs: values.attrs, ifChanged: values["if-changed"] },
      };
    case "terminal recover":
      return {
        command,
        json,
        target: selectTarget(commands[command].target, raw),
      };
    case "files download":
      return {
        command,
        json,
        target: selectTarget(commands[command].target, raw),
        path: values.path!,
        output: values.output!,
      };
    case "files upload":
      return {
        command,
        json,
        target: selectTarget(commands[command].target, raw),
        path: values.path!,
        file: values.file!,
        replaceVersion: values["replace-version"],
      };
    case "web url":
      return values.path === undefined
        ? { command, json, target: selectTarget(commands[command].target.terminal, raw) }
        : {
            command,
            json,
            target: selectTarget(commands[command].target.file, raw),
            path: values.path,
          };
  }
}

type CommandPlan = ReturnType<typeof parse>;
export type TerminalPlan = Exclude<
  Extract<CommandPlan, { command: `terminal ${string}` }>,
  AttachPlan
>;
export type FilePlan = Extract<CommandPlan, { command: `files ${string}` }>;
export type AttachPlan = Extract<CommandPlan, { command: "terminal attach" }>;
export type WebUrlPlan = Extract<CommandPlan, { command: "web url" }>;

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
  "auth login": `auth login --server ORIGIN [--token-stdin]\nImport a token issued in Web: Settings → CLI setup → CLI credentials. Prompt requires a TTY;\n--token-stdin explicitly reads a piped token. KITELINE_URL/KITELINE_TOKEN override saved credentials.\n`,
  "auth status": `auth status\nShow current credential access, source and expiry.\n`,
  "auth logout": `auth logout\nRevoke the active credential. Environment credentials must also be removed from\nthe calling environment; saved credentials are removed after revocation.\n`,
  targets: `targets\nList authorized devices and workspace metadata snapshots, including offline devices.\n`,
  inspect: `inspect --device D --workspace W\nShow a workspace from the device metadata snapshot and its terminals.\nIgnores a cwd default session; rejects explicit --session.\n`,
  "terminal list": `terminal list --device D --workspace W\nList terminals with actual state and recorder webStatus.\nIgnores a cwd default session; rejects explicit --session.\n`,
  "terminal create": `terminal create --device D --workspace W [--name NAME]\nCreate a persistent terminal in the workspace, shared with Web.\nIgnores a cwd default session; rejects explicit --session.\n`,
  "terminal attach": `terminal attach\n${targetHelp}Interact with an existing running terminal. Requires stdin and stdout TTYs.\nCtrl+B d detaches; Ctrl+B [ opens tmux history; Ctrl+B Ctrl+B sends the prefix.\nInput and size are shared with Web. --if-input does not count attach input.\nSlow output can end this connection; run attach again to reconnect.\nExit 0 means detached and local output drained, not the last remote command status.\n`,
  "terminal snapshot": `terminal snapshot [--tail N] [--attrs] [--if-changed JSON]\n${targetHelp}${observationHelp}Copy the entire position JSON into --if-changed, using the same target and options.\nunchanged has empty stdout but current input metadata; a new epoch returns reset\nwith a full screen. Changing tail/attrs returns full data. There is no position cache.\n`,
  "terminal send": `terminal send (--text TEXT | --paste TEXT) [--enter] [--if-input EPOCH:INPUTSEQ] [--timeout-ms N]\nterminal send --key KEY [--if-input EPOCH:INPUTSEQ] [--timeout-ms N]\n${targetHelp}Keys: ${terminalKeys.join(", ")}. --key cannot use --enter.\n--text sends literal text; the word Enter is not a key. --paste uses terminal paste\nmode. --enter appends Enter after the text or paste. No stdin is read.\n--if-input compares input accepted by this recorder, including Web input; conflict\nmeans no input accepted. Reobserve before choosing a new condition. Acceptance\ndoes not mean echo, exclusivity or command completion. Local tmux and remote attach input is uncounted.\nTimeout: 1..${maxTerminalTimeoutMs}ms, default ${defaultTerminalOperationTimeoutMs}ms. unknown may have sent input; observe before\ndeciding to repeat. No automatic resend or waiting. before is EPOCH:SEQ for wait,\nnot a conditional snapshot position. recording_unavailable requires explicit recover.\n`,
  "terminal wait": `terminal wait [--mode quiet] [--quiet-ms N] [--timeout-ms N] [--tail N] [--attrs]\nterminal wait --mode change --after EPOCH:SEQ [--timeout-ms N] [--tail N] [--attrs]\n${targetHelp}${observationHelp}quiet defaults to ${defaultTerminalQuietMs}ms within a total ${defaultTerminalWaitTimeoutMs}ms; quiet: 1..${maxTerminalQuietMs}ms,\ntimeout: 1..${maxTerminalTimeoutMs}ms. Timeout may be shorter than quiet.\nOutput/resize activity resets quiet, even for identical text. change requires\n--after from snapshot.position or send.before; it rejects --quiet-ms.\nquiet rejects --after. quiet/changed/timeout/reset return full screens.\nA quiet terminal does not confirm program or command completion.\n`,
  "terminal resize": `terminal resize --cols N --rows N [--timeout-ms N]\n${targetHelp}Explicitly resize the same shared terminal.\ncols: 1..${limits.terminalMaxCols}; rows: 1..${limits.terminalMaxRows}. Timeout: 1..${maxTerminalTimeoutMs}ms, default ${defaultTerminalOperationTimeoutMs}ms.\nunknown requires observing the terminal before deciding to repeat.\n`,
  "terminal recover": `terminal recover\n${targetHelp}Request recorder recovery and show actual Session/webStatus. Acceptance does not\nconfirm availability; use terminal list/snapshot afterward. Recovery can reset\nepoch and report a history gap. Input is not resent; there is no automatic polling.\n`,
  "files download": `files download PATH --output LOCAL\n${fileTargetHelp}Stream the remote file into a new local file; an existing LOCAL is never overwritten.\nFailure may leave an empty or partial LOCAL. Download follows a leaf symlink.\nSuccess returns path, output and size; file bytes are not JSON output.\n`,
  "files upload": `files upload PATH --file LOCAL [--replace-version VERSION]\n${fileTargetHelp}Stream a local regular file. By default, create only; an existing target conflicts.\nTo choose replacement after conflict, copy error.details.current.targetVersion\nfrom the error into --replace-version. VERSION is not a download revision.\nReplacement checks the current target; a leaf symlink is replaced, not followed.\nAn unknown result may have published the file: observe through the terminal or\ndownload before deciding to repeat. Success returns path and size.\n`,
  "web url": `web url [--path PATH]\n${targetHelp}Without --path, validate this workspace/session and print its Web terminal URL.\nOpen it to use the same terminal. Focus terminal changes layout; click the actual\nterminal display to focus input. With --path, validate the workspace and print\nits Web file URL, without checking file existence or version. PATH is workspace-\nrelative with / separators and no .. segments. --path ignores a default session\nand cannot use explicit --session. This command does not open a browser or change focus.\n`,
};

export function help(command = "") {
  if (Object.hasOwn(commandHelp, command))
    return (
      commandHelp[command] +
      (command === "terminal attach"
        ? "\n--json is not supported. Help works offline.\n"
        : "\nUse --json for structured outcome/error.code results. Help works offline.\n")
    );
  return `Kiteline — remote access to shared workspaces

Commands:
  auth login --server ORIGIN [--token-stdin]  Import a Web-issued CLI token
  auth status | auth logout                 Inspect or revoke current access
  targets                                   List authorized devices and workspaces
  inspect --device D --workspace W           Show workspace and terminals
  terminal create [--name NAME]              Create a persistent shared terminal
  terminal list                             List terminals and recorder status
  terminal attach                           Interact with an existing terminal
  terminal snapshot [--tail N] [--attrs]     Observe screen and current positions
  terminal send --text TEXT [--enter]        Send input; also --paste or --key
  terminal wait [--mode quiet|change]        Wait for terminal activity conditions
  terminal resize --cols N --rows N          Resize the shared terminal
  terminal recover                          Explicitly request recorder recovery
  files download PATH --output LOCAL        Download into a new local file
  files upload PATH --file LOCAL            Create a remote file; see --help for replacement
  web url [--path PATH]                     Print a terminal or file Web URL

Use COMMAND --help for parameters and behavior. All commands except attach accept --json.
Help and --version work offline. Settings → CLI setup → CLI credentials in Web issues tokens.
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
