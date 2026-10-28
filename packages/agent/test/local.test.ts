import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationError } from "@kiteline/shared/protocol";
import { windowsNative } from "@kiteline/shared/windows/native";
import { testConfig } from "./support/config.js";
import { LocalServer, localRequest } from "../src/local.js";

test("local HTTP returns results and closing preserves unknown writes until sockets close", async () => {
  const root =
    process.platform === "win32"
      ? join(tmpdir(), `kiteline-local-${randomUUID()}`)
      : await mkdtemp("/var/tmp/kiteline-local-");
  if (process.platform === "win32") windowsNative().privateDirectory(root);
  const config = testConfig(root, { runDir: root, shell: "unused" });
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
    const connectionError = await localRequest(config, "workspaces.add", {}).catch(
      (error: unknown) => error,
    );
    expect(connectionError).toBeInstanceOf(Error);
    expect(connectionError).not.toBeInstanceOf(OperationError);
    expect(connectionError).not.toHaveProperty("outcome");
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

test.each(["directories.list", "toString", "constructor"])(
  "a received local %s request keeps its transport error when the server closes",
  async (method) => {
    const root =
      process.platform === "win32"
        ? join(tmpdir(), `kiteline-local-${randomUUID()}`)
        : await mkdtemp("/var/tmp/kiteline-local-");
    if (process.platform === "win32") windowsNative().privateDirectory(root);
    const config = testConfig(root, { runDir: root, shell: "unused" });
    let accepted!: () => void;
    const received = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const local = new LocalServer(config, async (receivedMethod, _params, signal) => {
      expect(receivedMethod).toBe(method);
      accepted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    try {
      await local.start();
      const pending = localRequest(config, method, {}).catch((error: unknown) => error);
      await received;
      await local.close();
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: "ECONNRESET" });
      expect(error).not.toBeInstanceOf(OperationError);
      expect(error).not.toHaveProperty("outcome");
    } finally {
      await local.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
