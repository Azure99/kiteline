import { serverLimits } from "../src/limits.js";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { Agent as HttpAgent, request } from "node:http";
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createKitelineServer } from "../src/app.js";
import { Store } from "../src/store.js";
import type { ServerConfig } from "../src/config.js";
import {
  appVersion,
  limits,
  type AgentEnvironment,
  type AgentEvent,
} from "@kiteline/shared/protocol";

const environment: AgentEnvironment = {
  os: "linux",
  homePath: "/home/project",
  rootPaths: ["/"],
  cliPath: "/usr/local/bin/kiteline-agent",
  dataDir: "/var/tmp/kiteline-data",
  runDir: "/var/tmp/kiteline-run",
};

const agentPath = `/api/agent/control?appVersion=${appVersion}`;
const webPath = (path: string) =>
  `${path}${path.includes("?") ? "&" : "?"}appVersion=${appVersion}`;

const originalServerLimits = { ...serverLimits };
const originalInteractionTimeout = limits.interactionTimeout;
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    Object.assign(serverLimits, originalServerLimits);
    Object.assign(limits, { interactionTimeout: originalInteractionTimeout });
  }
});
async function fixture() {
  const dataDir = await mkdtemp("/var/tmp/kiteline-server-test-");
  const store = new Store(dataDir);
  const config: ServerConfig = {
    dataDir,
    trustProxyProto: false,
    hostname: "127.0.0.1",
    port: 0,
    webDir: dataDir,
    downloadsDir: dataDir,
  };
  const app = createKitelineServer(config, store);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    })());
  cleanups.push(close);
  function call(path: string, method = "GET", body?: unknown, cookie?: string, source = origin) {
    return fetch(origin + webPath(path), {
      method,
      headers: {
        origin: source,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function device(name = "Linux") {
    const binding = store.newBinding();
    const identity = store.bind(binding.code, name);
    const socket = new WebSocket(origin.replace("http:", "ws:") + agentPath, {
      headers: { authorization: `Bearer ${identity.deviceToken}` },
    });
    const messages: Record<string, unknown>[] = [];
    socket.on("message", (data) =>
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "hello",
        environment,
        editorBytes: 2000,
        snapshot: {
          schemaVersion: 1,
          revision: 0,
          workspaces: [],
          shortcuts: [],
          settings: { historyLines: 1000 },
        },
      }),
    );
    await expect
      .poll(() => app.connections.devices().find((d) => d.id === identity.deviceId)?.status)
      .toBe("online");
    return { ...identity, socket, messages, binding };
  }
  async function fileChannel(
    kind: "file.read" | "file.write",
    size: number,
    targetPath: unknown = "file",
  ) {
    const peer = await device();
    const login = store.createLogin(60_000);
    const connection = app.connections.agents.get(peer.deviceId)!;
    const pending = app.channels.create(peer.deviceId, login, kind, {
      workspaceId: "workspace",
      path: "file",
      purpose: kind === "file.read" ? "text" : "save",
      size,
      createOnly: true,
    });
    const socket = new WebSocket(
      origin.replace("http:", "ws:") +
        `/api/agent/channels/${pending.id}?connectionId=${connection.connectionId}`,
      { headers: { authorization: `Bearer ${peer.deviceToken}` } },
    );
    cleanups.push(() => socket.terminate());
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "ready",
        meta: {
          size,
          filename: "file",
          targetPath,
          contentType: "text/plain; charset=utf-8",
        },
      }),
    );
    await pending.ready;
    return {
      socket,
      id: pending.id,
      url: origin + webPath(`/api/channels/${pending.id}/content`),
      headers: { origin, cookie: `kiteline_session_http=${login.token}` },
    };
  }
  return { app, store, config, call, device, fileChannel, origin, close };
}

test.each(["file.read", "file.write"] as const)(
  "%s rejects invalid logical targets before browser pairing",
  async (kind) => {
    const f = await fixture();
    for (const target of [null, "/outside", "../other"])
      await expect(f.fileChannel(kind, 0, target)).rejects.toMatchObject({
        code: "invalid_argument",
      });
  },
);

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
      type: "hello",
      environment: windows,
      editorBytes: 2000,
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

test("channel envelope budget is checked before reserving a channel", async () => {
  const f = await fixture();
  Object.assign(serverLimits, { channelsPerDevice: 1 });
  const peer = await f.device();
  const login = f.store.createLogin(60_000);
  const cookie = `kiteline_session_http=${login.token}`;
  const body = {
    kind: "terminal.attach",
    params: {
      workspaceId: "work",
      sessionId: "session",
      padding: "",
    },
  };
  body.params.padding = "x".repeat(
    limits.controlMessageBytes - Buffer.byteLength(JSON.stringify(body)) - 10,
  );
  const rejected = await f.call(`/api/devices/${peer.deviceId}/channels`, "POST", body, cookie);
  expect(rejected.status).toBe(413);
  expect(await rejected.json()).toMatchObject({ error: { code: "limit_exceeded" } });
  expect(peer.messages.some((m) => m.type === "channel.open")).toBe(false);
  body.params.padding = "";
  const pending = f.call(`/api/devices/${peer.deviceId}/channels`, "POST", body, cookie);
  await expect.poll(() => peer.messages.some((m) => m.type === "channel.open")).toBe(true);
  const channel = peer.messages.find((m) => m.type === "channel.open")!;
  const cancelled = await f.call(`/api/channels/${channel.channelId}`, "DELETE", undefined, cookie);
  await cancelled.arrayBuffer();
  await (await pending).arrayBuffer();
  expect(f.app.connections.devices()[0]!.status).toBe("online");
});

test.each([
  { code: "unsupported", status: 400 },
  { code: "permission_denied", status: 403 },
  { code: "timeout", status: 504 },
])(
  "channel preparation reports $code through HTTP $status and releases the channel",
  async ({ code, status }) => {
    const f = await fixture();
    const peer = await f.device();
    const login = f.store.createLogin(60_000);
    const pending = f.call(
      `/api/devices/${peer.deviceId}/channels`,
      "POST",
      { kind: "file.read", params: { workspaceId: "work", path: "file", purpose: "text" } },
      `kiteline_session_http=${login.token}`,
    );
    await expect
      .poll(() => peer.messages.some((message) => message.type === "channel.open"))
      .toBe(true);
    const opening = peer.messages.find((message) => message.type === "channel.open")!;
    const socket = new WebSocket(
      f.origin.replace("http:", "ws:") +
        `/api/agent/channels/${String(opening.channelId)}?connectionId=${String(opening.connectionId)}`,
      { headers: { authorization: `Bearer ${peer.deviceToken}` } },
    );
    cleanups.push(() => socket.terminate());
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "error", code, message: "Could not prepare file" }));
    const response = await pending;
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: "Could not prepare file" } });
    await expect
      .poll(() =>
        peer.messages.some(
          (message) => message.type === "channel.cancel" && message.channelId === opening.channelId,
        ),
      )
      .toBe(true);
    const cancelled = await f.call(
      `/api/channels/${String(opening.channelId)}`,
      "DELETE",
      undefined,
      `kiteline_session_http=${login.token}`,
    );
    expect(await cancelled.json()).toEqual({ found: false });
    expect(f.app.connections.devices()[0]!.status).toBe("online");
  },
);

test("channel preparation and transfer preserve empty and long diagnostics without disconnecting the device", async () => {
  const f = await fixture();
  const peer = await f.device();
  const login = f.store.createLogin(60_000);
  const connection = f.app.connections.agents.get(peer.deviceId)!;
  for (const stage of ["prepare", "transfer"]) {
    for (const message of ["", "x".repeat(5000), null]) {
      const pending = f.app.channels.create(peer.deviceId, login, "file.read", {
        workspaceId: "workspace",
        path: "file",
        purpose: "text",
      });
      const ready = pending.ready.then(
        () => undefined,
        (error: unknown) => error,
      );
      const socket = new WebSocket(
        f.origin.replace("http:", "ws:") +
          `/api/agent/channels/${pending.id}?connectionId=${connection.connectionId}`,
        { headers: { authorization: `Bearer ${peer.deviceToken}` } },
      );
      socket.on("error", () => {});
      try {
        await once(socket, "open");
        let request: Promise<Response> | undefined;
        if (stage === "transfer") {
          socket.send(
            JSON.stringify({
              type: "ready",
              meta: {
                size: 1,
                filename: "file",
                targetPath: "file",
                contentType: "text/plain; charset=utf-8",
              },
            }),
          );
          expect(await ready).toBeUndefined();
          const start = once(socket, "message");
          request = f.call(
            `/api/channels/${pending.id}/content`,
            "GET",
            undefined,
            `kiteline_session_http=${login.token}`,
          );
          await start;
        }
        socket.send(JSON.stringify({ type: "error", code: "io_error", message }));
        const error = stage === "prepare" ? await ready : (await (await request!).json()).error;
        expect(error).toMatchObject(
          message === null ? { code: "invalid_argument" } : { code: "io_error", message },
        );
        expect(f.app.connections.devices()[0]!.status).toBe("online");
      } finally {
        socket.terminate();
      }
    }
  }
});

test.each(["bulk", "queued"])(
  "normal source close drains %s read frames through HTTP backpressure",
  async (mode) => {
    const highWaterMark = getDefaultHighWaterMark(false);
    if (mode === "queued") setDefaultHighWaterMark(false, 1);
    let f: Awaited<ReturnType<typeof fixture>>;
    try {
      f = await fixture();
    } finally {
      setDefaultHighWaterMark(false, highWaterMark);
    }
    const bytes = Buffer.alloc(mode === "queued" ? 16 * 1024 : 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const channel = await f.fileChannel("file.read", bytes.length);
    let held: import("node:http").ServerResponse | undefined;
    if (mode === "queued")
      f.app.server.prependOnceListener("request", (_request, response) => {
        held = response;
        response.cork();
      });
    const closed = once(channel.socket, "close");
    channel.socket.once("message", () => {
      for (let offset = 0; offset < bytes.length; offset += 8192)
        channel.socket.send(bytes.subarray(offset, offset + 8192));
      channel.socket.close(1000);
    });
    const pending = new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = request(channel.url, { headers: channel.headers }, resolve);
      req.once("error", reject);
      req.end();
    });
    void pending.catch(() => {});
    try {
      if (mode === "queued") {
        expect((await closed)[0]).toBe(1000);
        // Keep HTTP backpressure until the source close has reached the relay.
        await delay(20);
      }
    } finally {
      held?.uncork();
    }
    const response = await pending;
    expect(response.statusCode).toBe(200);
    response.pause();
    await delay(50);
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  },
);

test("write results validate errors, preserve partial details and report lost publication results as unknown", async () => {
  const f = await fixture();
  const replies = [
    { outcome: "unknown", error: null },
    { outcome: "partial", error: { code: "io_error", message: null } },
    { outcome: "failed", error: { code: "", message: "diagnostic" } },
    { outcome: ["unknown"], error: { code: "io_error", message: "diagnostic" } },
    {
      outcome: "partial",
      error: { code: "conflict", message: "", details: { changed: ["file"] } },
      result: { completed: 1 },
    },
    {
      outcome: "unknown",
      error: {
        code: "io_error",
        message: "diagnostic\n".repeat(1000) + "\0",
        details: { pending: true },
      },
      result: { target: "file" },
    },
    undefined,
  ];
  for (const [index, reply] of replies.entries()) {
    const channel = await f.fileChannel("file.write", 4);
    const chunks: Buffer[] = [];
    const stored = join(f.config.dataDir, `published-${index}`);
    channel.socket.on("message", (data, binary) => {
      if (binary) chunks.push(Buffer.from(data as Buffer));
      else if (JSON.parse(data.toString()).type === "end") {
        if (reply)
          channel.socket.send(
            JSON.stringify({ type: "result", reply: { id: channel.id, ...reply } }),
          );
        else void writeFile(stored, Buffer.concat(chunks)).then(() => channel.socket.close(1000));
      }
    });
    const response = await fetch(channel.url, {
      method: "PUT",
      headers: channel.headers,
      body: "text",
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    if (index < 4)
      expect(result).toMatchObject({
        id: channel.id,
        outcome: "unknown",
        error: { code: "invalid_argument" },
      });
    else if (reply) expect(result).toEqual({ id: channel.id, ...reply });
    else {
      expect(result).toMatchObject({
        id: channel.id,
        outcome: "unknown",
        error: { code: "offline" },
      });
      expect(await readFile(stored, "utf8")).toBe("text");
    }
    expect(Buffer.concat(chunks).toString()).toBe("text");
  }
});

test("WebSocket handshake distinguishes version, authentication, origin and missing channel", async () => {
  const f = await fixture();
  const login = f.store.createLogin(60_000);
  const device = f.store.bind(f.store.newBinding().code, "Protocol check");
  for (const [path, headers, status] of [
    ["/api/agent/control", { authorization: `Bearer ${device.deviceToken}` }, 426],
    ["/api/agent/control", {}, 401],
    [agentPath, {}, 401],
    ["/api/events", { origin: "https://other.test" }, 403],
    [
      webPath("/api/channels/missing/terminal"),
      { origin: f.origin, cookie: `kiteline_session_http=${login.token}` },
      404,
    ],
  ] as const) {
    const socket = new WebSocket(f.origin.replace("http:", "ws:") + path, { headers });
    socket.on("error", () => {});
    const response = await new Promise<number>((resolve) =>
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        socket.terminate();
        resolve(response.statusCode!);
      }),
    );
    expect(response).toBe(status);
    await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
  }
});

test("malformed static URL encoding returns a client error", async () => {
  const f = await fixture();
  const response = await f.call("/devices/%");
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_argument" } });
});

test("stale Web releases cannot use business endpoints but can read recovery information", async () => {
  const f = await fixture();
  const login = f.store.createLogin(60_000);
  const headers = { cookie: `kiteline_session_http=${login.token}`, origin: f.origin };
  for (const version of [undefined, "0.1.9-test"]) {
    const suffix = version ? `?appVersion=${version}` : "";
    for (const [path, method] of [
      ["/api/bindings", "POST"],
      ["/api/devices/d", "PATCH"],
      ["/api/devices/d", "DELETE"],
      ["/api/devices/d/rpc", "POST"],
      ["/api/devices/d/channels", "POST"],
      ["/api/devices/d/download", "GET"],
      ["/api/channels/c/content", "GET"],
      ["/api/channels/c/content", "PUT"],
    ]) {
      const response = await fetch(f.origin + path + suffix, { method, headers });
      expect(response.status).toBe(426);
      expect(response.headers.get("x-kiteline-version")).toBe(appVersion);
      expect(await response.json()).toMatchObject({
        error: {
          code: "version_mismatch",
          details: { component: "web", clientVersion: version ?? null, serverVersion: appVersion },
        },
      });
    }
    for (const path of ["/api/session", "/api/devices"]) {
      const response = await fetch(f.origin + path + suffix, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiteline-version")).toBe(appVersion);
      await response.arrayBuffer();
    }
    for (const path of ["/api/events", "/api/channels/c/terminal"]) {
      const ws = new WebSocket(f.origin.replace("http:", "ws:") + path + suffix, { headers });
      ws.on("error", () => {});
      const status = await new Promise<number>((resolve) => {
        ws.on("unexpected-response", (_request, response) => {
          response.resume();
          ws.terminate();
          resolve(response.statusCode!);
        });
      });
      expect(status).toBe(426);
      await expect.poll(() => ws.readyState).toBe(WebSocket.CLOSED);
    }
  }
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
        type: "hello",
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
      type: "hello",
      editorBytes: 1000,
      environment,
      snapshot: {
        schemaVersion: 1,
        revision: 0,
        workspaces: [],
        shortcuts: [],
        settings: { historyLines: 1000 },
      },
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

test("binding returns versioned installation commands from the current request origin", async () => {
  const f = await fixture();
  const login = f.store.createLogin(60_000);
  const response = await f.call(
    "/api/bindings",
    "POST",
    {},
    `kiteline_session_http=${login.token}`,
  );
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value.commands.linux.install).toContain(`${f.origin}/connect.sh`);
  expect(value.commands.macos.install).toContain(`| sh -s -- macos '${value.code}'`);
  expect(Object.keys(value.commands).sort()).toEqual(["linux", "macos", "windows"]);
  expect(Object.keys(value.commands.linux).sort()).toEqual(["bind", "install"]);
  expect(Object.keys(value.commands.windows).sort()).toEqual(["bind", "install"]);
  expect(value.commands.linux.bind).toContain(`bind --server '${f.origin}' --if-unbound`);
  expect(value.commands.linux.bind).toContain(value.code);
  expect(value.commands.macos.bind).toBe(value.commands.linux.bind);
  expect(f.store.binding(value.bindingId).status).toBe("pending");
  expect(value.commands.windows.install).toContain(`${f.origin}/connect.ps1`);
  expect(value.commands.windows.install).toContain(`-Code '${value.code}'`);
  expect(value.commands.windows.bind).toContain(`'${value.code}' | &`);
  expect(value.commands.windows.bind).toContain(`bind --server '${f.origin}' --if-unbound`);
});

test("server stop closes a request whose JSON body has not finished", async () => {
  const f = await fixture();
  const login = f.store.createLogin(60_000);
  const received = once(f.app.server, "request");
  const client = request(f.origin + webPath("/api/devices/test/rpc"), {
    method: "POST",
    headers: {
      origin: f.origin,
      cookie: `kiteline_session_http=${login.token}`,
      "content-type": "application/json",
      "content-length": 1024,
    },
  });
  client.on("error", () => {});
  client.write("{");
  await received;
  const stopping = f.close();
  try {
    expect(await Promise.race([stopping.then(() => true), delay(1000, false)])).toBe(true);
  } finally {
    client.destroy();
    await stopping;
  }
});

test("static resources keep their content and GET/HEAD types while navigation retains HTML", async () => {
  const f = await fixture();
  const text = Buffer.from("Sample text\n");
  const html = Buffer.from("<!doctype html><main>Kiteline</main>");
  const files = [
    ["sample.txt", text, "text/plain; charset=utf-8"],
    ["sample.md", text, "text/plain; charset=utf-8"],
    ["index.html", html, "text/html; charset=utf-8"],
    ["main.js", Buffer.from("console.log('kiteline')"), "text/javascript"],
    ["main.css", Buffer.from("body { color: black; }"), "text/css"],
    ["resource.bin", Buffer.from([0, 1, 2]), "application/octet-stream"],
  ] as const;
  for (const [name, bytes, type] of files) {
    await writeFile(join(f.config.webDir, name), bytes);
    for (const method of ["GET", "HEAD"]) {
      const response = await f.call(`/${name}`, method);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        method === "HEAD" ? Buffer.alloc(0) : bytes,
      );
    }
  }
  for (const path of ["/", "/devices"]) {
    const response = await f.call(path);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(html);
  }
  expect((await f.call("/assets/missing.js")).status).toBe(404);
  const post = await f.call("/sample.txt", "POST");
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, HEAD");
});

test("bodyless resources and complete JSON requests reuse their HTTP connection", async () => {
  const f = await fixture();
  const client = new HttpAgent({ keepAlive: true, maxSockets: 1 });
  cleanups.push(() => client.destroy());
  const sockets = new Set<unknown>();
  const call = (path: string, method = "GET", body?: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        f.origin + path,
        {
          agent: client,
          method,
          headers: {
            origin: f.origin,
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (text += chunk));
          response.on("error", reject);
          response.on("end", () => resolve({ status: response.statusCode!, text }));
        },
      );
      req.on("socket", (socket) => sockets.add(socket));
      req.on("error", reject);
      req.end(payload);
    });
  expect((await call("/connect.sh")).status).toBe(200);
  expect(await call("/connect.sh", "HEAD")).toEqual({ status: 200, text: "" });
  expect((await call("/healthz")).status).toBe(200);
  expect(
    (
      await call("/api/setup", "POST", {
        setupToken: f.store.newSetupToken(),
        password: "test-password",
      })
    ).status,
  ).toBe(200);
  expect((await call("/api/bootstrap")).text).toBe('{"initialized":true}');
  expect(sockets.size).toBe(1);
});

test("normal setup, login and binding accept JSON and retain the device across logout", async () => {
  const f = await fixture();
  const setup = await f.call("/api/setup", "POST", {
    setupToken: f.store.newSetupToken(),
    password: "test-password",
  });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const binding = await f.call("/api/bindings", "POST", {}, cookie);
  expect(binding.status).toBe(200);
  const { code, bindingId } = await binding.json();
  const bound = await f.call("/api/agent/bind", "POST", { code, name: "Test device" });
  expect(bound.status).toBe(200);
  const identity = await bound.json();
  expect(f.store.binding(bindingId).deviceId).toBe(identity.deviceId);
  const encoded = (id: string) => id.replaceAll("-", "%2D");
  const status = await f.call(`/api/bindings/${encoded(bindingId)}`, "GET", undefined, cookie);
  expect(await status.json()).toMatchObject({ status: "consumed", deviceId: identity.deviceId });
  expect(
    (
      await f.call(
        `/api/devices/${encoded(identity.deviceId)}`,
        "PATCH",
        { name: "Renamed device" },
        cookie,
      )
    ).status,
  ).toBe(200);
  expect((await f.call("/api/logout", "POST", {}, cookie)).status).toBe(200);
  const login = await f.call("/api/login", "POST", { password: "test-password" });
  expect(login.status).toBe(200);
  const devices = await f.call(
    "/api/devices",
    "GET",
    undefined,
    login.headers.get("set-cookie")!.split(";")[0],
  );
  expect(await devices.json()).toMatchObject({
    devices: [{ id: identity.deviceId, name: "Renamed device" }],
  });
});

test("owner setup, cookie, binding consumption, deletion and password recovery", async () => {
  const f = await fixture();
  const setupToken = f.store.newSetupToken();
  const setup = await f.call("/api/setup", "POST", { setupToken, password: "test-password" });
  expect(setup.status).toBe(200);
  const setCookie = setup.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly; SameSite=Strict");
  expect(setCookie).not.toContain("Secure");
  const cookie = setCookie.split(";")[0]!;
  expect(
    (await f.call("/api/setup", "POST", { setupToken, password: "test-password" })).status,
  ).toBe(409);
  expect((await f.call("/api/bindings", "POST", {}, cookie, "https://wrong.test")).status).toBe(
    403,
  );
  const first = await f.device();
  const second = await f.device("Other Linux");
  expect(f.store.binding(first.binding.bindingId)).toMatchObject({
    status: "consumed",
    deviceId: first.deviceId,
  });
  expect(() => f.store.bind(first.binding.code, "duplicate")).toThrow();
  expect((await f.call(`/api/devices/${first.deviceId}`, "DELETE", undefined, cookie)).status).toBe(
    200,
  );
  await expect.poll(() => first.socket.readyState).toBe(WebSocket.CLOSED);
  expect(f.app.connections.devices().find((d) => d.id === second.deviceId)?.status).toBe("online");
  expect(f.store.authenticateAgent(first.deviceToken)).toBeUndefined();
  await f.store.resetPassword("replacement-password");
  expect((await f.call("/api/session", "GET", undefined, cookie)).status).toBe(401);
  expect(await f.store.verifyPassword("replacement-password")).toBe(true);
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
      type: "hello",
      editorBytes: 2000,
      snapshot: f.app.connections.devices()[0]!.snapshot,
      environment,
    }),
  );
  expect(await (await old).json()).toMatchObject({ id: "old", outcome: "unknown" });
  await expect.poll(() => peer.socket.readyState).toBe(WebSocket.CLOSED);
});

test("logout before a streamed RPC body finishes prevents dispatch", async () => {
  const f = await fixture();
  const peer = await f.device();
  const login = f.store.createLogin(60_000);
  const cookie = `kiteline_session_http=${login.token}`;
  const payload = JSON.stringify({
    id: "late",
    method: "directories.mkdir",
    params: { absolutePath: "/test" },
  });
  const req = request(f.origin + webPath(`/api/devices/${peer.deviceId}/rpc`), {
    method: "POST",
    headers: {
      origin: f.origin,
      cookie,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  });
  const response = new Promise<number>((resolve, reject) => {
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
  });
  req.write(payload.slice(0, 10));
  expect((await f.call("/api/logout", "POST", {}, cookie)).status).toBe(200);
  req.end(payload.slice(10));
  expect(await response).toBe(401);
  expect(peer.messages.some((m) => m.id === "late")).toBe(false);
});

test("terminal channel has separate pairing deadlines, stays with its login, and forwards one final outcome", async () => {
  const f = await fixture();
  Object.assign(limits, { interactionTimeout: 800 });
  Object.assign(serverLimits, { channelsPerDevice: 1 });
  const peer = await f.device();
  const login = f.store.createLogin(60000);
  const other = f.store.createLogin(60000);
  const cookie = `kiteline_session_http=${login.token}`;
  const pending = f.call(
    `/api/devices/${peer.deviceId}/channels`,
    "POST",
    {
      kind: "terminal.attach",
      params: { workspaceId: "work", sessionId: "session" },
    },
    cookie,
  );
  await expect.poll(() => peer.messages.some((m) => m.type === "channel.open")).toBe(true);
  const opening = peer.messages.find((m) => m.type === "channel.open")!;
  const endpoint = f.origin.replace("http:", "ws:");
  const agent = new WebSocket(
    `${endpoint}/api/agent/channels/${String(opening.channelId)}?connectionId=${String(opening.connectionId)}`,
    { headers: { authorization: `Bearer ${peer.deviceToken}` } },
  );
  agent.on("error", () => {});
  await once(agent, "open");
  await delay(450);
  agent.send(
    JSON.stringify({
      type: "ready",
      meta: {
        terminalInputBytes: 262144,
      },
    }),
  );
  const created = (await (await pending).json()) as { channelId: string };
  expect(
    await (
      await f.call(
        `/api/channels/${created.channelId}`,
        "DELETE",
        undefined,
        `kiteline_session_http=${other.token}`,
      )
    ).json(),
  ).toEqual({ found: false });
  const refused = new WebSocket(endpoint + webPath(`/api/channels/${created.channelId}/terminal`), {
    headers: { cookie: `kiteline_session_http=${other.token}`, origin: f.origin },
  });
  const rejected = await new Promise<number>((resolve, reject) => {
    refused.on("error", reject);
    refused.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode!);
      refused.terminate();
    });
  });
  expect(rejected).toBe(404);
  await delay(420);
  const browser = new WebSocket(endpoint + webPath(`/api/channels/${created.channelId}/terminal`), {
    headers: { cookie, origin: f.origin },
  });
  const frames: unknown[] = [];
  browser.on("message", (data) => frames.push(JSON.parse(data.toString()) as unknown));
  await once(browser, "open");
  agent.send(JSON.stringify({ type: "ended", exitCode: 17 }));
  agent.close(1000);
  await once(browser, "close");
  expect(frames).toEqual([{ type: "ended", exitCode: 17 }]);
});
