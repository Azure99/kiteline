import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { lstat, mkdir } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { AppError, appVersion, record, string } from "@kiteline/shared/protocol";
import { agentConfig, atomicJson, readIdentity } from "./config.js";
import { Agent } from "./control.js";
import { terminalCli } from "./terminal-cli.js";
import { doctorCli } from "./doctor.js";
import { installCli, serviceCli } from "./service.js";
import { checkPrerequisites } from "./prerequisites.js";
import { installDirectory, lockInstallation, packageDirectory } from "./installation.js";
import { fetchServerJson } from "./network.js";

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
async function main() {
  if (process.argv.includes("--version")) {
    console.log(appVersion);
    return;
  }
  const command = process.argv[2];
  if (command === "install") {
    await installCli(process.argv.slice(3));
    return;
  }
  if (command === "check") {
    await checkPrerequisites();
    return;
  }
  if (command === "service") {
    await serviceCli(process.argv.slice(3));
    return;
  }
  if (command === "doctor") {
    await doctorCli();
    return;
  }
  if (command === "workspace" || command === "terminal") {
    await terminalCli(await agentConfig(), process.argv.slice(2));
    return;
  }
  if (command !== "run" && command !== "bind")
    throw new Error(
      "Usage: kiteline-agent install --user USER | check | bind --server HTTPS_ORIGIN [--if-unbound] | run | doctor | service | terminal | workspace",
    );
  const config = await agentConfig();
  const installationUse =
    packageDirectory === installDirectory ? await lockInstallation("shared") : undefined;
  let releaseState: (() => Promise<void>) | undefined;
  async function release() {
    try {
      await releaseState?.();
    } finally {
      await installationUse?.close();
    }
  }
  try {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    releaseState = await lockfile.lock(config.dataDir, {
      lockfilePath: resolve(config.dataDir, "process.lock"),
      realpath: false,
    });
    if (command === "bind") {
      const index = process.argv.indexOf("--server");
      const server = new URL(string(index < 0 ? undefined : process.argv[index + 1], "server"));
      if (server.protocol !== "https:")
        throw new AppError("invalid_argument", "server must use HTTPS");
      if (process.argv.includes("--if-unbound")) {
        const exists = await lstat(resolve(config.dataDir, "connection.json")).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (exists)
          throw new Error(
            "This installation is already bound; the existing device identity is retained. Use kiteline-agent run or sudo kiteline-agent service start. To bind again, stop the existing instance first, then explicitly run kiteline-agent bind.",
          );
      }
      const code = await input("Binding code: ");
      let value: Record<string, unknown>;
      try {
        const response = await fetchServerJson(new URL("/api/agent/bind", server), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, name: hostname() }),
          signal: AbortSignal.timeout(config.limits.channelPairTimeout),
        });
        value = record(response.body);
        if (!response.ok)
          throw new AppError(String(record(value.error).code), String(record(value.error).message));
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new Error(
          "Binding result is unknown. Sign in to the web app and check this binding. If the code was consumed but no credentials were saved locally, revoke the device and bind again with a new code.",
          { cause: error },
        );
      }
      const identity = {
        deviceId: string(value.deviceId),
        deviceToken: string(value.deviceToken),
        server: server.origin,
      };
      try {
        await atomicJson(resolve(config.dataDir, "connection.json"), identity);
      } catch (error) {
        throw new Error(
          `Device ${identity.deviceId} was registered but its credentials were not saved; revoke it in the web app and bind again.`,
          {
            cause: error,
          },
        );
      }
      console.log(`Device bound: ${identity.deviceId}`);
      await release();
      return;
    }
    const agent = new Agent(config, await readIdentity(config));
    await agent.start();
    console.log(`Agent ${agent.identity.deviceId} connecting to ${agent.identity.server}`);
    let closing = false;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.on(signal, () => {
        if (closing) return;
        closing = true;
        void agent
          .close()
          .catch((error: unknown) => {
            console.error(error);
            process.exitCode = 1;
          })
          .finally(release);
      });
  } catch (error) {
    await release();
    throw error;
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
