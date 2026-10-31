import {
  appVersion,
  limits,
  type AgentEnvironment,
  type AgentEvent,
} from "@kiteline/shared/protocol";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  agentPath,
  apiFixture,
  agentEnvironment as environment,
  hello,
  rejectedUpgrade,
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
    dataDir: "C:\\kiteline-state",
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
    { type: "workspace.changed", workspaceId: "work" },
    { type: "sessions.changed", workspaceId: "work" },
    { type: "watch.status", workspaceId: "work", status: "degraded", reason: "" },
    { type: "watch.status", workspaceId: "work", status: "normal" },
  ];
  for (const event of events)
    peer.socket.send(JSON.stringify({ ...event, diagnostic: "local detail" }));
  await expect
    .poll(() =>
      received.filter(
        (message) => !["devices.changed", "notices.reset"].includes(String(message.type)),
      ),
    )
    .toEqual(events.map((event) => ({ ...event, deviceId: peer.deviceId })));
  peer.socket.send(
    JSON.stringify({ type: "rpc.result", reply: { id: "progress", outcome: "succeeded" } }),
  );
  await expect(pending).resolves.toMatchObject({ outcome: "succeeded" });
});

const malformedRequestMessages = [
  {
    name: "reply outcome",
    message: (id: string) => ({ type: "rpc.result", reply: { id, outcome: null } }),
  },
  {
    name: "reply error",
    message: (id: string) => ({
      type: "rpc.result",
      reply: { id, outcome: "failed", error: { code: "io_error", message: null } },
    }),
  },
  {
    name: "progress phase",
    message: (id: string) => ({ type: "request.progress", id, phase: null }),
  },
];

test.each(malformedRequestMessages)(
  "invalid $name is ignored for unknown IDs and another connection's pending request",
  async ({ message }) => {
    const f = await fixture();
    const sender = await f.device("Sender");
    const owner = await f.device("Request owner");
    const login = f.store.createLogin(60_000);
    const cookie = `kiteline_session_http=${login.token}`;
    const path = `/api/devices/${owner.deviceId}/rpc`;
    const input = { id: "owned-request", method: "files.copy", params: {} };
    const pending = f.call(path, "POST", input, cookie);
    await expect
      .poll(() =>
        owner.messages.some((value) => value.type === "rpc.request" && value.id === input.id),
      )
      .toBe(true);

    sender.socket.send(JSON.stringify(message("unknown-request")));
    sender.socket.send(JSON.stringify(message(input.id)));
    const pong = once(sender.socket, "pong");
    sender.socket.ping();
    await pong;
    const duplicate = await f.call(path, "POST", input, cookie);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "conflict" } });

    const reply = { id: input.id, outcome: "succeeded", result: { completed: 1 } };
    owner.socket.send(JSON.stringify({ type: "rpc.result", reply }));
    expect(await (await pending).json()).toEqual(reply);
    expect(sender.socket.readyState).toBe(WebSocket.OPEN);
  },
);

test.each(malformedRequestMessages)(
  "invalid $name for the current pending request closes control and returns unknown/offline",
  async ({ message }) => {
    const f = await fixture();
    const peer = await f.device();
    const login = f.store.createLogin(60_000);
    const input = { id: "current-request", method: "files.copy", params: {} };
    const pending = f.call(
      `/api/devices/${peer.deviceId}/rpc`,
      "POST",
      input,
      `kiteline_session_http=${login.token}`,
    );
    await expect
      .poll(() =>
        peer.messages.some((value) => value.type === "rpc.request" && value.id === input.id),
      )
      .toBe(true);
    const closed = once(peer.socket, "close");
    peer.socket.send(JSON.stringify(message(input.id)));
    const [code, reason] = await closed;
    expect(code).toBe(1008);
    expect(reason.toString()).toBe("invalid_control_message");
    expect(await (await pending).json()).toMatchObject({
      id: input.id,
      outcome: "unknown",
      error: { code: "offline" },
    });
  },
);

test.each(["rpc.result", "request.progress"])(
  "%s rejects an invalid ID instead of treating it as an unknown request",
  async (type) => {
    const f = await fixture();
    const peer = await f.device();
    const message =
      type === "rpc.result"
        ? { type, reply: { id: "", outcome: "succeeded" } }
        : { type, id: "", phase: "running" };
    const closed = once(peer.socket, "close");
    peer.socket.send(JSON.stringify(message));
    const [code, reason] = await closed;
    expect(code).toBe(1008);
    expect(reason.toString()).toBe("invalid_control_message");
  },
);

test("unknown control types require hello and are ignored after it", async () => {
  const f = await fixture();
  const peer = await f.device();
  const candidate = new WebSocket(f.origin.replace("http:", "ws:") + agentPath, {
    headers: { authorization: `Bearer ${peer.deviceToken}` },
  });
  await once(candidate, "open");
  const message = JSON.stringify({ type: "future.event", payload: null });
  const closed = once(candidate, "close");
  candidate.send(message);
  const [code, reason] = await closed;
  expect(code).toBe(1008);
  expect(reason.toString()).toBe("invalid_control_message");

  peer.socket.send(message);
  const pong = once(peer.socket, "pong");
  peer.socket.ping();
  await pong;
  expect(f.app.connections.devices()[0]!.status).toBe("online");
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
  const events: Record<string, unknown>[] = [];
  const browser = new WebSocket(f.origin.replace("http:", "ws:") + webPath("/api/events"), {
    headers: { cookie, origin: f.origin },
  });
  browser.on("message", (data) => events.push(JSON.parse(data.toString())));
  await once(browser, "open");
  await expect.poll(() => events.some((event) => event.type === "devices.changed")).toBe(true);
  events.length = 0;
  async function rejectVersion(token: string) {
    const rejected = await rejectedUpgrade(
      f.origin.replace("http:", "ws:") + "/api/agent/control?appVersion=0.0.0-test",
      { authorization: `Bearer ${token}` },
    );
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
  await expect
    .poll(() => events.filter((event) => event.type === "devices.changed"))
    .toEqual([{ type: "devices.changed", devices: [device] }]);
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

test("invalid hello fields cannot replace a healthy connection", async () => {
  const f = await fixture();
  const peer = await f.device();
  const before = f.app.connections.devices()[0]!;
  for (const invalid of [
    { environment: undefined },
    { environment: { ...environment, os: "windows", homePath: "C:relative" } },
    { environment: { ...environment, os: "macos", homePath: "relative" } },
    { environment: { ...environment, os: "unknown" } },
    { editorBytes: 0 },
    { snapshot: null },
  ]) {
    const socket = new WebSocket(f.origin.replace("http:", "ws:") + agentPath, {
      headers: { authorization: `Bearer ${peer.deviceToken}` },
    });
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        ...hello(),
        snapshot: before.snapshot,
        ...invalid,
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

test("absolute expiry forwards RPC cancellation without an event socket and still accepts its reply", async () => {
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
  const response = await reply;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: "expires",
    outcome: "failed",
    error: { code: "cancelled" },
  });
});

test("logout forwards cancellation while the global RPC ID stays reserved until the original reply", async () => {
  const f = await fixture();
  const first = await f.device("First");
  const second = await f.device("Second");
  const originalLogin = f.store.createLogin(60_000);
  const otherLogin = f.store.createLogin(60_000);
  const originalCookie = `kiteline_session_http=${originalLogin.token}`;
  const otherCookie = `kiteline_session_http=${otherLogin.token}`;
  const input = { id: "shared-id", method: "directories.mkdir", params: { absolutePath: "/test" } };
  const original = f.call(`/api/devices/${first.deviceId}/rpc`, "POST", input, originalCookie);
  await expect
    .poll(() =>
      first.messages.some((message) => message.type === "rpc.request" && message.id === input.id),
    )
    .toBe(true);
  const duplicate = await f.call(`/api/devices/${second.deviceId}/rpc`, "POST", input, otherCookie);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: { code: "conflict" } });

  expect((await f.call("/api/logout", "POST", {}, originalCookie)).status).toBe(200);
  await expect
    .poll(() =>
      first.messages.some((message) => message.type === "rpc.cancel" && message.id === input.id),
    )
    .toBe(true);
  const afterCancel = await f.call(
    `/api/devices/${second.deviceId}/rpc`,
    "POST",
    input,
    otherCookie,
  );
  expect(afterCancel.status).toBe(409);
  expect(await afterCancel.json()).toMatchObject({ error: { code: "conflict" } });

  const originalReply = { id: input.id, outcome: "succeeded", result: { device: "first" } };
  first.socket.send(JSON.stringify({ type: "rpc.result", reply: originalReply }));
  const originalResponse = await original;
  expect(originalResponse.status).toBe(200);
  expect(await originalResponse.json()).toEqual(originalReply);

  const reused = f.call(`/api/devices/${second.deviceId}/rpc`, "POST", input, otherCookie);
  await expect
    .poll(() =>
      second.messages.some((message) => message.type === "rpc.request" && message.id === input.id),
    )
    .toBe(true);
  const reusedReply = { id: input.id, outcome: "succeeded", result: { device: "second" } };
  second.socket.send(JSON.stringify({ type: "rpc.result", reply: reusedReply }));
  expect(await (await reused).json()).toEqual(reusedReply);
});

test("replacement broadcasts offline then online and isolates ready channels and late old replies", async () => {
  const f = await fixture();
  const peer = await f.device("Replaced");
  cleanups.push(() => {
    peer.socket.resume();
    peer.socket.terminate();
  });
  const login = f.store.createLogin(60_000);
  const cookie = `kiteline_session_http=${login.token}`;
  const oldConnection = f.app.connections.online(peer.deviceId)!;

  const deviceStates: string[] = [];
  const browser = new WebSocket(f.origin.replace("http:", "ws:") + webPath("/api/events"), {
    headers: { cookie, origin: f.origin },
  });
  browser.on("message", (data) => {
    const event = JSON.parse(data.toString());
    if (event.type === "devices.changed")
      deviceStates.push(
        event.devices.find((device: { id: string }) => device.id === peer.deviceId).status,
      );
  });
  await once(browser, "open");
  await expect.poll(() => deviceStates).toEqual(["online"]);
  deviceStates.length = 0;

  const fileParams = { workspaceId: "work", path: "file", purpose: "text" };
  const oldChannel = f.app.channels.create(peer.deviceId, login, "file.read", fileParams);
  const oldData = await f.dataChannel(peer.deviceToken, oldChannel.id, oldConnection.connectionId);
  const fileReady = {
    type: "ready",
    meta: {
      size: 4,
      filename: "file",
      targetPath: "file",
      contentType: "text/plain; charset=utf-8",
    },
  };
  oldData.send(JSON.stringify(fileReady));
  await oldChannel.ready;
  const oldDataClosed = once(oldData, "close");
  const input = {
    id: "generation-id",
    method: "directories.mkdir",
    params: { absolutePath: "/test" },
  };
  const original = f.call(`/api/devices/${peer.deviceId}/rpc`, "POST", input, cookie);
  await expect
    .poll(() =>
      peer.messages.some((message) => message.type === "rpc.request" && message.id === input.id),
    )
    .toBe(true);
  peer.socket.pause();

  const replacement = new WebSocket(f.origin.replace("http:", "ws:") + agentPath, {
    headers: { authorization: `Bearer ${peer.deviceToken}` },
  });
  const replacementMessages: Record<string, unknown>[] = [];
  replacement.on("message", (data) => replacementMessages.push(JSON.parse(data.toString())));
  await once(replacement, "open");
  replacement.send(JSON.stringify(hello()));
  await expect
    .poll(() => replacementMessages.some((message) => message.type === "welcome"))
    .toBe(true);
  expect(await (await original).json()).toMatchObject({
    id: input.id,
    outcome: "unknown",
    error: { code: "offline" },
  });
  await oldDataClosed;
  await expect.poll(() => deviceStates).toEqual(["offline", "online"]);
  expect(oldConnection.socket.readyState).toBe(WebSocket.CLOSING);
  expect(peer.socket.readyState).toBe(WebSocket.OPEN);

  const reused = f.call(`/api/devices/${peer.deviceId}/rpc`, "POST", input, cookie);
  await expect
    .poll(() =>
      replacementMessages.some(
        (message) => message.type === "rpc.request" && message.id === input.id,
      ),
    )
    .toBe(true);
  const lateReply = {
    type: "rpc.result",
    reply: { id: input.id, outcome: "succeeded", result: "old" },
  };
  const oldFrameReceived = once(oldConnection.socket, "message");
  peer.socket.send(JSON.stringify(lateReply));
  const [oldFrame, binary] = await oldFrameReceived;
  expect(binary).toBe(false);
  expect(JSON.parse(oldFrame.toString())).toEqual(lateReply);
  const afterLateReply = await f.call(`/api/devices/${peer.deviceId}/rpc`, "POST", input, cookie);
  expect(afterLateReply.status).toBe(409);
  expect(await afterLateReply.json()).toMatchObject({ error: { code: "conflict" } });
  const newReply = { id: input.id, outcome: "succeeded", result: "new" };
  replacement.send(JSON.stringify({ type: "rpc.result", reply: newReply }));
  expect(await (await reused).json()).toEqual(newReply);

  const oldClosed = once(peer.socket, "close");
  peer.socket.resume();
  const [, reason] = await oldClosed;
  expect(reason.toString()).toBe("connection_replaced");

  const newChannel = f.app.channels.create(peer.deviceId, login, "file.read", fileParams);
  const rejected = await rejectedUpgrade(
    f.origin.replace("http:", "ws:") +
      `/api/agent/channels/${newChannel.id}?connectionId=${oldConnection.connectionId}`,
    { authorization: `Bearer ${peer.deviceToken}` },
  );
  expect(rejected.status).toBe(403);
  expect(JSON.parse(rejected.body)).toMatchObject({ error: { code: "forbidden" } });
  const newConnection = f.app.connections.online(peer.deviceId)!;
  expect(newConnection.connectionId).not.toBe(oldConnection.connectionId);
  const newData = await f.dataChannel(peer.deviceToken, newChannel.id, newConnection.connectionId);
  newData.send(JSON.stringify(fileReady));
  await newChannel.ready;
});

test("terminal reports reach permitted devices without workspace subscriptions and use connection identity", async () => {
  const f = await fixture();
  const peers = [await f.device("First"), await f.device("Second")];
  const received: Record<string, unknown>[][] = [[], [], []];
  const owner = f.store.createLogin(60_000);
  const tokens = peers.map(
    (peer) => f.store.createCredential("Reports", [peer.deviceId], null).token,
  );
  for (let i = 0; i < received.length; i++) {
    const socket = new WebSocket(f.origin.replace("http:", "ws:") + webPath("/api/events"), {
      headers:
        i === 2
          ? { cookie: `kiteline_session_http=${owner.token}`, origin: f.origin }
          : { authorization: `Bearer ${tokens[i]}`, origin: f.origin },
    });
    socket.on("message", (data) => received[i]!.push(JSON.parse(data.toString())));
    await once(socket, "open");
    await expect.poll(() => received[i]!.length).toBe(2);
  }
  for (const peer of peers)
    peer.socket.send(
      JSON.stringify({
        type: "terminal.notice",
        deviceId: "spoofed",
        workspaceId: "work",
        sessionId: "source",
        name: peer.deviceId,
        notice: { title: "", body: "A report; with text", blocked: false },
        diagnostic: "not forwarded",
      }),
    );
  const reports = (index: number) =>
    received[index]!.filter((event) => event.type === "terminal.notice");
  await expect.poll(() => reports(2)).toHaveLength(2);
  for (let i = 0; i < 2; i++) {
    await expect
      .poll(() => reports(i))
      .toEqual([
        {
          type: "terminal.notice",
          noticeId: expect.any(String),
          receivedAt: expect.any(Number),
          deviceId: peers[i]!.deviceId,
          workspaceId: "work",
          sessionId: "source",
          name: peers[i]!.deviceId,
          notice: { title: "", body: "A report; with text", blocked: false },
        },
      ]);
    expect(
      peers[i]!.messages.filter((message) => message.type === "watch.set").every(
        (message) => (message.workspaceIds as string[]).length === 0,
      ),
    ).toBe(true);
  }
});

test("oversized browser report is dropped without disconnecting the device; malformed fields close it", async () => {
  const f = await fixture();
  const peer = await f.device();
  const login = f.store.createLogin(60_000);
  const socket = new WebSocket(f.origin.replace("http:", "ws:") + webPath("/api/events"), {
    headers: { cookie: `kiteline_session_http=${login.token}`, origin: f.origin },
  });
  const received: Record<string, unknown>[] = [];
  socket.on("message", (data) => received.push(JSON.parse(data.toString())));
  await once(socket, "open");
  const event = {
    type: "terminal.notice",
    workspaceId: "work",
    sessionId: "source",
    name: "Shell",
    notice: { title: "", body: "", blocked: false },
  };
  event.notice.body = "x".repeat(
    limits.controlMessageBytes - Buffer.byteLength(JSON.stringify(event)),
  );
  peer.socket.send(JSON.stringify(event));
  peer.socket.send(
    JSON.stringify({ ...event, notice: { title: "", body: "after oversized", blocked: true } }),
  );
  await expect
    .poll(() => received.filter((message) => message.type === "terminal.notice"))
    .toEqual([
      {
        ...event,
        noticeId: expect.any(String),
        receivedAt: expect.any(Number),
        deviceId: peer.deviceId,
        notice: { title: "", body: "after oversized", blocked: true },
      },
    ]);
  expect(f.app.connections.devices()[0]!.status).toBe("online");
  const closed = once(peer.socket, "close");
  peer.socket.send(JSON.stringify({ ...event, notice: { title: "", body: 1, blocked: true } }));
  expect((await closed)[0]).toBe(1008);
});
