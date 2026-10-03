import { expect, test } from "vitest";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import {
  appVersion,
  type Reply,
  type ScheduledTask,
  type DeviceTaskSummary,
  type TaskRun,
} from "@kiteline/shared/protocol";
import { Agent } from "../../agent/src/agent.js";
import { defaultAgentLimits, privateDirectory } from "../../agent/src/config.js";
import { localRequest } from "../../agent/src/local.js";
import { createKitelineServer } from "../src/app.js";
import { Store } from "../src/store.js";

async function fixture() {
  const root = await mkdtemp("/var/tmp/kiteline-schedule-relay-");
  const store = new Store(root);
  const app = createKitelineServer(
    {
      dataDir: root,
      trustProxyProto: false,
      hostname: "127.0.0.1",
      port: 0,
      webDir: root,
      downloadsDir: root,
    },
    store,
  );
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const identity = store.bind(store.newBinding().code, "Scheduled Linux");
  const login = store.createLogin(60000);
  const cookie = `kiteline_session_http=${login.token}`;
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`${origin}${path}${path.includes("?") ? "&" : "?"}appVersion=${appVersion}`, {
      method,
      headers: { origin, cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const rpc = async <T>(method: string, params = {}) =>
    (await (
      await call(`/api/devices/${identity.deviceId}/rpc`, "POST", {
        id: randomUUID(),
        method,
        params,
      })
    ).json()) as Reply<T>;
  const summaries = async () =>
    ((await (await call("/api/tasks")).json()) as { devices: DeviceTaskSummary[] }).devices;
  let closed = false;
  return {
    root,
    store,
    app,
    origin,
    identity,
    login,
    cookie,
    call,
    rpc,
    summaries,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("real device CLI/RPC share tasks, snapshots persist only summaries, and remote loss does not own execution", async () => {
  const f = await fixture();
  const config = {
    dataDir: join(f.root, "agent"),
    runDir: join(f.root, "run"),
    shell: "/bin/bash",
    limits: defaultAgentLimits,
  };
  const agent = new Agent(config, { ...f.identity, server: f.origin });
  let events: WebSocket | undefined;
  try {
    expect(await f.summaries()).toMatchObject([
      { deviceId: f.identity.deviceId, observedAt: null, snapshot: null, current: false },
    ]);
    expect((await fetch(f.origin + "/api/tasks?appVersion=" + appVersion)).status).toBe(401);
    expect(
      (await fetch(f.origin + "/api/tasks?appVersion=other", { headers: { cookie: f.cookie } }))
        .status,
    ).toBe(426);
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    await expect.poll(async () => (await f.summaries())[0]?.current).toBe(true);
    expect((await f.summaries())[0]?.snapshot?.items).toEqual([]);
    events = new WebSocket(
      `${f.origin.replace("http:", "ws:")}/api/events?appVersion=${appVersion}`,
      { headers: { cookie: f.cookie, origin: f.origin } },
    );
    const received: { type: string; deviceId?: string }[] = [];
    events.on("message", (data) => received.push(JSON.parse(data.toString())));
    await once(events, "open");
    const task = await localRequest<ScheduledTask>(config, "tasks.create", {
      taskId: "shared",
      input: {
        name: "Task",
        cwd: f.root,
        command: "printf 'DEVICE_ONLY_SENTINEL'; sleep .3; printf done",
        timezone: "UTC",
        schedule: { kind: "cron", expression: "0 9 * * *" },
      },
    });
    await expect.poll(() => received.some((event) => event.type === "tasks.changed")).toBe(true);
    expect(await f.rpc("tasks.get", { taskId: task.id })).toMatchObject({
      outcome: "succeeded",
      result: task,
    });
    expect(
      await f.rpc("tasks.update", {
        taskId: task.id,
        expectedRevision: task.revision,
        changes: { name: "From Web" },
      }),
    ).toMatchObject({ outcome: "succeeded" });
    expect((await localRequest<ScheduledTask>(config, "tasks.get", { taskId: task.id })).name).toBe(
      "From Web",
    );
    expect(
      await f.rpc("tasks.update", {
        taskId: task.id,
        expectedRevision: task.revision,
        changes: { name: "stale" },
      }),
    ).toMatchObject({ outcome: "failed", error: { code: "conflict" } });
    const notify = agent.schedules.onChange!;
    agent.schedules.onChange = (snapshot) => {
      notify(snapshot);
      if (
        snapshot.items[0]?.currentRun?.id === "lost" &&
        snapshot.items[0].currentRun.state === "starting"
      )
        agent.socket?.terminate();
    };
    const lost = await f.rpc("tasks.run", { taskId: task.id, runId: "lost" });
    expect(lost).toMatchObject({ outcome: "unknown" });
    agent.schedules.onChange = notify;
    await expect
      .poll(async () => (await localRequest<TaskRun>(config, "runs.get", { runId: "lost" })).state)
      .toBe("succeeded");
    await expect.poll(async () => (await f.summaries())[0]?.current, { timeout: 5000 }).toBe(true);
    expect(await f.rpc("runs.get", { runId: "lost" })).toMatchObject({
      outcome: "succeeded",
      result: { id: "lost", state: "succeeded" },
    });
    expect(
      await f.rpc("runs.output", { runId: "lost", stream: "stdout", offset: 0 }),
    ).toMatchObject({ outcome: "succeeded", result: { text: "DEVICE_ONLY_SENTINELdone" } });
    const saved = JSON.stringify(f.store.db.prepare("SELECT snapshot FROM taskSummaries").all());
    expect(saved).not.toMatch(/DEVICE_ONLY_SENTINEL|parameters|command|cwd|stdout|diagnostic/);
    const run = await f.rpc<TaskRun>("tasks.run", { taskId: task.id, runId: "logout" });
    expect(run.outcome).toBe("succeeded");
    const sessionEnded = once(events, "close");
    await f.call("/api/logout", "POST", {});
    await sessionEnded;
    await expect
      .poll(
        async () => (await localRequest<TaskRun>(config, "runs.get", { runId: "logout" })).state,
      )
      .toBe("succeeded");
    await localRequest(config, "tasks.create", {
      taskId: "after-delete",
      input: {
        name: "Offline schedule",
        command: "printf offline",
        cwd: f.root,
        schedule: { kind: "once", at: new Date(Date.now() + 400).toISOString() },
      },
    });
    await expect.poll(() => f.store.taskSummaries()[0]?.snapshot?.items.length).toBe(2);
    f.app.connections.deleteDevice(f.identity.deviceId);
    await expect.poll(() => agent.schedules.runs("after-delete").items[0]?.state).toBe("succeeded");
    expect(f.app.connections.taskSummaries()).toEqual([]);
    expect(f.store.taskSummaries()).toEqual([]);
  } finally {
    events?.terminate();
    await agent.close();
    await f.close();
  }
}, 15000);

test("startup storage faults replace active summaries without exposing local diagnostics or disabling the device", async () => {
  const f = await fixture();
  const config = {
    dataDir: join(f.root, "agent"),
    runDir: join(f.root, "run"),
    shell: "/bin/bash",
    limits: defaultAgentLimits,
  };
  let agent = new Agent(config, { ...f.identity, server: f.origin });
  try {
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    await localRequest(config, "tasks.create", {
      taskId: "good",
      input: {
        name: "Active",
        command: "printf DEVICE_ONLY_SENTINEL",
        cwd: f.root,
        schedule: { kind: "cron", expression: "0 9 * * *" },
      },
    });
    await expect
      .poll(async () => (await f.summaries())[0]?.snapshot?.items[0]?.state)
      .toBe("active");
    await agent.close();
    const path = join(config.dataDir, "tasks", "LOCAL_ONLY_SENTINEL.json");
    await writeFile(path, "invalid JSON with LOCAL_ONLY_SENTINEL");
    agent = new Agent(config, { ...f.identity, server: f.origin });
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    await expect
      .poll(async () => (await f.summaries())[0])
      .toMatchObject({ current: true, snapshot: { revision: 0, storageError: true, items: [] } });
    const reply = await f.rpc("tasks.get", { taskId: "good" });
    expect(reply).toEqual({
      id: expect.any(String),
      outcome: "failed",
      error: { code: "io_error", message: "Scheduled task storage is unavailable" },
    });
    expect(await f.rpc("sessions.list")).toMatchObject({
      outcome: "succeeded",
      result: { sessions: [] },
    });
    expect(
      JSON.stringify([
        await f.summaries(),
        f.store.db.prepare("SELECT snapshot FROM taskSummaries").all(),
        reply,
      ]),
    ).not.toMatch(/LOCAL_ONLY_SENTINEL|DEVICE_ONLY_SENTINEL|diagnostic|parameters/);
    expect(f.app.connections.agents.has(f.identity.deviceId)).toBe(true);
    await agent.close();
    await rm(path);
    agent = new Agent(config, { ...f.identity, server: f.origin });
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    await expect
      .poll(async () => (await f.summaries())[0]?.snapshot?.items[0]?.state)
      .toBe("active");
    expect((await f.summaries())[0]?.snapshot?.storageError).toBeUndefined();
  } finally {
    await agent.close();
    await f.close();
  }
});

test("summary DWORD results, ownership, revision and nested whitelist are independent of metadata", async () => {
  const f = await fixture();
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const socket = new WebSocket(
      `${f.origin.replace("http:", "ws:")}/api/agent/control?appVersion=${appVersion}`,
      { headers: { authorization: `Bearer ${f.identity.deviceToken}` } },
    );
    sockets.push(socket);
    await once(socket, "open");
    const welcome = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        environment: {
          os: "linux",
          homePath: "/home/project",
          rootPaths: ["/"],
          cliPath: "/usr/local/bin/kiteline-agent",
          dataDir: "/var/tmp/state",
          runDir: "/var/tmp/run",
        },
        editorBytes: 1000,
        snapshot: {
          schemaVersion: 1,
          revision: 1,
          workspaces: [],
          shortcuts: [],
          settings: { historyLines: 1000 },
        },
      }),
    );
    await welcome;
    return socket;
  };
  try {
    const first = await connect();
    const at = new Date().toISOString();
    const snapshot = {
      type: "tasks.snapshot",
      revision: 9,
      extra: "NO_CACHE",
      items: [
        {
          id: "task",
          name: "Task",
          state: "active",
          nextRunAt: null,
          command: "NO_CACHE",
          cwd: "NO_CACHE",
          latestRun: {
            id: "run",
            taskId: "task",
            trigger: "manual",
            acceptedAt: at,
            endedAt: at,
            state: "succeeded",
            exitCode: 0xffffffff,
            parameters: { command: "NO_CACHE" },
            diagnostic: "NO_CACHE",
            output: { text: "NO_CACHE" },
          },
        },
      ],
    };
    first.send(JSON.stringify(snapshot));
    await expect.poll(async () => (await f.summaries())[0]?.snapshot?.revision).toBe(9);
    expect(JSON.stringify(f.store.taskSummaries())).not.toContain("NO_CACHE");
    expect(f.store.taskSummaries()[0]?.snapshot?.items[0]?.latestRun?.exitCode).toBe(0xffffffff);
    const observedAt = (await f.summaries())[0]!.observedAt;
    first.send(JSON.stringify({ ...snapshot, revision: 8, items: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await f.summaries())[0]).toMatchObject({ observedAt, snapshot: { revision: 9 } });
    const oldConnection = f.app.connections.agents.get(f.identity.deviceId)!;
    const second = await connect();
    expect((await f.summaries())[0]).toMatchObject({ current: false, snapshot: { revision: 9 } });
    oldConnection.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "tasks.snapshot", revision: 99, items: [] })),
      false,
    );
    expect((await f.summaries())[0]?.snapshot?.revision).toBe(9);
    second.send(JSON.stringify({ type: "tasks.snapshot", revision: 0, items: [] }));
    await expect
      .poll(async () => (await f.summaries())[0])
      .toMatchObject({ current: true, snapshot: { revision: 0, items: [] } });
    second.close();
    await expect.poll(async () => (await f.summaries())[0]?.current).toBe(false);
    const reopened = new Store(f.root);
    try {
      expect(reopened.taskSummaries()[0]?.snapshot).toEqual({ revision: 0, items: [] });
    } finally {
      reopened.close();
    }
    const fault = await connect();
    fault.send(
      JSON.stringify({
        type: "tasks.snapshot",
        revision: 0,
        storageError: true,
        items: snapshot.items,
        diagnostic: "LOCAL_ONLY_SENTINEL",
      }),
    );
    await expect
      .poll(async () => (await f.summaries())[0]?.snapshot)
      .toEqual({ revision: 0, storageError: true, items: [] });
  } finally {
    for (const socket of sockets) socket.terminate();
    await f.close();
  }
});
