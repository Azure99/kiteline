import { parseArgs } from "node:util";
import { optionalString, string, type Session, type Workspace } from "@kiteline/shared/protocol";
import type { AgentConfig } from "../config.js";
import { localRequest } from "../local.js";

const terminalUsage = "terminal list/new/end";

export async function terminalCli(config: AgentConfig, args: string[]) {
  if (args[0] === "workspace" && args[1] === "list") {
    parseArgs({ args: args.slice(2) });
    const result = await localRequest<{ workspaces: Workspace[] }>(config, "workspaces.list");
    for (const item of result.workspaces) console.log(`${item.id}\t${item.name}\t${item.path}`);
    return;
  }
  if (args[0] !== "terminal")
    throw new Error(`Usage: kiteline-agent workspace list | ${terminalUsage}`);
  switch (args[1]) {
    case "list": {
      const { values } = parseArgs({
        args: args.slice(2),
        options: { workspace: { type: "string" } },
      });
      const result = await localRequest<{ sessions: Session[] }>(config, "sessions.list", {
        workspaceId: optionalString(values.workspace, "workspace"),
      });
      for (const item of result.sessions)
        console.log(`${item.id}\t${item.workspaceId}\t${item.state}\t${item.name}`);
      break;
    }
    case "new": {
      const { values } = parseArgs({
        args: args.slice(2),
        options: {
          workspace: { type: "string" },
          shortcut: { type: "string" },
        },
      });
      const workspaceId = string(values.workspace, "workspace");
      const shortcutId = optionalString(values.shortcut, "shortcut");
      const session = await localRequest<Session>(config, "sessions.create", {
        workspaceId,
        shortcutId,
      });
      console.log(session.id);
      break;
    }
    case "end": {
      const { positionals } = parseArgs({ args: args.slice(2), allowPositionals: true });
      if (positionals.length !== 1)
        throw new Error("Usage: kiteline-agent terminal end SESSION_ID");
      await localRequest(config, "sessions.end", {
        sessionId: string(positionals[0], "session id"),
      });
      break;
    }
    default:
      throw new Error(`Usage: kiteline-agent ${terminalUsage}`);
  }
}
