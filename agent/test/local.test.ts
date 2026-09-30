import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsNative } from "@kiteline/shared/windows/native";
import { defaultAgentLimits } from "../src/config.js";
import { LocalServer, localRequest } from "../src/local.js";

test("local HTTP returns results and closing preserves unknown writes until sockets close", async () => {
  const root =
    process.platform === "win32"
      ? join(tmpdir(), `kiteline-local-${randomUUID()}`)
      : await mkdtemp("/var/tmp/kiteline-local-");
  if (process.platform === "win32") windowsNative().privateDirectory(root);
  const config = { dataDir: root, runDir: root, shell: "unused", limits: defaultAgentLimits };
  let accepted!: () => void;
  const writing = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  let aborted = false;
  const local = new LocalServer(config, async (method, params, signal) => {
    if (method !== "workspaces.add") return params;
    accepted();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      });
    });
  });
  try {
    await local.start();
    expect(await localRequest(config, "doctor", { value: "hello" })).toEqual({ value: "hello" });
    const result = expect(localRequest(config, "workspaces.add", {})).rejects.toMatchObject({
      outcome: "unknown",
    });
    await writing;
    const closing = local.close();
    expect(local.close()).toBe(closing);
    await closing;
    await result;
    expect(aborted).toBe(true);
  } finally {
    await local.close();
    await rm(root, { recursive: true, force: true });
  }
});
