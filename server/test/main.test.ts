import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { appVersion } from "@kiteline/shared/protocol";
import { Store } from "../src/store.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const root = await mkdtemp("/var/tmp/kiteline-server-cli-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
function cli(root: string, args: string[], input = "", address = "127.0.0.1:0") {
  const child = spawn(process.execPath, [resolve("server/dist/main.js"), ...args], {
    env: { ...process.env, KITELINE_DATA_DIR: root, KITELINE_LISTEN_ADDR: address },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  child.stdin.end(input);
  const closed = once(child, "close");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  });
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}

test("server CLI preserves a listen failure and releases state for the next start", async () => {
  const root = await directory();
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const closeHolder = () =>
    new Promise<void>((resolve, reject) => {
      if (!holder.listening) return resolve();
      holder.close((error) => (error ? reject(error) : resolve()));
    });
  cleanups.push(closeHolder);
  const address = `127.0.0.1:${(holder.address() as AddressInfo).port}`;
  const failed = cli(root, [], "", address);
  expect((await failed.closed)[0]).toBe(1);
  expect(failed.stderr()).toContain("EADDRINUSE");
  expect(failed.stderr()).toContain(address);
  expect(await readdir(root)).not.toContain("process.lock");

  await closeHolder();
  const serving = cli(root, [], "", address);
  await expect.poll(serving.stdout).toContain(`Kiteline listening on http://${address}`);
  serving.child.kill("SIGTERM");
  expect((await serving.closed)[0]).toBe(0);
  expect(await readdir(root)).not.toContain("process.lock");
});

test("server CLI validates arguments before accessing state and prints its version independently", async () => {
  const root = await directory();
  const data = join(root, "unused");
  for (const args of [
    ["--unknown"],
    ["setup-token", "extra"],
    ["--data-dir"],
    ["--data-dir", ""],
    ["--version", "serve"],
    ["other"],
  ]) {
    const result = cli(data, args);
    expect((await result.closed)[0]).toBe(1);
    expect(result.stderr()).toBeTruthy();
    expect(await readdir(root)).toEqual([]);
  }
  const result = cli(data, ["--version"]);
  expect((await result.closed)[0]).toBe(0);
  expect(result.stdout().trim()).toBe(appVersion);
  expect(await readdir(root)).toEqual([]);
});

test("server recovery uses the selected state and retains devices through password replacement", async () => {
  const root = await directory();
  const data = join(root, "selected");
  const setup = cli(join(root, "unused"), ["--data-dir", data, "setup-token"]);
  expect((await setup.closed)[0]).toBe(0);
  expect(await readdir(root)).toEqual(["selected"]);
  const store = new Store(data);
  let identity;
  try {
    await store.setup(setup.stdout().trim(), "initial-password");
    identity = store.bind(store.newBinding().code, "Existing device");
    store.createLogin(60_000);
  } finally {
    store.close();
  }
  await chmod(data, 0o755);
  const reset = cli(data, ["reset-password"], " replacement password \n");
  expect((await reset.closed)[0]).toBe(0);
  expect(reset.stdout()).toContain("Password updated");
  expect(reset.stdout()).not.toContain("replacement password");
  expect((await stat(data)).mode & 0o777).toBe(0o700);
  const restored = new Store(data);
  try {
    expect(await restored.verifyPassword(" replacement password ")).toBe(true);
    expect(restored.db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
      count: 0,
    });
    expect(restored.authenticateAgent(identity.deviceToken)?.id).toBe(identity.deviceId);
  } finally {
    restored.close();
  }
  const empty = cli(data, ["reset-password"]);
  expect((await empty.closed)[0]).toBe(1);
  expect(empty.stdout()).not.toContain("Password updated");
  const serving = cli(data, []);
  await expect.poll(serving.stdout).toContain("Kiteline listening");
  serving.child.kill("SIGTERM");
  expect((await serving.closed)[0]).toBe(0);
});
