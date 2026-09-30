import { chmod, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import lockfile from "proper-lockfile";
import { appVersion, string } from "@kiteline/shared/protocol";
import { serverConfig } from "./config.js";
import { Store } from "./store.js";
import { createKitelineServer } from "./app.js";

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "data-dir": { type: "string" }, version: { type: "boolean" } },
  });
  const command = positionals[0] ?? "serve";
  if (
    positionals.length > 1 ||
    !["serve", "setup-token", "reset-password"].includes(command) ||
    (values.version && (positionals.length || values["data-dir"] !== undefined))
  )
    throw new Error(
      "Usage: kiteline-server [serve | setup-token | reset-password] [--data-dir DIR] | --version",
    );
  if (values["data-dir"] !== undefined)
    process.env.KITELINE_DATA_DIR = string(values["data-dir"], "data directory");
  if (values.version) {
    console.log(appVersion);
    return;
  }
  const config = serverConfig();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  const release = await lockfile.lock(config.dataDir, {
    lockfilePath: config.dataDir + "/process.lock",
    realpath: false,
  });
  let store: Store | undefined;
  try {
    store = new Store(config.dataDir);
    if (command !== "serve") {
      if (command === "setup-token") console.log(store.newSetupToken());
      else if (command === "reset-password") {
        const output = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        const reader = createInterface({
          input: process.stdin,
          output,
          terminal: !!process.stdin.isTTY,
        });
        const closed = new AbortController();
        reader.once("close", () => closed.abort());
        process.stdout.write("New password: ");
        let value: string;
        try {
          value = await reader.question("", { signal: closed.signal });
        } finally {
          reader.close();
          output.end();
          process.stdout.write("\n");
        }
        await store.resetPassword(value);
        console.log("Password updated. All web login sessions have been invalidated.");
      }
      return;
    }
    const setupToken = store.ensureSetupToken();
    if (setupToken) console.log(`Kiteline setup token: ${setupToken}`);
    const app = createKitelineServer(config, store);
    try {
      await new Promise<void>((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(config.port, config.hostname, resolve);
      });
      const host = config.hostname.includes(":") ? `[${config.hostname}]` : config.hostname;
      console.log(`Kiteline listening on http://${host}:${config.port}`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    } finally {
      await app.close();
    }
  } finally {
    store?.close();
    await release();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
