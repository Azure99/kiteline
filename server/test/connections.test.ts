import { appVersion, type AgentEnvironment, type AgentEvent } from "@kiteline/shared/protocol";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  agentPath,
  apiFixture,
  agentEnvironment as environment,
  hello,
  webPath,
} from "./fixture.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const base = await apiFixture();
  cleanups.push(base.close);
  return base;
}

test("last connected records successful hello, not metadata updates or disconnect", async () => {
  const f = await fixture();
  const peer = await f.device();
  const connected = f.store.devices()[0]!.lastSeenAt;
  expect(connected).not.toBeNull();
  expect(f.app.connections.devices()[0]!.environment).toEqual(environment);
  const snapshot = f.app.connections.devices()[0]!.snapshot!;
  peer.socket.send(
    JSON.stringify({ type: "metadata.snapshot", snapshot: { ...snapshot, revision: 1 } }),
  );
  await expect.poll(() => f.store.devices()[0]!.snapshot?.revision).toBe(1);
  expect(f.store.devices()[0]!.lastSeenAt).toBe(connected);
  expect(f.app.connections.devices()[0]!.environment).toEqual(environment);
  peer.socket.close();
  await expect.poll(() => f.app.connections.devices()[0]!.status).toBe("offline");
  expect(f.app.connections.devices()[0]!.environment).toBeUndefined();
  expect(f.store.devices()[0]).not.toHaveProperty("environment");
  expect(f.store.devices()[0]!.lastSeenAt).toBe(connected);
  const next = new WebSocket(f.origin.replace("http:", "ws:") + agentPath, {
    headers: { authorization: `Bearer ${peer.deviceToken}` },
  });
  await once(next, "open");
  expect(f.store.devices()[0]!.lastSeenAt).toBe(connected);
  const windows: AgentEnvironment = {
    os: "windows",
    homePath: "C:\\Users\\Project",
    rootPaths: ["C:\\", "D:\\"],
    cliPath: "C:\\Program Files\\Kiteline\\bin\\kiteline-agent.ps1",
    dataDir: "C:\\kiteline-state",
    runDir: "C:\\kiteline-run",
  };
  next.send(
    JSON.stringify({
      ...hello(),
      environment: windows,
      snapshot,
    }),
  );
  await expect.poll(() => f.app.connections.devices()[0]!.status).toBe("online");
  expect(f.store.devices()[0]!.lastSeenAt! > connected!).toBe(true);
  expect(f.app.connections.devices()[0]!.environment).toEqual(windows);
});

test("subscribed workspace events and request progress retain their defined fields", async () => {
  const f = await fixture();
  const peer = await f.device();
  const login = f.store.createLogin(60_000);
  const snapshot = f.app.connections.devices()[0]!.snapshot!;
  peer.socket.send(
    JSON.stringify({
      type: "metadata.snapshot",
      snapshot: {
        ...snapshot,
        revision: 1,
        workspaces: [{ id: "work", name: "Work", path: "/workspace" }],
      },
    }),
  );
  await expect.poll(() => f.store.devices()[0]!.snapshot?.revision).toBe(1);
  const browser = new WebSocket(f.origin.replace("http:", "ws:") + webPath("/api/events"), {
    headers: { cookie: `kiteline_session_http=${login.token}`, origin: f.origin },
  });
  const received: Record<string, unknown>[] = [];
  browser.on("message", (data) => received.push(JSON.parse(data.toString())));
  await once(browser, "open");
  browser.send(
    JSON.stringify({
      type: "watch.set",
      targets: [{ deviceId: peer.deviceId, workspaceId: "work" }],
    }),
  );
  await expect
    .poll(() =>
      peer.messages.some(
        (message) =>
          message.type === "watch.set" &&
          Array.isArray(message.workspaceIds) &&
          message.workspaceIds.includes("work"),
      ),
    )
    .toBe(true);
  const pending = f.app.connections.rpc(peer.deviceId, login, "progress", "files.copy", {
    workspaceId: "work",
  });
  const events: AgentEvent[] = [
    { type: "request.progress", id: "progress", phase: "queued" },
    {
      type: "request.progress",
      id: "progress",
      phase: "running",
      currentPath: "",
      completedItems: 0,
      bytes: 0,
    },
    { type: "workspace.changed", workspaceId: "work", scopes: ["files", "git", "repos"] },
    { type: "sessions.changed", workspaceId: "work" },
    { type: "watch.status", workspaceId: "work", status: "degraded", reason: "" },
    { type: "watch.status", workspaceId: "work", status: "normal" },
  ];
  for (const event of events)
    peer.socket.send(JSON.stringify({ ...event, diagnostic: "local detail" }));
  await expect
    .poll(() => received.filter((message) => message.type !== "devices.changed"))
    .toEqual(events.map((event) => ({ ...event, deviceId: peer.deviceId })));
  peer.socket.send(
    JSON.stringify({ type: "rpc.result", reply: { id: "progress", outcome: "succeeded" } }),
  );
  await expect(pending).resolves.toMatchObject({ outcome: "succeeded" });
});

test("long RPC diagnostics preserve the reply and the device connection", async () => {
  const f = await fixture();
  const peer = await f.device();
  const login = f.store.createLogin(60_000);
  const pending = f.call(
    `/api/devices/${peer.deviceId}/rpc`,
    "POST",
    {
      id: "long-error",
      method: "git.commit",
      params: {},
    },
    `kiteline_session_http=${login.token}`,
  );
  await expect.poll(() => peer.messages.some((m) => m.type === "rpc.request")).toBe(true);
  const diagnostic = "hook output\n".repeat(1000) + "\u0000";
  peer.socket.send(
    JSON.stringify({
      type: "rpc.result",
      reply: {
        id: "long-error",
        outcome: "unknown",
        error: { code: "command_failed", message: diagnostic },
      },
    }),
  );
  expect(await (await pending).json()).toMatchObject({
    outcome: "unknown",
    error: { message: diagnostic },
  });
  expect(f.app.connections.devices()[0]!.status).toBe("online");
});

test("version refusal is visible, blocks all device tools, and does not replace a healthy connection", async () => {
  const f = await fixture();
  const identity = f.store.bind(f.store.newBinding().code, "Mismatched device");
  const login = f.store.createLogin(60_000);
  const cookie = `kiteline_session_http=${login.token}`;
  async function rejectVersion(token: string) {
    const socket = new WebSocket(
      f.origin.replace("http:", "ws:") + "/api/agent/control?appVersion=0.0.0-test",
      { headers: { authorization: `Bearer ${token}` } },
    );
    socket.on("error", () => {});
    const rejected = await new Promise<{ status: number; body: string }>((resolve) => {
      socket.on("unexpected-response", (_request, response) => {
        let body = "";
        response.on("data", (part) => {
          body += String(part);
        });
        response.on("end", () => {
          resolve({ status: response.statusCode!, body });
          socket.terminate();
        });
      });
    });
    await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
    expect(rejected.status).toBe(426);
    expect(JSON.parse(rejected.body)).toMatchObject({
      error: {
        code: "version_mismatch",
        details: { component: "agent", clientVersion: "0.0.0-test", serverVersion: appVersion },
      },
    });
  }
  await rejectVersion(identity.deviceToken);
  const device = f.app.connections.devices()[0]!;
  expect(device).toMatchObject({
    status: "offline",
    lastSeenAt: null,
    release: { agentVersion: "0.0.0-test", serverVersion: appVersion },
  });
  for (const [path, method, input] of [
    [
      `/api/devices/${identity.deviceId}/rpc`,
      "POST",
      { id: "blocked", method: "git.status", params: {} },
    ],
    [
      `/api/devices/${identity.deviceId}/channels`,
      "POST",
      {
        kind: "terminal.attach",
        params: { workspaceId: "w", sessionId: "s" },
      },
    ],
    [`/api/devices/${identity.deviceId}/download?workspaceId=w&path=file`, "GET", undefined],
    [`/proxy/${identity.deviceId}/5173/`, "GET", undefined],
  ] as const) {
    const response = await f.call(path, method, input, cookie);
    expect(response.status).toBe(426);
    if (path.startsWith("/proxy/"))
      expect(await response.text()).toContain("does not match server");
    else expect(await response.json()).toMatchObject({ error: { code: "version_mismatch" } });
  }
  const healthy = await f.device("Healthy");
  const before = f.app.connections.devices().find((d) => d.id === healthy.deviceId)!;
  await rejectVersion(healthy.deviceToken);
  expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
  expect(f.app.connections.devices().find((d) => d.id === healthy.deviceId)).toEqual(before);
});

test("invalid current agent capabilities cannot replace a healthy connection", async () => {
  const f = await fixture();
  const peer = await f.device();
  const before = f.app.connections.devices()[0]!;
  for (const [value, editorBytes] of [
    [undefined, 2000],
    [{ ...environment, os: "windows", homePath: "C:relative" }, 2000],
    [{ ...environment, os: "macos", homePath: "relative" }, 2000],
    [{ ...environment, os: "unknown" }, 2000],
    [environment, 0],
  ]) {
    const socket = new WebSocket(f.origin.replace("http:", "ws:") + agentPath, {
      headers: { authorization: `Bearer ${peer.deviceToken}` },
    });
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        ...hello(),
        environment: value,
        editorBytes,
        snapshot: before.snapshot,
      }),
    );
    await once(socket, "close");
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
    expect(f.app.connections.devices()[0]).toEqual(before);
  }
});

test("pending device handshakes are owned by deletion and server shutdown", async () => {
  const f = await fixture();
  const identity = f.store.bind(f.store.newBinding().code, "Pending");
  const socket = new WebSocket(f.origin.replace("http:", "ws:") + agentPath, {
    headers: { authorization: `Bearer ${identity.deviceToken}` },
  });
  await once(socket, "open");
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  f.app.connections.deleteDevice(identity.deviceId);
  socket.send(
    JSON.stringify({
      ...hello(),
      editorBytes: 1000,
    }),
  );
  await once(socket, "close");
  expect(messages).toEqual([]);
  expect(f.app.connections.devices()).toEqual([]);
  const second = f.store.bind(f.store.newBinding().code, "Shutdown");
  const pending = new WebSocket(f.origin.replace("http:", "ws:") + agentPath, {
    headers: { authorization: `Bearer ${second.deviceToken}` },
  });
  await once(pending, "open");
  await f.close();
  await expect.poll(() => pending.readyState).toBe(WebSocket.CLOSED);
});

test("absolute expiry cancels RPC without an event socket and connection replacement ignores late results", async () => {
  const f = await fixture();
  const peer = await f.device();
  const login = f.store.createLogin(150);
  const cookie = `kiteline_session_http=${login.token}`;
  const reply = f.call(
    `/api/devices/${peer.deviceId}/rpc`,
    "POST",
    { id: "expires", method: "directories.list", params: { absolutePath: "/" } },
    cookie,
  );
  await expect
    .poll(() => peer.messages.some((m) => m.type === "rpc.cancel" && m.id === "expires"), {
      timeout: 2500,
    })
    .toBe(true);
  peer.socket.send(
    JSON.stringify({
      type: "rpc.result",
      reply: {
        id: "expires",
        outcome: "failed",
        error: { code: "cancelled", message: "cancelled" },
      },
    }),
  );
  expect((await reply).status).toBe(200);
  const nextLogin = f.store.createLogin(60_000);
  const old = f.call(
    `/api/devices/${peer.deviceId}/rpc`,
    "POST",
    { id: "old", method: "directories.mkdir", params: { absolutePath: "/test" } },
    `kiteline_session_http=${nextLogin.token}`,
  );
  await expect.poll(() => peer.messages.some((m) => m.id === "old")).toBe(true);
  const replacement = new WebSocket(f.origin.replace("http:", "ws:") + agentPath, {
    headers: { authorization: `Bearer ${peer.deviceToken}` },
  });
  await once(replacement, "open");
  replacement.send(
    JSON.stringify({
      ...hello(),
      snapshot: f.app.connections.devices()[0]!.snapshot,
    }),
  );
  expect(await (await old).json()).toMatchObject({ id: "old", outcome: "unknown" });
  await expect.poll(() => peer.socket.readyState).toBe(WebSocket.CLOSED);
});
