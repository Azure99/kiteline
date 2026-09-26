import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppError, terminalProfile } from "@kiteline/shared/protocol";
import { tmux } from "@kiteline/shared/terminal/node";
import type { RecorderCall } from "@kiteline/shared/ipc";
import { Agent } from "../src/control.js";
import { defaultAgentLimits } from "../src/config.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Terminal test cleanup failed");
});
async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Expected terminal state did not arrive");
    await delay(20);
  }
}
async function fixture() {
  const dataDir = await mkdtemp("/var/tmp/kiteline-term-");
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const runDir = join(dataDir, "run");
  await mkdir(runDir);
  const agent = new Agent(
    {
      dataDir,
      runDir,
      shell: "/bin/bash",
      limits: { ...defaultAgentLimits, terminalSessionsPerDevice: 3 },
    },
    { deviceId: "terminal-test", deviceToken: "local", server: "https://localhost" },
  );
  cleanups.push(() => agent.close());
  const workspace = await agent.metadata.add(dataDir);
  return { agent, workspace, dataDir, signal: new AbortController().signal };
}

test("real recorder captures Shell output, restores history and pastes while native copy-mode stays active", async () => {
  const { agent, workspace, dataDir, signal } = await fixture();
  const session = await agent.sessions.create(workspace.id, undefined, undefined, signal);
  expect(session).toMatchObject({ state: "running", webStatus: "available" });
  await expect(
    agent.dispatch("workspaces.remove", { workspaceId: workspace.id }, signal),
  ).rejects.toMatchObject({ code: "busy" });
  let output = "";
  const ready = new Set<string>();
  const consumed = new Map<string, number>();
  agent.sessions.onFrame = (message) => {
    if (message.type === "frame" && message.frame.type === "ready") ready.add(message.attachmentId);
    if (message.type === "bytes") {
      const bytes = Buffer.from(message.dataBase64, "base64");
      output += bytes.toString();
      const count = (consumed.get(message.attachmentId) ?? 0) + bytes.length;
      consumed.set(message.attachmentId, count);
      agent.sessions.recorder.send({
        type: "consumed",
        sessionId: session.id,
        attachmentId: message.attachmentId,
        bytes: count,
      });
    }
  };
  await agent.sessions.recorder.request({
    type: "attach",
    sessionId: session.id,
    attachmentId: "first",
    terminalProfile,
    historyGap: false,
    history: "retained",
  });
  await until(() => ready.has("first"));
  const input = (data: string) =>
    agent.sessions.recorder.send({
      type: "input",
      sessionId: session.id,
      attachmentId: "first",
      dataBase64: Buffer.from(data).toString("base64"),
    });
  input("printf 'FIRST-OUTPUT\\n'\r");
  await until(() => output.includes("FIRST-OUTPUT\r\n"));
  const identity = agent.sessions.get(session.id).identity;
  await tmux(identity.socket, ["copy-mode", "-t", identity.paneId!]);
  agent.sessions.recorder.send({
    type: "paste",
    sessionId: session.id,
    attachmentId: "first",
    text: "printf '你好\\n' > result.txt\nprintf 'SECOND\\n' >> result.txt",
  });
  input("\r");
  await until(
    async () =>
      (await readFile(join(dataDir, "result.txt"), "utf8").catch(() => "")) === "你好\nSECOND\n",
  );
  expect(
    (
      await tmux(identity.socket, [
        "display-message",
        "-p",
        "-t",
        identity.paneId!,
        "#{pane_in_mode}",
      ])
    ).trim(),
  ).toBe("1");
  agent.sessions.recorder.detach(session.id, "first");
  output = "";
  await agent.sessions.recorder.request({
    type: "attach",
    sessionId: session.id,
    attachmentId: "second",
    terminalProfile,
    historyGap: false,
    history: "retained",
  });
  await until(() => ready.has("second"));
  expect(output).toContain("FIRST-OUTPUT");
  await agent.sessions.end(workspace.id, session.id);
  expect(agent.sessions.list().sessions).toEqual([]);
}, 15000);

test("recorder death keeps the same task, and agent stop only ends its registered tmux servers", async () => {
  const { agent, workspace, dataDir, signal } = await fixture();
  const outsider = join(dataDir, "unmanaged.sock");
  await tmux(outsider, ["new-session", "-d", "-s", "unmanaged", "/bin/sleep", "60"]);
  cleanups.push(() => tmux(outsider, ["kill-server"]).catch(() => {}));
  const session = await agent.sessions.create(workspace.id, undefined, undefined, signal);
  const identity = agent.sessions.get(session.id).identity;
  const pane = () =>
    tmux(identity.socket, [
      "display-message",
      "-p",
      "-t",
      identity.paneId!,
      "#{pane_pid} #{pane_dead}",
    ]);
  const before = await pane();
  process.kill(agent.sessions.recorder.pid!, "SIGKILL");
  await until(() => agent.sessions.get(session.id).session.webStatus === "unavailable");
  expect(await pane()).toBe(before);
  expect(agent.sessions.get(session.id).session.historyGap).toBe(true);
  await agent.close();
  expect(agent.sessions.list().sessions).toEqual([]);
  await expect(tmux(outsider, ["has-session", "-t", "unmanaged"])).resolves.toBe("");
}, 15000);

test("creation cancellation remains queryable, immediate end cleans up, and short commands leave no sessions", async () => {
  const { agent, workspace, signal } = await fixture();
  const controller = new AbortController();
  agent.sessions.onChanged = () => controller.abort(new AppError("cancelled", "Caller left"));
  await expect(
    agent.sessions.create(workspace.id, undefined, undefined, controller.signal),
  ).rejects.toMatchObject({ outcome: "unknown" });
  const pending = agent.sessions.list().sessions[0]!;
  expect(pending).toBeDefined();
  agent.sessions.onChanged = undefined;
  await agent.sessions.end(workspace.id, pending.id);
  expect(agent.sessions.list().sessions).toEqual([]);
  await agent.metadata.update((value) =>
    value.shortcuts.push({ id: "short", name: "Short", command: "printf short; exit 17" }),
  );
  await agent.sessions.create(workspace.id, undefined, "short", signal).catch((error: unknown) => {
    expect(error).toMatchObject({ outcome: "unknown" });
  });
  await until(() => agent.sessions.list().sessions.length === 0);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      agent.sessions.create(workspace.id, undefined, undefined, signal),
    ),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
  expect(agent.sessions.list().sessions).toHaveLength(3);
}, 15000);

test("workspace removal and terminal creation cannot both succeed", async () => {
  const { agent, workspace, signal } = await fixture();
  const results = await Promise.allSettled([
    agent.dispatch("workspaces.remove", { workspaceId: workspace.id }, signal),
    agent.sessions.create(workspace.id, undefined, undefined, signal),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  for (const session of agent.sessions.list().sessions)
    expect(agent.metadata.workspace(session.workspaceId)).toBeDefined();
});

test("recovery restores the same task and pending Shell input, then redraw and end remain ordered", async () => {
  const { agent, workspace, dataDir, signal } = await fixture();
  const session = await agent.sessions.create(workspace.id, undefined, undefined, signal);
  const identity = agent.sessions.get(session.id).identity;
  const pane = () =>
    tmux(identity.socket, [
      "display-message",
      "-p",
      "-t",
      identity.paneId!,
      "#{pane_pid} #{pane_width} #{pane_height}",
    ]);
  await tmux(identity.socket, ["send-keys", "-l", "printf '%s' RECOVERED > recovered.txt"]);
  await tmux(identity.socket, [
    "set-buffer",
    "-b",
    "user-copy",
    "keep",
    ";",
    "set-buffer",
    "-b",
    "kiteline-web-input",
    "stale",
  ]);
  const before = await pane();
  process.kill(agent.sessions.recorder.pid!, "SIGKILL");
  await until(() => agent.sessions.get(session.id).session.webStatus === "unavailable");
  expect(agent.sessions.recover(workspace.id, session.id).webStatus).toBe("recovering");
  expect(agent.sessions.recover(workspace.id, session.id).webStatus).toBe("recovering");
  await until(() => agent.sessions.get(session.id).session.webStatus !== "recovering");
  expect(agent.sessions.get(session.id).session).toMatchObject({
    webStatus: "available",
    historyGap: true,
  });
  expect(await pane()).toBe(before);
  expect(await tmux(identity.socket, ["show-buffer", "-b", "user-copy"])).toBe("keep");
  await expect(
    tmux(identity.socket, ["show-buffer", "-b", "kiteline-web-input"]),
  ).rejects.toThrow();
  let output = "";
  let ready = false;
  let consumed = 0;
  agent.sessions.onFrame = (message) => {
    if (message.type === "frame" && message.frame.type === "ready") ready = true;
    if (message.type === "bytes") {
      const data = Buffer.from(message.dataBase64, "base64");
      output += data.toString();
      consumed += data.length;
      agent.sessions.recorder.send({
        type: "consumed",
        sessionId: session.id,
        attachmentId: "recovered",
        bytes: consumed,
      });
    }
  };
  await agent.sessions.recorder.request({
    type: "attach",
    sessionId: session.id,
    attachmentId: "recovered",
    terminalProfile,
    historyGap: true,
    history: "retained",
  });
  await until(() => ready);
  expect(output).toContain("recovered.txt");
  agent.sessions.recorder.send({
    type: "input",
    sessionId: session.id,
    attachmentId: "recovered",
    dataBase64: Buffer.from("\r").toString("base64"),
  });
  await until(
    async () =>
      (await readFile(join(dataDir, "recovered.txt"), "utf8").catch(() => "")) === "RECOVERED",
  );
  await agent.sessions.redraw(workspace.id, session.id);
  expect(await pane()).toBe(before);
  const clients = await tmux(identity.socket, [
    "list-clients",
    "-F",
    "#{client_pid} #{client_control_mode}",
  ]);
  const controlPid = Number(clients.trim().split(" ")[0]);
  process.kill(controlPid, "SIGTERM");
  await until(() => agent.sessions.get(session.id).session.webStatus === "unavailable");
  agent.sessions.recover(workspace.id, session.id);
  await until(() => agent.sessions.get(session.id).session.webStatus !== "recovering");
  expect(agent.sessions.get(session.id).session.webStatus).toBe("available");
  await agent.sessions.end(workspace.id, session.id);
  expect(agent.sessions.list().sessions).toEqual([]);
}, 15000);

test("an unresponsive recorder cannot leave a phantom creation or block agent shutdown", async () => {
  const { agent, workspace, signal } = await fixture();
  await agent.sessions.create(workspace.id, undefined, undefined, signal);
  agent.config.limits.channelPairTimeout = 200;
  process.kill(agent.sessions.recorder.pid!, "SIGSTOP");
  await expect(
    agent.sessions.create(workspace.id, undefined, undefined, signal),
  ).rejects.toMatchObject({ outcome: "unknown" });
  expect(agent.sessions.list().sessions.some((item) => item.state === "starting")).toBe(true);
  process.kill(agent.sessions.recorder.pid!, "SIGKILL");
  await until(() => agent.sessions.list().sessions.length === 1);
  await agent.sessions.create(workspace.id, undefined, undefined, signal);
  process.kill(agent.sessions.recorder.pid!, "SIGSTOP");
  await agent.close();
  expect(agent.sessions.list().sessions).toEqual([]);
}, 10000);

test("a failed end does not permanently block recovery of a surviving task", async () => {
  const { agent, workspace, signal } = await fixture();
  const session = await agent.sessions.create(workspace.id, undefined, undefined, signal);
  agent.config.limits.channelPairTimeout = 200;
  process.kill(agent.sessions.recorder.pid!, "SIGSTOP");
  await expect(agent.sessions.end(workspace.id, session.id)).rejects.toMatchObject({
    outcome: "unknown",
  });
  process.kill(agent.sessions.recorder.pid!, "SIGKILL");
  await until(() => agent.sessions.get(session.id).session.webStatus === "unavailable");
  agent.config.limits.channelPairTimeout = 3000;
  expect(agent.sessions.recover(workspace.id, session.id).webStatus).toBe("recovering");
  await until(() => agent.sessions.get(session.id).session.webStatus !== "recovering");
  expect(agent.sessions.get(session.id).session.webStatus).toBe("available");
}, 10000);

test("a failed tmux kill marks the session unavailable and can recover the same live task", async () => {
  const { agent, workspace, dataDir, signal } = await fixture();
  const session = await agent.sessions.create(workspace.id, undefined, undefined, signal);
  const identity = agent.sessions.get(session.id).identity;
  const serverPid = Number(
    (await tmux(identity.socket, ["display-message", "-p", "#{pid}"])).trim(),
  );
  const processStart = async () => {
    const value = await readFile(`/proc/${serverPid}/stat`, "utf8").catch(() => "");
    return value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
  };
  const started = await processStart();
  let held = false;
  const restoreSocket = async () => {
    if (held) {
      await rename(identity.socket + ".held", identity.socket);
      held = false;
    }
  };
  const stopOwned = async () => {
    if (started && (await processStart()) === started) {
      try {
        process.kill(serverPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  cleanups.push(async () => {
    try {
      await restoreSocket();
      await tmux(identity.socket, ["kill-server"]).catch(() => {});
    } finally {
      await stopOwned();
    }
  });
  const pane = () => tmux(identity.socket, ["display-message", "-p", "#{pane_pid} #{pane_dead}"]);
  const before = await pane();
  let ended = false;
  agent.sessions.onFrame = (message) => {
    if (message.type === "ended") ended = true;
  };
  await rename(identity.socket, identity.socket + ".held");
  held = true;
  const recorder = agent.sessions.recorder;
  const original = recorder.request.bind(recorder);
  recorder.request = async <T>(message: RecorderCall): Promise<T> => {
    try {
      return await original<T>(message);
    } catch (error) {
      if (message.type === "end") await restoreSocket();
      throw error;
    }
  };
  try {
    await expect(agent.sessions.end(workspace.id, session.id)).rejects.toMatchObject({
      code: "command_failed",
    });
  } finally {
    recorder.request = original;
    await restoreSocket();
  }
  expect(ended).toBe(false);
  expect(agent.sessions.get(session.id).session).toMatchObject({
    webStatus: "unavailable",
    historyGap: true,
  });
  expect(await pane()).toBe(before);
  expect(agent.sessions.recover(workspace.id, session.id).webStatus).toBe("recovering");
  await until(() => agent.sessions.get(session.id).session.webStatus !== "recovering");
  expect(agent.sessions.get(session.id).session.webStatus).toBe("available");
  expect(await pane()).toBe(before);
  let ready = false;
  let consumed = 0;
  let output = "";
  agent.sessions.onFrame = (message) => {
    if (message.type === "frame" && message.frame.type === "ready") ready = true;
    if (message.type === "bytes") {
      const bytes = Buffer.from(message.dataBase64, "base64");
      output += bytes.toString();
      consumed += bytes.length;
      agent.sessions.recorder.send({
        type: "consumed",
        sessionId: session.id,
        attachmentId: "after-kill",
        bytes: consumed,
      });
    }
  };
  await agent.sessions.recorder.request({
    type: "attach",
    sessionId: session.id,
    attachmentId: "after-kill",
    terminalProfile,
    historyGap: true,
    history: "retained",
  });
  await until(() => ready);
  agent.sessions.recorder.send({
    type: "input",
    sessionId: session.id,
    attachmentId: "after-kill",
    dataBase64: Buffer.from("printf 'AFTER-KILL\\n' | tee survived.txt\r").toString("base64"),
  });
  await until(
    async () =>
      output.includes("AFTER-KILL\r\n") &&
      (await readFile(join(dataDir, "survived.txt"), "utf8").catch(() => "")) === "AFTER-KILL\n",
  );
  await agent.sessions.end(workspace.id, session.id);
  expect(agent.sessions.list().sessions).toEqual([]);
}, 15000);
