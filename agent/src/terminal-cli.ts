import { spawn } from "node:child_process";
import { string, type Session, type Workspace } from "@kiteline/shared/protocol";
import type { TerminalIdentity } from "@kiteline/shared/ipc";
import { tmuxBinary, tmuxEnvironment } from "@kiteline/shared/terminal/node";
import type { AgentConfig } from "./config.js";
import { localRequest } from "./local.js";

export async function terminalCli(config: AgentConfig, args: string[]) {
  function option(name: string) {
    const index = args.indexOf(name);
    return index < 0 ? undefined : string(args[index + 1], name);
  }
  async function attach(id: string) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error("附着需要本机终端；仅创建请使用 --no-attach");
    const identity = await localRequest<TerminalIdentity>(config, "terminal.attach", {
      sessionId: id,
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        tmuxBinary,
        ["-S", identity.socket, "attach-session", "-E", "-t", identity.tmuxSession],
        { env: tmuxEnvironment(), stdio: "inherit" },
      );
      child.on("error", reject);
      child.on("exit", (code) => {
        process.exitCode = code ?? 1;
        resolve();
      });
    });
  }
  if (args[0] === "workspace" && args[1] === "list") {
    const result = await localRequest<{ workspaces: Workspace[] }>(config, "workspaces.list");
    for (const item of result.workspaces) console.log(`${item.id}\t${item.name}\t${item.path}`);
    return;
  }
  if (args[0] !== "terminal")
    throw new Error("Usage: kiteline-agent workspace list | terminal list/new/attach/end");
  switch (args[1]) {
    case "list": {
      const result = await localRequest<{ sessions: Session[] }>(config, "sessions.list", {
        workspaceId: option("--workspace"),
      });
      for (const item of result.sessions)
        console.log(`${item.id}\t${item.workspaceId}\t${item.state}\t${item.name}`);
      break;
    }
    case "new": {
      if (!args.includes("--no-attach") && (!process.stdin.isTTY || !process.stdout.isTTY))
        throw new Error("附着需要本机终端；仅创建请使用 --no-attach");
      const session = await localRequest<Session>(config, "sessions.create", {
        workspaceId: string(option("--workspace"), "workspace"),
        shortcutId: option("--shortcut"),
      });
      console.log(session.id);
      if (!args.includes("--no-attach")) await attach(session.id);
      break;
    }
    case "attach":
      await attach(string(args[2], "session id"));
      break;
    case "end":
      await localRequest(config, "sessions.end", { sessionId: string(args[2], "session id") });
      break;
    default:
      throw new Error("Usage: kiteline-agent terminal list/new/attach/end");
  }
}
