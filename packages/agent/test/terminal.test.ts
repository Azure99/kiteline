import { afterEach, expect, test, vi } from "vitest";
import { access, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { AppError, limits, type AgentEvent } from "@kiteline/shared/protocol";
import { sessionFiles, tmux } from "@kiteline/shared/terminal/node";
import * as terminalNode from "@kiteline/shared/terminal/node";
import {
  terminalOutputCost,
  type RecorderCall,
  type RecorderMessage,
} from "@kiteline/shared/protocol/ipc";
import { Agent } from "../src/agent.js";
import { testConfig } from "./support/config.js";

type SessionObservers = Partial<
  ConstructorParameters<typeof import("../src/terminal/sessions.js").Sessions>[2]
>;
interface DelayedEnd {
  sessionId: string;
  message?: Extract<RecorderMessage, { type: "ended" }>;
  release?: () => void;
}
const construction = vi.hoisted(() => ({
  observers: undefined as SessionObservers | undefined,
  delayedEnd: undefined as DelayedEnd | undefined,
}));
vi.mock("../src/terminal/sessions.js", async (original) => {
  const actual = await original<typeof import("../src/terminal/sessions.js")>();
  return {
    ...actual,
    Sessions: class extends actual.Sessions {
      constructor(...[config, metadata, events]: ConstructorParameters<typeof actual.Sessions>) {
        const observers = construction.observers;
        super(config, metadata, {
          changed: (workspaceId) => {
            events.changed(workspaceId);
            observers?.changed?.(workspaceId);
          },
          frame: (message) => {
            events.frame(message);
            observers?.frame?.(message);
          },
          notice: (message) => {
            events.notice(message);
            observers?.notice?.(message);
          },
        });
      }
    },
  };
});
vi.mock("../src/terminal/recorder.js", async (original) => {
  const actual = await original<typeof import("../src/terminal/recorder.js")>();
  return {
    ...actual,
    Recorder: class extends actual.Recorder {
      constructor(...[config, events]: ConstructorParameters<typeof actual.Recorder>) {
        const delayed = construction.delayedEnd;
        super(config, {
          exit: events.exit,
          message: (message) => {
            if (delayed && message.type === "ended" && message.sessionId === delayed.sessionId) {
              delayed.message = message;
              delayed.release = () => events.message(message);
            } else events.message(message);
          },
        });
      }
    },
  };
});

const candidateIds = vi.hoisted(() => [] as string[]);
vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof import("node:crypto")>();
  return {
    ...crypto,
    randomBytes: (size: number) =>
      candidateIds.length ? Buffer.from(candidateIds.shift()!, "hex") : crypto.randomBytes(size),
  };
});

const originalInteractionTimeout = limits.interactionTimeout;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  candidateIds.length = 0;
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    Object.assign(limits, { interactionTimeout: originalInteractionTimeout });
  }
  if (failures.length) throw new AggregateError(failures, "Terminal test cleanup failed");
});
const pollOptions = { timeout: 5000, interval: 20 };
function outputCredit(message: Extract<RecorderMessage, { type: "bytes" | "frame" }>) {
  if (message.type === "bytes")
    return terminalOutputCost(Buffer.byteLength(message.dataBase64, "base64"));
  return message.frame.type === "error" || message.frame.type === "input.error"
    ? 0
    : terminalOutputCost(Buffer.byteLength(JSON.stringify(message.frame)));
}
async function fixture({
  rpcTimeout = 30_000,
  observers,
  delayedEnd,
  server = "https://localhost",
}: {
  rpcTimeout?: number;
  observers?: SessionObservers;
  delayedEnd?: DelayedEnd;
  server?: string;
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "kiteline-term-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const runDir = join(dataDir, "run");
  await mkdir(runDir);
  construction.observers = observers;
  construction.delayedEnd = delayedEnd;
  let agent: Agent;
  try {
    agent = new Agent(
      testConfig(dataDir, {
        runDir,
        shell: "/bin/bash",
        limits: { terminalSessionsPerDevice: 3, rpcTimeout },
      }),
      { deviceId: "terminal-test", deviceToken: "local", server },
    );
  } finally {
    construction.observers = undefined;
    construction.delayedEnd = undefined;
  }
  cleanups.push(() => agent.close());
  const workspace = await agent.metadata.add(dataDir);
  return { agent, workspace, dataDir, signal: new AbortController().signal };
}

async function paneIdentity(dataDir: string, id: string) {
  const socket = join(dataDir, "run", id, "tmux.sock");
  const paneId = (await tmux(socket, ["list-panes", "-F", "#{pane_id}"])).trim();
  return { socket, paneId };
}

test("terminal RPCs keep target guards before values and preserve wire defaults", async () => {
  const { agent, workspace, signal } = await fixture();
  const session = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  const target = { sessionId: session.id, workspaceId: workspace.id };
  const recorder = agent.sessions.recorder;
  const request = vi.spyOn(recorder, "request");
  const methods = ["sessions.snapshot", "sessions.send", "sessions.wait", "sessions.resize"];
  const invalid = { tail: -1, input: { type: "raw" }, timeoutMs: 0, cols: 0, rows: 0 };
  try {
    for (const rejectedTarget of [
      { ...target, sessionId: "missing-session" },
      { ...target, workspaceId: "another-workspace" },
    ]) {
      for (const method of methods)
        await expect(
          agent.dispatch(method, { ...rejectedTarget, ...invalid }, signal),
        ).rejects.toMatchObject({ code: "not_found" });
    }
    expect(request).not.toHaveBeenCalled();

    await expect(
      agent.dispatch(
        "sessions.send",
        { ...target, input: { type: "text", text: "" }, timeoutMs: null },
        signal,
      ),
    ).resolves.toMatchObject({
      before: { epoch: expect.any(String), seq: expect.any(Number) },
      input: { epoch: expect.any(String), inputSeq: expect.any(Number) },
    });
    await expect(
      agent.dispatch("sessions.resize", { ...target, cols: 80, rows: 24, timeoutMs: null }, signal),
    ).resolves.toEqual({ cols: 80, rows: 24 });
    await expect(
      agent.dispatch(
        "sessions.wait",
        { ...target, quietMs: null, timeoutMs: null, after: "ignored" },
        signal,
      ),
    ).resolves.toMatchObject({ reason: "quiet" });

    process.kill(recorder.pid!, "SIGKILL");
    await expect
      .poll(
        () => agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus,
        pollOptions,
      )
      .toBe("unavailable");
    request.mockClear();
    for (const method of methods)
      await expect(agent.dispatch(method, { ...target, ...invalid }, signal)).rejects.toMatchObject(
        { code: "recording_unavailable" },
      );
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
  }
}, 15000);

test("short session IDs match exactly and preserve occupied directories and active sessions", async () => {
  const { agent, workspace, dataDir, signal } = await fixture();
  const first = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  expect(first.id).toMatch(/^[a-f0-9]{16}$/);
  const directory = join(dataDir, "run", first.id);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(sessionFiles(directory).config)).mode & 0o777).toBe(0o600);
  await expect(
    agent.dispatch(
      "sessions.snapshot",
      { sessionId: first.id.slice(0, 8), workspaceId: workspace.id },
      signal,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  const residue = join(dataDir, "run", "1111111111111111");
  await mkdir(residue);
  await writeFile(join(residue, "retained.txt"), "retain this directory");
  candidateIds.push(first.id, "1111111111111111", "2222222222222222");
  const second = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  expect(second.id).toBe("2222222222222222");
  expect(agent.sessions.list().sessions.find((item) => item.id === first.id)!).toMatchObject(first);
  candidateIds.push(...Array<string>(8).fill(first.id));
  await expect(agent.sessions.create({ workspaceId: workspace.id }, signal)).rejects.toMatchObject({
    code: "busy",
  });
  expect(agent.sessions.list().sessions.map((session) => session.id)).toEqual([
    first.id,
    second.id,
  ]);
  await agent.close();
  expect(await readFile(join(residue, "retained.txt"), "utf8")).toBe("retain this directory");
}, 15000);

test("recording actions start their deadline after values and retain it through recorder delivery", async () => {
  const { agent, workspace, dataDir, signal } = await fixture();
  const session = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  const target = { workspaceId: workspace.id, sessionId: session.id };
  const { socket } = await paneIdentity(dataDir, session.id);
  const size = () => tmux(socket, ["display-message", "-p", "#{pane_width} #{pane_height}"]);
  const beforeSize = await size();
  const recorder = agent.sessions.recorder;
  const original = recorder.request.bind(recorder);
  const snapshotRequest = vi.spyOn(recorder, "request");
  const snapshot = await agent.sessions.snapshot(target);
  expect(snapshotRequest.mock.calls[0]![0]).toMatchObject({ type: "snapshot" });
  expect(snapshotRequest.mock.calls[0]![0]).not.toHaveProperty("deadline");
  snapshotRequest.mockRestore();

  for (const method of ["sessions.send", "sessions.resize", "sessions.wait"] as const) {
    const beforeValues = Date.now();
    const afterValues = beforeValues + 50;
    const clock = vi.spyOn(Date, "now").mockReturnValue(beforeValues);
    const params: Record<string, unknown> = { ...target, timeoutMs: 1 };
    if (method === "sessions.send") {
      params.input = { type: "text", text: "printf unexpected > expired-input.txt", enter: true };
      Object.defineProperty(params, "ifInput", {
        get: () => {
          clock.mockReturnValue(afterValues);
          return snapshot.input;
        },
      });
    } else if (method === "sessions.resize") {
      params.cols = 91;
      Object.defineProperty(params, "rows", {
        get: () => {
          clock.mockReturnValue(afterValues);
          return 27;
        },
      });
    } else
      Object.defineProperty(params, "quietMs", {
        get: () => {
          clock.mockReturnValue(afterValues);
          return 30;
        },
      });
    const request = vi
      .spyOn(recorder, "request")
      .mockImplementation(async <T>(message: RecorderCall) => {
        clock.mockRestore();
        if (!("deadline" in message)) throw new Error("Recording action must carry a deadline");
        expect(message.deadline).toBe(afterValues + 1);
        // Deliver the real request only after its original action budget has expired.
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, message.deadline - Date.now() + 20)),
        );
        return original<T>(message);
      });
    try {
      const result = agent.dispatch(method, params, signal);
      if (method === "sessions.wait")
        await expect(result).resolves.toMatchObject({ reason: "timeout" });
      else await expect(result).rejects.toMatchObject({ code: "timeout" });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
      request.mockRestore();
    }
  }
  expect(await size()).toBe(beforeSize);
  await expect(access(join(dataDir, "expired-input.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}, 15000);

test("cancelling creation confirmation still creates a real running pane", async () => {
  const controller = new AbortController();
  const { agent, workspace, dataDir } = await fixture({
    observers: { changed: () => controller.abort(new AppError("cancelled", "Caller left")) },
  });
  const failure = await agent.sessions
    .create({ workspaceId: workspace.id }, controller.signal)
    .catch((error: unknown) => error);
  const session = agent.sessions.list().sessions[0]!;
  expect(failure).toMatchObject({
    code: "cancelled",
    outcome: "unknown",
    result: { sessionId: session.id },
  });
  await expect
    .poll(() => agent.sessions.list().sessions[0], pollOptions)
    .toMatchObject({ id: session.id, state: "running", webStatus: "available" });
  const { socket } = await paneIdentity(dataDir, session.id);
  expect(await tmux(socket, ["display-message", "-p", "#{pane_dead}"])).toBe("0\n");
}, 15000);

test.each(["create", "recover"] as const)(
  "close waits for an acknowledged %s before stopping its recorder and pane",
  async (action) => {
    const { agent, workspace, dataDir, signal } = await fixture();
    let sessionId = "";
    if (action === "recover") {
      const session = await agent.sessions.create({ workspaceId: workspace.id }, signal);
      sessionId = session.id;
      process.kill(agent.sessions.recorder.pid!, "SIGKILL");
      await expect
        .poll(() => agent.sessions.list().sessions[0]?.webStatus, pollOptions)
        .toBe("unavailable");
    }
    const recorder = agent.sessions.recorder;
    const original = recorder.request.bind(recorder);
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi
      .spyOn(recorder, "request")
      .mockImplementation(async <T>(message: RecorderCall) => {
        const result = await original<T>(message);
        if (message.type === action) {
          sessionId = message.sessionId;
          acknowledge();
          await gate;
        }
        return result;
      });
    let creation: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      if (action === "create") {
        creation = agent.sessions.create({ workspaceId: workspace.id }, signal);
        await Promise.race([acknowledged, creation]);
      } else {
        agent.sessions.recover({ workspaceId: workspace.id, sessionId });
        await acknowledged;
      }
      const recorderPid = recorder.pid!;
      const { socket } = await paneIdentity(dataDir, sessionId);
      let closed = false;
      closing = agent.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The real recorder must remain usable while Sessions still owns the pending confirmation.
      await expect(
        original({ type: "snapshot", sessionId, options: {}, historyGap: false }),
      ).resolves.toMatchObject({ cols: expect.any(Number), rows: expect.any(Number) });
      expect(closed).toBe(false);
      expect(await tmux(socket, ["display-message", "-p", "#{pane_dead}"])).toBe("0\n");
      release();
      await creation;
      await closing;
      expect(agent.sessions.list().sessions).toEqual([]);
      expect(recorder.pid).toBeUndefined();
      expect(() => process.kill(recorderPid, 0)).toThrow();
      await expect(access(join(dataDir, "run", sessionId))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      release();
      await Promise.allSettled([creation, closing]);
      request.mockRestore();
    }
  },
  15000,
);

test("ordinary Shell names reserve starting records and reuse ended names", async () => {
  const { agent, workspace, signal } = await fixture();
  const created = await Promise.all(
    Array.from({ length: 3 }, () => agent.sessions.create({ workspaceId: workspace.id }, signal)),
  );
  expect(created.map((session) => session.name).sort()).toEqual(["Shell", "Shell 2", "Shell 3"]);
  const first = created.find((session) => session.name === "Shell")!;
  const second = created.find((session) => session.name === "Shell 2")!;
  await agent.sessions.end({ workspaceId: workspace.id, sessionId: first.id });
  const reused = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  expect(reused.name).toBe("Shell");
  agent.sessions.rename({ workspaceId: workspace.id, sessionId: second.id }, "My task");
  expect(agent.sessions.list().sessions.find((item) => item.id === second.id)!.name).toBe(
    "My task",
  );
}, 15000);

test("real recorder captures Shell output, restores history and pastes while native copy-mode stays active", async () => {
  let output = "";
  const ready = new Set<string>();
  const consumed = new Map<string, number>();
  const { agent, workspace, dataDir, signal } = await fixture({
    observers: {
      frame: (message) => {
        if (message.type !== "frame" && message.type !== "bytes") return;
        if (message.type === "frame" && message.frame.type === "ready")
          ready.add(message.attachmentId);
        if (message.type === "bytes") {
          const bytes = Buffer.from(message.dataBase64, "base64");
          output += bytes.toString();
        }
        const credit = outputCredit(message);
        if (credit) {
          const count = (consumed.get(message.attachmentId) ?? 0) + credit;
          consumed.set(message.attachmentId, count);
          agent.sessions.recorder.send({
            type: "consumed",
            sessionId: session.id,
            attachmentId: message.attachmentId,
            bytes: count,
          });
        }
      },
    },
  });
  const session = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  expect(session).toMatchObject({ state: "running", webStatus: "available" });
  await expect(
    agent.dispatch("workspaces.remove", { workspaceId: workspace.id }, signal),
  ).rejects.toMatchObject({ code: "busy" });

  await agent.sessions.recorder.request({
    type: "attach",
    sessionId: session.id,
    attachmentId: "first",
    historyGap: false,
    history: "retained",
  });
  await expect.poll(() => ready.has("first"), pollOptions).toBe(true);
  const input = (data: string) =>
    agent.sessions.recorder.send({
      type: "input",
      sessionId: session.id,
      attachmentId: "first",
      dataBase64: Buffer.from(data).toString("base64"),
    });
  input("printf 'FIRST-OUTPUT\\n'\r");
  await expect.poll(() => output.includes("FIRST-OUTPUT\r\n"), pollOptions).toBe(true);
  const identity = await paneIdentity(dataDir, session.id);
  await tmux(identity.socket, ["copy-mode", "-t", identity.paneId!]);
  agent.sessions.recorder.send({
    type: "paste",
    sessionId: session.id,
    attachmentId: "first",
    text: "printf '你好\\n' > result.txt\nprintf 'SECOND\\n' >> result.txt",
  });
  input("\r");
  await expect
    .poll(
      async () =>
        (await readFile(join(dataDir, "result.txt"), "utf8").catch(() => "")) === "你好\nSECOND\n",
      pollOptions,
    )
    .toBe(true);
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
    historyGap: false,
    history: "retained",
  });
  await expect.poll(() => ready.has("second"), pollOptions).toBe(true);
  expect(output).toContain("FIRST-OUTPUT");
  await agent.sessions.end({ workspaceId: workspace.id, sessionId: session.id });
  expect(agent.sessions.list().sessions).toEqual([]);
}, 15000);

test("recorder death keeps the same task, and agent stop only ends its registered tmux servers", async () => {
  const { agent, workspace, dataDir, signal } = await fixture();
  const outsider = join(dataDir, "unmanaged.sock");
  await tmux(outsider, ["new-session", "-d", "-s", "unmanaged", "/bin/sleep", "60"]);
  cleanups.push(() => tmux(outsider, ["kill-server"]).catch(() => {}));
  const session = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  const identity = await paneIdentity(dataDir, session.id);
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
  await expect
    .poll(
      () =>
        agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus ===
        "unavailable",
      pollOptions,
    )
    .toBe(true);
  expect(await pane()).toBe(before);
  expect(agent.sessions.list().sessions.find((item) => item.id === session.id)!.historyGap).toBe(
    true,
  );
  await agent.close();
  expect(agent.sessions.list().sessions).toEqual([]);
  await expect(tmux(outsider, ["has-session", "-t", "unmanaged"])).resolves.toBe("");
}, 15000);

test("creation cancellation remains queryable, immediate end cleans up, and short commands leave no sessions", async () => {
  const controller = new AbortController();
  const { agent, workspace, signal } = await fixture({
    observers: {
      changed: () => controller.abort(new AppError("cancelled", "Caller left")),
    },
  });
  const interrupted = await agent.sessions
    .create({ workspaceId: workspace.id }, controller.signal)
    .catch((error: unknown) => error);
  const pending = agent.sessions.list().sessions[0]!;
  expect(pending).toBeDefined();
  expect(interrupted).toMatchObject({ outcome: "unknown", result: { sessionId: pending.id } });
  await agent.sessions.end({ workspaceId: workspace.id, sessionId: pending.id });
  expect(agent.sessions.list().sessions).toEqual([]);
  const shortcut = await agent.metadata.putShortcut({
    name: "Short",
    command: "printf short; exit 17",
  });
  await agent.sessions
    .create({ workspaceId: workspace.id, shortcutId: shortcut.id }, signal)
    .catch((error: unknown) => {
      expect(error).toMatchObject({ outcome: "unknown" });
    });
  await expect.poll(() => agent.sessions.list().sessions.length === 0, pollOptions).toBe(true);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => agent.sessions.create({ workspaceId: workspace.id }, signal)),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
  expect(agent.sessions.list().sessions).toHaveLength(3);
}, 15000);

test("workspace removal and terminal creation cannot both succeed", async () => {
  const { agent, workspace, signal } = await fixture();
  const results = await Promise.allSettled([
    agent.dispatch("workspaces.remove", { workspaceId: workspace.id }, signal),
    agent.sessions.create({ workspaceId: workspace.id }, signal),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  for (const session of agent.sessions.list().sessions)
    expect(agent.metadata.workspace(session.workspaceId)).toBeDefined();
});

test("recovery restores the same task and pending Shell input, then redraw and end remain ordered", async () => {
  let output = "";
  let ready = false;
  let consumed = 0;
  const { agent, workspace, dataDir, signal } = await fixture({
    observers: {
      frame: (message) => {
        if (message.type !== "frame" && message.type !== "bytes") return;
        if (message.type === "frame" && message.frame.type === "ready") ready = true;
        if (message.type === "bytes") {
          const data = Buffer.from(message.dataBase64, "base64");
          output += data.toString();
        }
        const credit = outputCredit(message);
        if (credit) {
          consumed += credit;
          agent.sessions.recorder.send({
            type: "consumed",
            sessionId: session.id,
            attachmentId: "recovered",
            bytes: consumed,
          });
        }
      },
    },
  });
  const session = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  const identity = await paneIdentity(dataDir, session.id);
  const pane = () =>
    tmux(identity.socket, [
      "display-message",
      "-p",
      "-t",
      identity.paneId!,
      "#{pane_id} #{window_id} #{pane_pid} #{pane_width} #{pane_height}",
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
  await expect
    .poll(
      () =>
        agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus ===
        "unavailable",
      pollOptions,
    )
    .toBe(true);
  expect(
    agent.sessions.recover({ workspaceId: workspace.id, sessionId: session.id }).webStatus,
  ).toBe("recovering");
  expect(
    agent.sessions.recover({ workspaceId: workspace.id, sessionId: session.id }).webStatus,
  ).toBe("recovering");
  await expect
    .poll(
      () =>
        agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus !==
        "recovering",
      pollOptions,
    )
    .toBe(true);
  expect(agent.sessions.list().sessions.find((item) => item.id === session.id)!).toMatchObject({
    webStatus: "available",
    historyGap: true,
  });
  expect(await pane()).toBe(before);
  expect(await tmux(identity.socket, ["show-buffer", "-b", "user-copy"])).toBe("keep");
  await expect(
    tmux(identity.socket, ["show-buffer", "-b", "kiteline-web-input"]),
  ).rejects.toThrow();

  await agent.sessions.recorder.request({
    type: "attach",
    sessionId: session.id,
    attachmentId: "recovered",
    historyGap: true,
    history: "retained",
  });
  await expect.poll(() => ready, pollOptions).toBe(true);
  expect(output.replaceAll("\r\n", "")).toContain("recovered.txt");
  agent.sessions.recorder.send({
    type: "input",
    sessionId: session.id,
    attachmentId: "recovered",
    dataBase64: Buffer.from("\r").toString("base64"),
  });
  await expect
    .poll(
      async () =>
        (await readFile(join(dataDir, "recovered.txt"), "utf8").catch(() => "")) === "RECOVERED",
      pollOptions,
    )
    .toBe(true);
  await agent.sessions.redraw({ workspaceId: workspace.id, sessionId: session.id });
  expect(await pane()).toBe(before);
  const clients = await tmux(identity.socket, [
    "list-clients",
    "-F",
    "#{client_pid} #{client_control_mode}",
  ]);
  const controlPid = Number(clients.trim().split(" ")[0]);
  process.kill(controlPid, "SIGTERM");
  await expect
    .poll(
      () =>
        agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus ===
        "unavailable",
      pollOptions,
    )
    .toBe(true);
  agent.sessions.recover({ workspaceId: workspace.id, sessionId: session.id });
  await expect
    .poll(
      () =>
        agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus !==
        "recovering",
      pollOptions,
    )
    .toBe(true);
  expect(agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus).toBe(
    "available",
  );
  await agent.sessions.end({ workspaceId: workspace.id, sessionId: session.id });
  expect(agent.sessions.list().sessions).toEqual([]);
}, 15000);

test("an unresponsive recorder cannot leave a phantom creation or block agent shutdown", async () => {
  const { agent, workspace, signal } = await fixture();
  await agent.sessions.create({ workspaceId: workspace.id }, signal);
  Object.assign(limits, { interactionTimeout: 200 });
  process.kill(agent.sessions.recorder.pid!, "SIGSTOP");
  await expect(agent.sessions.create({ workspaceId: workspace.id }, signal)).rejects.toMatchObject({
    outcome: "unknown",
  });
  expect(agent.sessions.list().sessions.some((item) => item.state === "starting")).toBe(true);
  process.kill(agent.sessions.recorder.pid!, "SIGKILL");
  await expect.poll(() => agent.sessions.list().sessions.length === 1, pollOptions).toBe(true);
  const session = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  process.kill(agent.sessions.recorder.pid!, "SIGSTOP");
  const redraw = expect(
    agent.dispatch("sessions.redraw", { workspaceId: workspace.id, sessionId: session.id }, signal),
  ).rejects.toMatchObject({
    code: "recording_unavailable",
    message: "Terminal recorder exited with signal SIGKILL",
    outcome: "unknown",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await agent.close();
  await redraw;
  expect(agent.sessions.list().sessions).toEqual([]);
}, 10000);

test("a failed end does not permanently block recovery of a surviving task", async () => {
  const { agent, workspace, signal } = await fixture();
  const session = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  Object.assign(limits, { interactionTimeout: 200 });
  process.kill(agent.sessions.recorder.pid!, "SIGSTOP");
  await expect(
    agent.sessions.end({ workspaceId: workspace.id, sessionId: session.id }),
  ).rejects.toMatchObject({
    outcome: "unknown",
  });
  process.kill(agent.sessions.recorder.pid!, "SIGKILL");
  await expect
    .poll(
      () =>
        agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus ===
        "unavailable",
      pollOptions,
    )
    .toBe(true);
  Object.assign(limits, { interactionTimeout: 3000 });
  expect(
    agent.sessions.recover({ workspaceId: workspace.id, sessionId: session.id }).webStatus,
  ).toBe("recovering");
  await expect
    .poll(
      () =>
        agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus !==
        "recovering",
      pollOptions,
    )
    .toBe(true);
  expect(agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus).toBe(
    "available",
  );
}, 10000);

test("a timed-out creation stays registered while missing and later recovers the actual late pane", async () => {
  const { agent, workspace, dataDir, signal } = await fixture();
  await agent.sessions.create({ workspaceId: workspace.id }, signal);
  const recorderPid = agent.sessions.recorder.pid!;
  Object.assign(limits, { interactionTimeout: 200 });
  process.kill(recorderPid, "SIGSTOP");
  let paused = true;
  const actualTmux = terminalNode.tmux;
  let inspection: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const failure = await agent.sessions
      .create({ workspaceId: workspace.id }, signal)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      outcome: "unknown",
      result: { sessionId: expect.any(String) },
    });
    const id = (failure as { result: { sessionId: string } }).result.sessionId;
    const socket = join(dataDir, "run", id, "tmux.sock");
    let missingInspections = 0;
    inspection = vi.spyOn(terminalNode, "tmux").mockImplementation(async (...args) => {
      try {
        return await actualTmux(...args);
      } catch (error) {
        if (args[0] === socket && args[1][0] === "list-panes") {
          expect(terminalNode.tmuxServerMissing(error)).toBe(true);
          missingInspections++;
        }
        throw error;
      }
    });
    await expect.poll(() => missingInspections, pollOptions).toBeGreaterThan(0);
    expect(agent.sessions.list().sessions.find((item) => item.id === id)).toMatchObject({
      state: "starting",
      webStatus: "unavailable",
    });
    process.kill(recorderPid, "SIGCONT");
    paused = false;
    await expect
      .poll(
        () => actualTmux(socket, ["list-panes", "-F", "#{pane_dead}"]).catch(() => ""),
        pollOptions,
      )
      .toBe("0\n");
    const paneBefore = await actualTmux(socket, [
      "display-message",
      "-p",
      "#{pane_id} #{window_id} #{pane_pid} #{pane_width} #{pane_height}",
    ]);
    await expect
      .poll(() => agent.sessions.list().sessions.find((item) => item.id === id)?.state, pollOptions)
      .toBe("running");
    expect(agent.sessions.list().sessions.find((item) => item.id === id)?.webStatus).toBe(
      "unavailable",
    );
    Object.assign(limits, { interactionTimeout: 3000 });
    agent.sessions.recover({ workspaceId: workspace.id, sessionId: id });
    await expect
      .poll(
        () => agent.sessions.list().sessions.find((item) => item.id === id)?.webStatus,
        pollOptions,
      )
      .toBe("available");
    expect(
      await actualTmux(socket, [
        "display-message",
        "-p",
        "#{pane_id} #{window_id} #{pane_pid} #{pane_width} #{pane_height}",
      ]),
    ).toBe(paneBefore);
    await agent.sessions.end({ workspaceId: workspace.id, sessionId: id });
  } finally {
    inspection?.mockRestore();
    if (paused) process.kill(recorderPid, "SIGCONT");
  }
}, 15000);

test("an actual dead pane clears a timed-out creation before its delayed ended notification", async () => {
  const delayedEnd: DelayedEnd = { sessionId: "" };
  const { agent, workspace, dataDir, signal } = await fixture({ delayedEnd });
  await agent.sessions.create({ workspaceId: workspace.id }, signal);
  const shortcut = await agent.metadata.putShortcut({
    name: "Late short",
    command: "printf late-dead; exit 19",
  });
  const recorder = agent.sessions.recorder;
  const recorderPid = recorder.pid!;
  const originalRequest = recorder.request.bind(recorder);
  let releaseTimeout!: () => void;
  const timeoutRelease = new Promise<void>((resolve) => (releaseTimeout = resolve));
  let timeout: unknown;
  let targetId = "";
  recorder.request = async <T>(message: RecorderCall): Promise<T> => {
    if (message.type !== "create") return originalRequest<T>(message);
    targetId = message.sessionId;
    delayedEnd.sessionId = targetId;
    try {
      return await originalRequest<T>(message);
    } catch (error) {
      timeout = error;
      await timeoutRelease;
      throw error;
    }
  };

  Object.assign(limits, { interactionTimeout: 200 });
  process.kill(recorderPid, "SIGSTOP");
  let paused = true;
  const creation = agent.sessions.create(
    { workspaceId: workspace.id, shortcutId: shortcut.id },
    signal,
  );
  void creation.catch(() => {});
  try {
    await expect
      .poll(() => timeout, pollOptions)
      .toMatchObject({ code: "timeout", outcome: "unknown" });
    process.kill(recorderPid, "SIGCONT");
    paused = false;
    await expect
      .poll(() => delayedEnd.message, pollOptions)
      .toMatchObject({ sessionId: targetId, exitCode: 19 });
    expect(
      await tmux(join(dataDir, "run", targetId, "tmux.sock"), [
        "list-panes",
        "-a",
        "-F",
        "#{pane_id} #{window_id} #{pane_dead} #{pane_dead_status}",
      ]),
    ).toMatch(/^%\d+ @\d+ 1 19\n$/);
    expect(agent.sessions.list().sessions.find((item) => item.id === targetId)?.state).toBe(
      "starting",
    );
    releaseTimeout();
    await expect(creation).rejects.toBe(timeout);
    expect(agent.sessions.list().sessions.some((item) => item.id === targetId)).toBe(false);
  } finally {
    if (paused) process.kill(recorderPid, "SIGCONT");
    releaseTimeout();
    await creation.catch(() => {});
    recorder.request = originalRequest;
    delayedEnd.release?.();
  }
}, 15000);

test("session cleanup preserves a live pane after kill failure and reports an inspection timeout", async () => {
  const { agent, workspace, dataDir, signal } = await fixture({ rpcTimeout: 200 });
  const session = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  const { socket } = await paneIdentity(dataDir, session.id);
  const serverPid = Number((await tmux(socket, ["display-message", "-p", "#{pid}"])).trim());
  const pane = () =>
    actualTmux(socket, ["display-message", "-p", "#{pane_id} #{pane_pid} #{pane_dead}"]);
  const actualTmux = terminalNode.tmux;
  const before = await pane();
  process.kill(agent.sessions.recorder.pid!, "SIGKILL");
  await expect
    .poll(
      () => agent.sessions.list().sessions.find((item) => item.id === session.id)?.webStatus,
      pollOptions,
    )
    .toBe("unavailable");
  let pauseInspection = false;
  let paused = false;
  let held = false;
  let killFailure: unknown;
  let inspectionFailure: unknown;
  const injection = vi.spyOn(terminalNode, "tmux").mockImplementation(async (...args) => {
    if (args[0] !== socket) return actualTmux(...args);
    if (args[1][0] === "kill-server") {
      await rename(socket, socket + ".held");
      held = true;
      try {
        return await actualTmux(...args);
      } catch (error) {
        killFailure = error;
        throw error;
      } finally {
        await rename(socket + ".held", socket);
        held = false;
        if (pauseInspection) {
          process.kill(serverPid, "SIGSTOP");
          paused = true;
        }
      }
    }
    const resumeServer = () => {
      if (paused) {
        process.kill(serverPid, "SIGCONT");
        paused = false;
      }
    };
    // Resume the stopped server on the actual query abort so its client can finish exiting.
    args[3]?.addEventListener("abort", resumeServer, { once: true });
    try {
      return await actualTmux(...args);
    } catch (error) {
      inspectionFailure = error;
      throw error;
    } finally {
      args[3]?.removeEventListener("abort", resumeServer);
      resumeServer();
    }
  });
  try {
    const liveFailure = await agent.sessions
      .end({ workspaceId: workspace.id, sessionId: session.id })
      .catch((error: unknown) => error);
    expect(liveFailure).toBe(killFailure);
    expect(liveFailure).toMatchObject({ code: "command_failed" });
    expect(await pane()).toBe(before);
    expect(agent.sessions.list().sessions.some((item) => item.id === session.id)).toBe(true);
    pauseInspection = true;
    const unknownFailure = await agent.sessions
      .end({ workspaceId: workspace.id, sessionId: session.id })
      .catch((error: unknown) => error);
    expect(unknownFailure).toBe(inspectionFailure);
    expect(unknownFailure).toMatchObject({ name: "AbortError" });
    expect(terminalNode.tmuxServerMissing(unknownFailure)).toBe(false);
    expect(await pane()).toBe(before);
    expect(agent.sessions.list().sessions.some((item) => item.id === session.id)).toBe(true);
  } finally {
    injection.mockRestore();
    if (paused) process.kill(serverPid, "SIGCONT");
    if (held) await rename(socket + ".held", socket);
  }
  await agent.sessions.end({ workspaceId: workspace.id, sessionId: session.id });
  expect(agent.sessions.list().sessions).toEqual([]);
}, 15000);

test("a failed tmux kill marks the session unavailable and can recover the same live task", async () => {
  let ended = false;
  let ready = false;
  let consumed = 0;
  let output = "";
  const { agent, workspace, dataDir, signal } = await fixture({
    observers: {
      frame: (message) => {
        if (message.type === "ended") ended = true;
        if (message.type !== "frame" && message.type !== "bytes") return;
        if (message.type === "frame" && message.frame.type === "ready") ready = true;
        if (message.type === "bytes") {
          const bytes = Buffer.from(message.dataBase64, "base64");
          output += bytes.toString();
        }
        const credit = outputCredit(message);
        if (credit) {
          consumed += credit;
          agent.sessions.recorder.send({
            type: "consumed",
            sessionId: session.id,
            attachmentId: "after-kill",
            bytes: consumed,
          });
        }
      },
    },
  });
  const session = await agent.sessions.create({ workspaceId: workspace.id }, signal);
  const identity = await paneIdentity(dataDir, session.id);
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
    await expect(
      agent.sessions.end({ workspaceId: workspace.id, sessionId: session.id }),
    ).rejects.toMatchObject({
      code: "command_failed",
    });
  } finally {
    recorder.request = original;
    await restoreSocket();
  }
  expect(ended).toBe(false);
  expect(agent.sessions.list().sessions.find((item) => item.id === session.id)!).toMatchObject({
    webStatus: "unavailable",
    historyGap: true,
  });
  expect(await pane()).toBe(before);
  expect(
    agent.sessions.recover({ workspaceId: workspace.id, sessionId: session.id }).webStatus,
  ).toBe("recovering");
  await expect
    .poll(
      () =>
        agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus !==
        "recovering",
      pollOptions,
    )
    .toBe(true);
  expect(agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus).toBe(
    "available",
  );
  expect(await pane()).toBe(before);

  await agent.sessions.recorder.request({
    type: "attach",
    sessionId: session.id,
    attachmentId: "after-kill",
    historyGap: true,
    history: "retained",
  });
  await expect.poll(() => ready, pollOptions).toBe(true);
  agent.sessions.recorder.send({
    type: "input",
    sessionId: session.id,
    attachmentId: "after-kill",
    dataBase64: Buffer.from("printf 'AFTER-KILL\\n' | tee survived.txt\r").toString("base64"),
  });
  await expect
    .poll(
      async () =>
        output.includes("AFTER-KILL\r\n") &&
        (await readFile(join(dataDir, "survived.txt"), "utf8").catch(() => "")) === "AFTER-KILL\n",
      pollOptions,
    )
    .toBe(true);
  await agent.sessions.end({ workspaceId: workspace.id, sessionId: session.id });
  expect(agent.sessions.list().sessions).toEqual([]);
}, 15000);

test("a recorder-sized OSC report can exceed Agent control budget without losing later reports", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanups.push(async () => {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const received: Extract<AgentEvent, { type: "terminal.notice" }>[] = [];
  const connected = new Promise<WebSocket>((resolve) => {
    server.once("connection", (peer) => {
      peer.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "terminal.notice") received.push(message);
      });
      resolve(peer);
    });
  });
  const observedSizes: number[] = [];
  const { agent, workspace, dataDir, signal } = await fixture({
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    observers: { notice: (message) => observedSizes.push(Buffer.byteLength(message.notice.body)) },
  });
  await agent.start();
  const peer = await connected;
  const session = await agent.sessions.create(
    { workspaceId: workspace.id, name: "Budget source" },
    signal,
  );
  const notice = { title: "", body: "", blocked: false };
  const ipc = { type: "notice", sessionId: session.id, notice };
  notice.body = "x".repeat(
    limits.controlMessageBytes - Buffer.byteLength(JSON.stringify(ipc) + "\n"),
  );
  expect(Buffer.byteLength(JSON.stringify(ipc) + "\n")).toBe(limits.controlMessageBytes);
  expect(
    Buffer.byteLength(
      JSON.stringify({
        type: "terminal.notice",
        sessionId: session.id,
        workspaceId: workspace.id,
        name: session.name,
        notice,
      }),
    ),
  ).toBeGreaterThan(limits.controlMessageBytes);
  const path = join(dataDir, "control-budget.bin");
  await writeFile(path, `\x1b]9;${notice.body}\x07\x1b]9;after budget\x07`);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const print = (command: string) =>
    agent.dispatch(
      "sessions.send",
      {
        workspaceId: workspace.id,
        sessionId: session.id,
        input: { type: "text", text: command, enter: true },
      },
      signal,
    );
  try {
    await print(`cat '${path}'`);
    await expect
      .poll(() => observedSizes, pollOptions)
      .toEqual([notice.body.length, "after budget".length]);
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      `Terminal report dropped for ${session.id}: Control message exceeds the size limit`,
    );
    await expect
      .poll(() => received, pollOptions)
      .toEqual([
        {
          type: "terminal.notice",
          workspaceId: workspace.id,
          sessionId: session.id,
          name: "Budget source",
          notice: { title: "", body: "after budget", blocked: false },
        },
      ]);
    const closed = once(peer, "close");
    peer.close(4001, "connection_replaced");
    await closed;
    logged.mockClear();
    await print("printf '\\033]9;after disconnect\\007'");
    await expect
      .poll(() => logged.mock.calls, pollOptions)
      .toContainEqual([`Terminal report dropped for ${session.id}: server unavailable`]);
    expect(received).toHaveLength(1);
    expect(agent.sessions.list().sessions[0]).toMatchObject({
      id: session.id,
      webStatus: "available",
    });
  } finally {
    logged.mockRestore();
  }
}, 15000);

test("unattached terminal reports retain real source identity and survive an oversized report", async () => {
  const reports: Extract<AgentEvent, { type: "terminal.notice" }>[] = [];
  const { agent, workspace, dataDir, signal } = await fixture({
    observers: { notice: (report) => reports.push(report) },
  });
  const session = await agent.sessions.create(
    { workspaceId: workspace.id, name: "Actual source" },
    signal,
  );
  const body = Buffer.from("Confirm?").toString("base64");
  const path = join(dataDir, "reports.bin");
  await writeFile(
    path,
    `\x1b]9;first\x07\x1b]9;${"x".repeat(limits.controlMessageBytes)}\x07\x1b]7501;state=blocked:app=unrelated:id=another/source:msg=${body}\x07NOTICE_END\r\n`,
  );
  await agent.dispatch(
    "sessions.send",
    {
      workspaceId: workspace.id,
      sessionId: session.id,
      input: { type: "text", text: `cat '${path}'`, enter: true },
    },
    signal,
  );
  await expect
    .poll(() => reports, pollOptions)
    .toEqual([
      {
        type: "terminal.notice",
        workspaceId: workspace.id,
        sessionId: session.id,
        name: "Actual source",
        notice: { title: "", body: "first", blocked: false },
      },
      {
        type: "terminal.notice",
        workspaceId: workspace.id,
        sessionId: session.id,
        name: "Actual source",
        notice: { title: "", body: "Confirm?", blocked: true },
      },
    ]);
  const snapshot = await agent.dispatch(
    "sessions.snapshot",
    { workspaceId: workspace.id, sessionId: session.id },
    signal,
  );
  expect(JSON.stringify(snapshot)).toContain("NOTICE_END");
  expect(agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus).toBe(
    "available",
  );
  process.kill(agent.sessions.recorder.pid!, "SIGKILL");
  await expect
    .poll(
      () => agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus,
      pollOptions,
    )
    .toBe("unavailable");
  agent.sessions.recover({ workspaceId: workspace.id, sessionId: session.id });
  await expect
    .poll(
      () => agent.sessions.list().sessions.find((item) => item.id === session.id)!.webStatus,
      pollOptions,
    )
    .toBe("available");
  expect(reports).toHaveLength(2);
}, 15000);
