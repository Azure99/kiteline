import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import lockfile from "proper-lockfile";
import { appVersion, string } from "@kiteline/shared/protocol";
import { serverConfig } from "./config.js";
import { Store } from "./store.js";
import { createKitelineServer } from "./app.js";

async function main() {
  if (process.argv.includes("--version")) {
    console.log(appVersion);
    return;
  }
  const dataIndex = process.argv.indexOf("--data-dir");
  if (dataIndex >= 0)
    process.env.KITELINE_DATA_DIR = string(process.argv[dataIndex + 1], "data directory");
  const config = serverConfig();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(config.dataDir, {
    lockfilePath: config.dataDir + "/process.lock",
    realpath: false,
  });
  let store: Store | undefined;
  try {
    store = new Store(config.dataDir);
    const command = process.argv[2]?.startsWith("--") ? "serve" : (process.argv[2] ?? "serve");
    if (command !== "serve") {
      if (command === "setup-token") console.log(store.newSetupToken());
      else if (command === "reset-password") {
        const reader = createInterface({ input: process.stdin, output: process.stdout });
        try {
          await store.resetPassword(await reader.question("New password: "));
          console.log("Password updated. All web login sessions have been invalidated.");
        } finally {
          reader.close();
        }
      } else
        throw new Error(
          "Usage: kiteline-server serve | setup-token | reset-password [--data-dir DIR]",
        );
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
      console.log(`Kiteline: ${config.publicUrl} (${config.hostname}:${config.port})`);
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
