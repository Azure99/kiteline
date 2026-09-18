import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { AppError, appVersion, record, string } from "@kiteline/shared/protocol";
import { agentConfig, atomicJson, readIdentity } from "./config.js";
import { Agent } from "./control.js";
import { terminalCli } from "./terminal-cli.js";

async function input(prompt: string) {
  if (!process.stdin.isTTY) {
    let result = "";
    for await (const part of process.stdin) {
      result += part.toString();
      if (result.length > 4096) throw new Error("输入过长");
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
  if (command === "workspace" || command === "terminal") {
    await terminalCli(await agentConfig(), process.argv.slice(2));
    return;
  }
  if (command !== "run" && command !== "bind")
    throw new Error("Usage: kiteline-agent bind --server HTTPS_ORIGIN | run");
  const config = await agentConfig();
  const release = await lockfile.lock(config.dataDir, {
    lockfilePath: resolve(config.dataDir, "process.lock"),
    realpath: false,
  });
  try {
    if (command === "bind") {
      const index = process.argv.indexOf("--server");
      const server = new URL(string(index < 0 ? undefined : process.argv[index + 1], "server"));
      if (server.protocol !== "https:")
        throw new AppError("invalid_argument", "server 必须使用 HTTPS");
      const code = await input("绑定码: ");
      let value: Record<string, unknown>;
      try {
        const response = await fetch(new URL("/api/agent/bind", server), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, name: hostname() }),
          signal: AbortSignal.timeout(config.limits.channelPairTimeout),
        });
        value = record(await response.json());
        if (!response.ok)
          throw new AppError(String(record(value.error).code), String(record(value.error).message));
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new Error(
          "绑定结果未知。请在网页登录后查询本次绑定；已消费但无本地凭据时撤销该设备，再用新码绑定。",
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
        throw new Error(`设备 ${identity.deviceId} 已登记但凭据未保存，请在网页撤销后重新绑定。`, {
          cause: error,
        });
      }
      console.log(`设备已绑定: ${identity.deviceId}`);
      await release();
      return;
    }
    const agent = new Agent(config, await readIdentity(config));
    await agent.start();
    console.log(`Agent ${agent.identity.deviceId} connecting to ${agent.identity.server}`);
    let closing = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const)
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
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
