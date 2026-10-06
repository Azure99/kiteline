import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { optionalString, string, type Session, type Workspace } from "@kiteline/shared/protocol";
import type { TerminalIdentity } from "@kiteline/shared/protocol/ipc";
import {
  msysDirectory,
  msysPath,
  shellWords,
  tmuxBinary,
  tmuxEnvironment,
  tmuxSession,
} from "@kiteline/shared/terminal/node";
import { spawnJob, type JobChild } from "@kiteline/shared/windows/job";
import { agentPaths, defaultAgentLimits, type AgentConfig } from "../config.js";
import { localRequest } from "../local.js";

export const attachUsage = "attach SESSION_ID [--run-dir DIR]";
const terminalUsage = `terminal list/new/end | ${attachUsage}`;

export async function attachCli(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { "run-dir": { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error(`Usage: kiteline-agent ${attachUsage}`);
  const override = optionalString(values["run-dir"], "run-dir");
  const { runDir } = await agentPaths(override);
  await attachTerminal(
    { runDir, limits: defaultAgentLimits },
    string(positionals[0], "session id"),
  );
}

async function attachTerminal(config: Parameters<typeof localRequest>[0], id: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Attaching requires a local terminal");
  const identity = await localRequest<TerminalIdentity>(config, "terminal.attach", {
    sessionId: id,
  });
  if (process.platform === "win32") {
    const interrupted = () => {};
    process.on("SIGINT", interrupted);
    process.on("SIGBREAK", interrupted);
    let child: JobChild | undefined;
    try {
      const command =
        "exec " +
        shellWords([
          msysPath(tmuxBinary),
          "-N",
          "-S",
          msysPath(identity.socket),
          "attach-session",
          "-E",
          "-t",
          tmuxSession,
        ]);
      child = await spawnJob(
        join(msysDirectory, "usr/bin/bash.exe"),
        [
          "--noprofile",
          "--norc",
          "-ic",
          shellWords(["/usr/bin/script", "-qef", "-c", command, "/dev/null"]),
        ],
        { env: tmuxEnvironment(), stdio: ["inherit", "inherit", "inherit"] },
      );
      process.exitCode = (await child.exited).code;
    } finally {
      await child?.stop();
      process.off("SIGINT", interrupted);
      process.off("SIGBREAK", interrupted);
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      tmuxBinary,
      ["-S", identity.socket, "attach-session", "-E", "-t", tmuxSession],
      { env: tmuxEnvironment(), stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

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
          "no-attach": { type: "boolean" },
        },
      });
      const workspaceId = string(values.workspace, "workspace");
      const shortcutId = optionalString(values.shortcut, "shortcut");
      if (!values["no-attach"] && (!process.stdin.isTTY || !process.stdout.isTTY))
        throw new Error("Attaching requires a local terminal; use --no-attach to create only");
      const session = await localRequest<Session>(config, "sessions.create", {
        workspaceId,
        shortcutId,
      });
      console.log(session.id);
      if (!values["no-attach"]) await attachTerminal(config, session.id);
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
