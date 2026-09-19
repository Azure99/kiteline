import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createKitelineServer } from "../src/app.js";
import { Store } from "../src/store.js";
import type { ServerConfig } from "../src/config.js";
import { appVersion } from "@kiteline/shared/protocol";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dataDir = await mkdtemp("/var/tmp/kiteline-server-test-");
  const store = new Store(dataDir);
  const config: ServerConfig = {
    dataDir,
    publicUrl: "https://kiteline.test",
    hostname: "127.0.0.1",
    port: 0,
    webDir: dataDir,
    downloadsDir: dataDir,
    limits: {
      sessionLifetime: 60_000,
      draftTotalBytes: 1000,
      channelsPerDevice: 128,
      channelPairTimeout: 30_000,
      channelIdleTimeout: 120_000,
    },
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
  function call(
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    source = config.publicUrl,
  ) {
    return fetch(origin + path, {
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
    const socket = new WebSocket(
      origin.replace("http:", "ws:") + "/api/agent/control?protocolVersion=1",
      { headers: { authorization: `Bearer ${identity.deviceToken}` } },
    );
    const messages: Record<string, unknown>[] = [];
    socket.on("message", (data) =>
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        agentVersion: "test",
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
  return { app, store, config, call, device, origin, close };
}

test("last connected records successful hello, not metadata updates or disconnect", async () => {
  const f = await fixture();
  const peer = await f.device();
  const connected = f.store.devices()[0]!.lastSeenAt;
  expect(connected).not.toBeNull();
  const snapshot = f.app.connections.devices()[0]!.snapshot!;
  peer.socket.send(
    JSON.stringify({ type: "metadata.snapshot", snapshot: { ...snapshot, revision: 1 } }),
  );
  await expect.poll(() => f.store.devices()[0]!.snapshot?.revision).toBe(1);
  expect(f.store.devices()[0]!.lastSeenAt).toBe(connected);
  peer.socket.close();
  await expect.poll(() => f.app.connections.devices()[0]!.status).toBe("offline");
  expect(f.store.devices()[0]!.lastSeenAt).toBe(connected);
  const next = new WebSocket(
    f.origin.replace("http:", "ws:") + "/api/agent/control?protocolVersion=1",
    {
      headers: { authorization: `Bearer ${peer.deviceToken}` },
    },
  );
  await once(next, "open");
  expect(f.store.devices()[0]!.lastSeenAt).toBe(connected);
  next.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      agentVersion: "test",
      editorBytes: 2000,
      snapshot,
    }),
  );
  await expect.poll(() => f.app.connections.devices()[0]!.status).toBe("online");
  expect(f.store.devices()[0]!.lastSeenAt! > connected!).toBe(true);
});

test("WebSocket handshake distinguishes protocol, authentication, origin and missing channel", async () => {
  const f = await fixture();
  const login = f.store.createSession(60_000);
  for (const [path, headers, status] of [
    ["/api/agent/control?protocolVersion=2", {}, 426],
    ["/api/agent/control?protocolVersion=1", {}, 401],
    ["/api/events", { origin: "https://other.test" }, 403],
    [
      "/api/channels/missing/terminal",
      { origin: f.config.publicUrl, cookie: `kiteline_session=${login.token}` },
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

test("paired installer resources stream without login and never fall back to the SPA", async () => {
  const f = await fixture();
  const name = `kiteline-agent-${appVersion}-linux-arm64.tar.gz`;
  const path = `/downloads/agent/${appVersion}/${name}`;
  const bytes = Buffer.alloc(512 * 1024, 93);
  await writeFile(join(f.config.downloadsDir, name), bytes);
  const response = await f.call(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe(String(bytes.length));
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  const head = await f.call(path, "HEAD");
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(bytes.length));
  expect(await head.text()).toBe("");
  const interrupted = await f.call(path);
  await interrupted.body!.cancel();
  expect((await f.call("/healthz")).status).toBe(200);
  expect((await f.call("/downloads/agent/unknown/missing")).status).toBe(404);
  expect((await f.call("/install.sh")).status).toBe(404);
  expect((await f.call(path, "POST")).status).toBe(405);
  await writeFile(join(f.config.downloadsDir, "install.sh"), "#!/bin/sh\nexit 0\n");
  expect(await (await f.call("/install.sh")).text()).toBe("#!/bin/sh\nexit 0\n");
});

test("binding returns versioned installation commands from the configured public origin", async () => {
  const f = await fixture();
  const session = f.store.createSession(60_000);
  const response = await f.call("/api/bindings", "POST", {}, `kiteline_session=${session.token}`);
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value.commands.foreground).toContain(`${f.config.publicUrl}/install.sh`);
  expect(value.commands.foreground).toContain(`--version '${appVersion}' --code '${value.code}'`);
  expect(value.commands.foreground).not.toContain("--service");
  expect(value.commands.service).toContain("--service");
  expect(value.commands.bind).toContain("--if-unbound");
  expect(value.commands.bind).toContain("kiteline-agent check &&");
  expect(f.store.binding(value.bindingId).status).toBe("pending");
});

test("server stop closes a request whose JSON body has not finished", async () => {
  const f = await fixture();
  const login = f.store.createSession(60_000);
  const received = once(f.app.server, "request");
  const client = request(`${f.origin}/api/devices/test/rpc`, {
    method: "POST",
    headers: {
      origin: f.config.publicUrl,
      cookie: `kiteline_session=${login.token}`,
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

test("owner setup, cookie, binding consumption, revocation and password recovery", async () => {
  const f = await fixture();
  const setupToken = f.store.newSetupToken();
  const setup = await f.call("/api/setup", "POST", { setupToken, password: "test-password" });
  expect(setup.status).toBe(200);
  const setCookie = setup.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly; Secure; SameSite=Strict");
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
  expect((await f.call(`/api/devices/${first.deviceId}/revoke`, "POST", {}, cookie)).status).toBe(
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
  const login = f.store.createSession(150);
  const cookie = `kiteline_session=${login.token}`;
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
  const session = f.store.createSession(60_000);
  const old = f.call(
    `/api/devices/${peer.deviceId}/rpc`,
    "POST",
    { id: "old", method: "directories.mkdir", params: { absolutePath: "/test" } },
    `kiteline_session=${session.token}`,
  );
  await expect.poll(() => peer.messages.some((m) => m.id === "old")).toBe(true);
  const replacement = new WebSocket(
    f.origin.replace("http:", "ws:") + "/api/agent/control?protocolVersion=1",
    { headers: { authorization: `Bearer ${peer.deviceToken}` } },
  );
  await once(replacement, "open");
  expect(await (await old).json()).toMatchObject({ id: "old", outcome: "unknown" });
  await expect.poll(() => peer.socket.readyState).toBe(WebSocket.CLOSED);
});

test("logout before a streamed RPC body finishes prevents dispatch", async () => {
  const f = await fixture();
  const peer = await f.device();
  const login = f.store.createSession(60_000);
  const cookie = `kiteline_session=${login.token}`;
  const payload = JSON.stringify({
    id: "late",
    method: "directories.mkdir",
    params: { absolutePath: "/test" },
  });
  const req = request(f.origin + `/api/devices/${peer.deviceId}/rpc`, {
    method: "POST",
    headers: {
      origin: f.config.publicUrl,
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
  f.config.limits.channelPairTimeout = 800;
  f.config.limits.channelsPerDevice = 1;
  const peer = await f.device();
  const login = f.store.createSession(60000);
  const other = f.store.createSession(60000);
  const cookie = `kiteline_session=${login.token}`;
  const pending = f.call(
    `/api/devices/${peer.deviceId}/channels`,
    "POST",
    {
      kind: "terminal.attach",
      params: { workspaceId: "work", sessionId: "session", terminalProfile: "xterm-c1" },
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
        sessionId: "session",
        historyLines: 100,
        terminalProfile: "xterm-c1",
        terminalInputBytes: 262144,
        controlMessageBytes: 1048576,
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
        `kiteline_session=${other.token}`,
      )
    ).json(),
  ).toEqual({ found: false });
  const refused = new WebSocket(`${endpoint}/api/channels/${created.channelId}/terminal`, {
    headers: { cookie: `kiteline_session=${other.token}`, origin: f.config.publicUrl },
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
  const browser = new WebSocket(`${endpoint}/api/channels/${created.channelId}/terminal`, {
    headers: { cookie, origin: f.config.publicUrl },
  });
  const frames: unknown[] = [];
  browser.on("message", (data) => frames.push(JSON.parse(data.toString()) as unknown));
  await once(browser, "open");
  agent.send(JSON.stringify({ type: "ended", exitCode: 17 }));
  agent.close(1000);
  await once(browser, "close");
  expect(frames).toEqual([{ type: "ended", exitCode: 17 }]);
});
