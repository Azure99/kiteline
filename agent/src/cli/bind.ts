import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { AppError, limits, record, string } from "@kiteline/shared/protocol";
import { agentConfig, atomicJson, privateDirectory, stateFiles } from "../config.js";
import { fetchServerJson } from "../network.js";
import { lockAgentState } from "../state-lock.js";

async function input(prompt: string) {
  if (!process.stdin.isTTY) {
    let result = "";
    for await (const part of process.stdin) {
      result += part.toString();
      if (result.length > 4096) throw new Error("Input is too long");
    }
    return result.trim();
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
}

export async function bindCli(args: string[]) {
  const config = await agentConfig();
  let releaseState: (() => Promise<void>) | undefined;
  try {
    await privateDirectory(config.dataDir);
    releaseState = await lockAgentState(config.dataDir);
    const index = args.indexOf("--server");
    const server = new URL(string(index < 0 ? undefined : args[index + 1], "server"));
    if (server.protocol !== "http:" && server.protocol !== "https:")
      throw new AppError("invalid_argument", "server must use HTTP or HTTPS");
    if (args.includes("--if-unbound")) {
      const exists = await lstat(resolve(config.dataDir, stateFiles.connection)).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (exists)
        throw new Error(
          "This installation is already bound; the existing device identity is retained. Use kiteline-agent run. To bind again, stop the existing instance first, then explicitly run kiteline-agent bind.",
        );
    }
    const code = await input("Binding code: ");
    let value: Record<string, unknown>;
    try {
      const response = await fetchServerJson(new URL("/api/agent/bind", server), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: hostname() }),
        signal: AbortSignal.timeout(limits.interactionTimeout),
      });
      value = record(response.body);
      if (!response.ok)
        throw new AppError(String(record(value.error).code), String(record(value.error).message));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new Error(
        "Binding result is unknown. Sign in to the web app and check this binding. If the code was consumed but no credentials were saved locally, delete the device and bind again with a new code.",
        { cause: error },
      );
    }
    const identity = {
      deviceId: string(value.deviceId),
      deviceToken: string(value.deviceToken),
      server: server.origin,
    };
    try {
      await atomicJson(resolve(config.dataDir, stateFiles.connection), identity);
    } catch (error) {
      throw new Error(
        `Device ${identity.deviceId} was registered but its credentials were not saved; delete it in the web app and bind again.`,
        { cause: error },
      );
    }
    console.log(`Device bound: ${identity.deviceId}`);
  } finally {
    await releaseState?.();
  }
}
