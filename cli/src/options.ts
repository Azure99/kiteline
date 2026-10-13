import { parseArgs } from "node:util";
import { AppError } from "@kiteline/shared/protocol";

const options = {
  help: { type: "boolean" },
  version: { type: "boolean" },
  json: { type: "boolean" },
  server: { type: "string" },
  "token-stdin": { type: "boolean" },
  device: { type: "string" },
  workspace: { type: "string" },
  session: { type: "string" },
} as const;
type Option = keyof typeof options;

const commands: Record<string, readonly Option[]> = {
  "auth login": ["server", "token-stdin"],
  "auth status": [],
  "auth logout": [],
  targets: [],
  inspect: ["device", "workspace"],
  "terminal list": ["device", "workspace"],
};

export function parse(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, tokens: true });
  } catch (error) {
    throw new AppError("invalid_argument", (error as Error).message);
  }
  const { values, positionals, tokens } = parsed;
  const command = positionals.join(" ");
  if (values.help || argv.length === 0) return { command, values, help: true };
  if (values.version && positionals.length === 0) return { command, values, help: false };
  const allowed = commands[command];
  if (!allowed)
    throw new AppError("invalid_argument", `Unknown command: ${command || "(none)"}. Use --help.`);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name))
      throw new AppError("invalid_argument", `--${token.name} may only be specified once`);
    seen.add(token.name);
    if (token.name !== "json" && !allowed.includes(token.name))
      throw new AppError("invalid_argument", `--${token.name} is not valid for ${command}`);
  }
  return { command, values, help: false };
}

export type Options = ReturnType<typeof parse>["values"];

export const help = `Kiteline — remote access to shared workspaces

Commands:
  auth login --server ORIGIN [--token-stdin]  Import a token issued in Web
  auth status                               Show current access and expiry
  auth logout                               Revoke the current token
  targets                                   List authorized devices and workspaces
  inspect --device D --workspace W           Show a workspace and its terminals
  terminal list --device D --workspace W     List terminals and recorder status

Use --json for structured outcome/error.code results. Help and --version work offline.
Owner menu → CLI credentials in Web issues tokens for selected devices. Login
prompts only on a TTY; use --token-stdin explicitly when piping a token.
KITELINE_URL and KITELINE_TOKEN must be supplied together and override saved
credentials. Saved credentials: ~/.kiteline/credentials.json; KITELINE_CLI_HOME
changes that directory. Logout revokes the active token, including an env token.

Only .kiteline.json in the process working directory supplies default targets:
  {"device":"D","workspace":"W","session":"S"}
Explicit --device/--workspace/--session override this call without updating the
file. Parent directories are not searched. List and inspect ignore a default
session and reject an explicit --session. Copy full IDs from targets and list.
Workspace lists are device metadata snapshots, including when a device is offline.

Exit: 0 succeeded; 1 remote failed/partial; 2 local usage/configuration/I/O;
3 unknown result. Observe before deciding to repeat an unknown operation.
Results go to stdout; prompts and diagnostics go to stderr. No automatic retries.
`;
