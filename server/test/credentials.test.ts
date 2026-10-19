import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { BlockList, type AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  controlCloseCodes,
  type BrowserEvent,
  type CliCredential,
} from "@kiteline/shared/protocol";
import { createKitelineServer } from "../src/app.js";
import { Store } from "../src/store.js";
import { agentPath, apiFixture, webPath } from "./fixture.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function fixture() {
  const base = await apiFixture();
  cleanups.push(base.close);
  const owner = base.store.createLogin(60_000);
  const ownerHeaders = { cookie: `kiteline_session_http=${owner.token}` };
  function call(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = ownerHeaders,
  ) {
    return fetch(base.origin + webPath(path), {
      method,
      headers: {
        origin: base.origin,
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function credential(name: string, deviceIds: string[], expiresAt: string | null = null) {
    const response = await call("/api/credentials", "POST", { name, deviceIds, expiresAt });
    expect(response.status).toBe(200);
    return (await response.json()) as { token: string; credential: CliCredential };
  }
  async function events(headers: Record<string, string>) {
    const socket = new WebSocket(base.origin.replace("http:", "ws:") + webPath("/api/events"), {
      headers: { origin: base.origin, ...headers },
    });
    cleanups.push(() => socket.terminate());
    const received: BrowserEvent[] = [];
    socket.on("message", (data) => received.push(JSON.parse(data.toString()) as BrowserEvent));
    await once(socket, "open");
    await expect.poll(() => received.some((event) => event.type === "devices.changed")).toBe(true);
    return { socket, received };
  }
  async function refusedSocket(path: string, headers: Record<string, string>) {
    const socket = new WebSocket(base.origin.replace("http:", "ws:") + path, {
      headers: { origin: base.origin, ...headers },
    });
    cleanups.push(() => socket.terminate());
    socket.on("error", () => {});
    return new Promise<number>((resolve, reject) => {
      socket.on("open", () => reject(new Error("Unauthorized WebSocket was accepted")));
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode!);
          socket.terminate();
        });
      });
    });
  }
  return { ...base, owner, ownerHeaders, call, credential, events, refusedSocket };
}

test("legacy owner sessions migrate and a credential with no expiry survives reopening SQLite", async () => {
  const dataDir = await mkdtemp("/var/tmp/kiteline-credentials-migration-");
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const token = "legacy-owner-session";
  const database = new DatabaseSync(join(dataDir, "kiteline.sqlite"));
  database.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL)");
  database
    .prepare("INSERT INTO sessions VALUES (?, ?)")
    .run(
      createHash("sha256").update(token).digest("hex"),
      new Date(Date.now() + 60_000).toISOString(),
    );
  database.close();
  const config = {
    dataDir,
    trustProxyProto: false,
    trustedProxies: new BlockList(),
    hostname: "127.0.0.1",
    port: 0,
    webDir: dataDir,
    downloadsDir: dataDir,
  };
  let store = new Store(dataDir);
  let app = createKitelineServer(config, store);
  cleanups.push(async () => {
    await app.close();
    store.close();
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  let origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const ownerHeaders = { cookie: `kiteline_session_http=${token}` };
  expect((await fetch(origin + webPath("/api/session"), { headers: ownerHeaders })).status).toBe(
    200,
  );
  const device = store.bind(store.newBinding().code, "Persistent device");
  const created = await fetch(origin + webPath("/api/credentials"), {
    method: "POST",
    headers: { origin, ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ name: "Persistent CLI", deviceIds: [device.deviceId], expiresAt: null }),
  });
  expect(created.status).toBe(200);
  const credential = (await created.json()) as { token: string; credential: CliCredential };
  await app.close();
  store.close();
  store = new Store(dataDir);
  app = createKitelineServer(config, store);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  expect((await fetch(origin + webPath("/api/session"), { headers: ownerHeaders })).status).toBe(
    200,
  );
  const session = await fetch(origin + webPath("/api/session"), {
    headers: bearer(credential.token),
  });
  expect(session.status).toBe(200);
  expect(await session.json()).toEqual({ kind: "cli", ...credential.credential });
});

test("owner issues selected-device credentials; CLI scope and credential types hold at HTTP and upgrade entries", async () => {
  const f = await fixture();
  const first = await f.device("First");
  const second = await f.device("Second");
  const third = await f.device("Third");
  const ids = [first.deviceId, second.deviceId];
  for (const input of [
    { name: "Missing expiry", deviceIds: ids },
    { name: "Expired", deviceIds: ids, expiresAt: new Date(0).toISOString() },
    { name: "Invalid expiry", deviceIds: ids, expiresAt: "tomorrow" },
    { name: "Expanded year", deviceIds: ids, expiresAt: "+010240-01-01T00:00:00.000Z" },
    { name: "Empty selection", deviceIds: [], expiresAt: null },
  ]) {
    expect((await f.call("/api/credentials", "POST", input)).status).toBe(400);
  }
  expect(
    (
      await f.call("/api/credentials", "POST", {
        name: "Unknown device",
        deviceIds: ["missing-device"],
        expiresAt: null,
      })
    ).status,
  ).toBe(404);
  const a = await f.credential("First two", ids);
  const b = await f.credential(
    "First and third",
    [first.deviceId, third.deviceId],
    new Date(Date.now() + 60_000).toISOString(),
  );
  const auth = bearer(a.token);
  expect(await (await f.call("/api/session", "GET", undefined, auth)).json()).toEqual({
    kind: "cli",
    ...a.credential,
  });
  const list = await (await f.call("/api/credentials")).json();
  expect(list).toEqual({ credentials: [b.credential, a.credential] });
  expect(JSON.stringify(list)).not.toContain(a.token);
  expect(JSON.stringify(list)).not.toContain(b.token);
  expect(await (await f.call("/api/devices", "GET", undefined, auth)).json()).toMatchObject({
    devices: ids.map((id) => ({ id })),
  });
  const tasks = await (await f.call("/api/tasks", "GET", undefined, auth)).json();
  expect(tasks.devices.map((device: { deviceId: string }) => device.deviceId)).toEqual(ids);
  expect(
    await (await f.call(`/api/tasks?deviceId=${first.deviceId}`, "GET", undefined, auth)).json(),
  ).toMatchObject({ devices: [{ deviceId: first.deviceId }] });
  const forbidden: [string, string, unknown?][] = [
    [`/api/tasks?deviceId=${third.deviceId}`, "GET"],
    [
      `/api/devices/${third.deviceId}/rpc`,
      "POST",
      { id: "blocked", method: "files.list", params: {} },
    ],
    [`/api/devices/${third.deviceId}/requests/blocked`, "DELETE"],
    [
      `/api/devices/${third.deviceId}/channels`,
      "POST",
      { kind: "terminal.attach", params: { workspaceId: "w", sessionId: "s" } },
    ],
    [`/api/devices/${third.deviceId}/download?workspaceId=w&path=file`, "GET"],
    [`/proxy/${third.deviceId}/5173/`, "GET"],
    [`/api/devices/${first.deviceId}`, "PATCH", { name: "Forbidden rename" }],
    [`/api/devices/${first.deviceId}`, "DELETE"],
    ["/api/bindings", "POST", {}],
    [`/api/bindings/${first.binding.bindingId}`, "GET"],
    ["/api/agent/upgrade-command", "GET"],
    ["/api/credentials", "GET"],
    ["/api/credentials", "POST", { name: "Delegation", deviceIds: ids, expiresAt: null }],
    [`/api/credentials/${b.credential.id}`, "DELETE"],
  ];
  for (const [path, method, body] of forbidden)
    expect((await f.call(path, method, body, auth)).status, `${method} ${path}`).toBe(403);
  expect(
    third.messages.some(
      (message) => message.type === "rpc.request" || message.type === "channel.open",
    ),
  ).toBe(false);
  expect(f.store.devices().map((device) => device.name)).toEqual(["First", "Second", "Third"]);
  expect(
    (await f.call("/api/session", "GET", undefined, { cookie: `kiteline_session_http=${a.token}` }))
      .status,
  ).toBe(401);
  for (const token of [f.owner.token, first.deviceToken])
    expect((await f.call("/api/session", "GET", undefined, bearer(token))).status).toBe(401);
  for (const token of [a.token, f.owner.token])
    for (const path of [agentPath, "/api/agent/channels/missing?connectionId=missing"])
      expect(await f.refusedSocket(path, bearer(token))).toBe(401);
  expect(await f.refusedSocket(webPath("/api/events"), bearer(first.deviceToken))).toBe(401);
  expect(await f.refusedSocket(webPath(`/proxy/${third.deviceId}/5173/`), auth)).toBe(403);
  for (const authorization of [auth.authorization, "Bearer project-authorization"])
    expect(
      await (
        await f.call("/api/devices", "GET", undefined, { ...f.ownerHeaders, authorization })
      ).json(),
    ).toMatchObject({ devices: [first, second, third].map((device) => ({ id: device.deviceId })) });

  const pending = f.call(
    `/api/devices/${first.deviceId}/rpc`,
    "POST",
    { id: "allowed", method: "directories.list", params: { absolutePath: "/" } },
    auth,
  );
  await expect.poll(() => first.messages.some((message) => message.id === "allowed")).toBe(true);
  expect(
    await (
      await f.call(
        `/api/devices/${first.deviceId}/requests/allowed`,
        "DELETE",
        undefined,
        bearer(b.token),
      )
    ).json(),
  ).toEqual({ found: false });
  expect(
    await (
      await f.call(`/api/devices/${first.deviceId}/requests/allowed`, "DELETE", undefined, auth)
    ).json(),
  ).toEqual({ found: true });
  await expect
    .poll(() =>
      first.messages.some((message) => message.type === "rpc.cancel" && message.id === "allowed"),
    )
    .toBe(true);
  first.socket.send(
    JSON.stringify({
      type: "rpc.result",
      reply: { id: "allowed", outcome: "succeeded", result: { entries: [] } },
    }),
  );
  expect(await (await pending).json()).toMatchObject({
    id: "allowed",
    outcome: "succeeded",
    result: { entries: [] },
  });
});

test("CLI event snapshots, task changes and watch subscriptions expose only selected devices", async () => {
  const f = await fixture();
  const peers = [await f.device("First"), await f.device("Second"), await f.device("Third")];
  for (const peer of peers) {
    peer.socket.send(
      JSON.stringify({
        type: "metadata.snapshot",
        snapshot: {
          schemaVersion: 1,
          revision: 1,
          workspaces: [{ id: "work", name: "Work", path: "/workspace" }],
          shortcuts: [],
          settings: { historyLines: 1000 },
        },
      }),
    );
  }
  await expect
    .poll(() => f.store.devices().every((device) => device.snapshot?.revision === 1))
    .toBe(true);
  const a = await f.credential(
    "First two",
    peers.slice(0, 2).map((peer) => peer.deviceId),
  );
  const b = await f.credential("Third only", [peers[2]!.deviceId]);
  const first = await f.events(bearer(a.token));
  const other = await f.events(bearer(b.token));
  const owner = await f.events(f.ownerHeaders);
  expect(first.received[0]).toMatchObject({
    type: "devices.changed",
    devices: peers.slice(0, 2).map((peer) => ({ id: peer.deviceId })),
  });
  expect(other.received[0]).toMatchObject({
    type: "devices.changed",
    devices: [{ id: peers[2]!.deviceId }],
  });
  first.socket.send(
    JSON.stringify({
      type: "watch.set",
      targets: [{ deviceId: peers[0]!.deviceId, workspaceId: "work" }],
    }),
  );
  other.socket.send(
    JSON.stringify({
      type: "watch.set",
      targets: [{ deviceId: peers[2]!.deviceId, workspaceId: "work" }],
    }),
  );
  for (const peer of [peers[0]!, peers[2]!])
    await expect
      .poll(() =>
        peer.messages.some(
          (message) =>
            message.type === "watch.set" && (message.workspaceIds as string[]).includes("work"),
        ),
      )
      .toBe(true);
  for (const peer of peers) {
    peer.socket.send(JSON.stringify({ type: "tasks.snapshot", revision: 1, items: [] }));
    peer.socket.send(JSON.stringify({ type: "sessions.changed", workspaceId: "work" }));
  }
  await expect
    .poll(() => owner.received.filter((event) => event.type === "tasks.changed"))
    .toHaveLength(3);
  await expect
    .poll(() => first.received.filter((event) => event.type === "tasks.changed"))
    .toHaveLength(2);
  await expect
    .poll(() => other.received.filter((event) => event.type === "tasks.changed"))
    .toHaveLength(1);
  await expect
    .poll(() => first.received.filter((event) => event.type === "sessions.changed"))
    .toEqual([{ type: "sessions.changed", deviceId: peers[0]!.deviceId, workspaceId: "work" }]);
  await expect
    .poll(() => other.received.filter((event) => event.type === "sessions.changed"))
    .toEqual([{ type: "sessions.changed", deviceId: peers[2]!.deviceId, workspaceId: "work" }]);
  expect(
    first.received.filter((event) => event.type === "tasks.changed").map((event) => event.deviceId),
  ).toEqual(peers.slice(0, 2).map((peer) => peer.deviceId));
  expect(
    other.received.filter((event) => event.type === "tasks.changed").map((event) => event.deviceId),
  ).toEqual([peers[2]!.deviceId]);
  expect(
    await (await f.call("/api/tasks", "GET", undefined, bearer(a.token))).json(),
  ).toMatchObject({
    devices: peers
      .slice(0, 2)
      .map((peer) => ({ deviceId: peer.deviceId, snapshot: { revision: 1 } })),
  });
  await f.call(`/api/devices/${peers[2]!.deviceId}`, "PATCH", { name: "Third renamed" });
  await expect
    .poll(
      () =>
        other.received.filter((event) => event.type === "devices.changed").at(-1)?.devices[0]?.name,
    )
    .toBe("Third renamed");
  await expect
    .poll(() => first.received.filter((event) => event.type === "devices.changed").length)
    .toBe(2);
  expect(
    first.received
      .filter((event) => event.type === "devices.changed")
      .every((event) =>
        event.devices.every((device) => a.credential.deviceIds.includes(device.id)),
      ),
  ).toBe(true);
  const rejected = await f.events(bearer(a.token));
  const closed = once(rejected.socket, "close");
  rejected.socket.send(
    JSON.stringify({
      type: "watch.set",
      targets: [{ deviceId: peers[2]!.deviceId, workspaceId: "work" }],
    }),
  );
  expect((await closed)[0]).toBe(1008);
  expect(first.socket.readyState).toBe(WebSocket.OPEN);
  expect(other.socket.readyState).toBe(WebSocket.OPEN);
});

test("revocation, absolute expiry and self logout close only the credential's event sockets", async () => {
  const f = await fixture();
  const peer = await f.device();
  const a = await f.credential("Revoked", [peer.deviceId]);
  const b = await f.credential("Retained", [peer.deviceId]);
  const first = await f.events(bearer(a.token));
  const other = await f.events(bearer(b.token));
  const owner = await f.events(f.ownerHeaders);
  const opening = f.call(
    `/api/devices/${peer.deviceId}/channels`,
    "POST",
    { kind: "terminal.attach", params: { workspaceId: "work", sessionId: "session" } },
    bearer(a.token),
  );
  await expect
    .poll(() => peer.messages.some((message) => message.type === "channel.open"))
    .toBe(true);
  const channel = peer.messages.find((message) => message.type === "channel.open")!;
  const agent = new WebSocket(
    `${f.origin.replace("http:", "ws:")}/api/agent/channels/${String(channel.channelId)}?connectionId=${String(channel.connectionId)}`,
    { headers: bearer(peer.deviceToken) },
  );
  cleanups.push(() => agent.terminate());
  await once(agent, "open");
  agent.send(JSON.stringify({ type: "ready", meta: { terminalInputBytes: 262144 } }));
  expect((await opening).status).toBe(200);
  const terminalPath = webPath(`/api/channels/${String(channel.channelId)}/terminal`);
  expect(await f.refusedSocket(terminalPath, bearer(b.token))).toBe(404);
  const terminal = new WebSocket(f.origin.replace("http:", "ws:") + terminalPath, {
    headers: { origin: f.origin, ...bearer(a.token) },
  });
  cleanups.push(() => terminal.terminate());
  await once(terminal, "open");
  let closed = once(first.socket, "close");
  expect(await (await f.call(`/api/credentials/${a.credential.id}`, "DELETE")).json()).toEqual({
    revoked: true,
  });
  expect((await closed)[0]).toBe(controlCloseCodes.accessRevoked);
  await expect.poll(() => terminal.readyState).toBe(WebSocket.CLOSED);
  await expect.poll(() => agent.readyState).toBe(WebSocket.CLOSED);
  expect((await f.call("/api/session", "GET", undefined, bearer(a.token))).status).toBe(401);
  expect(other.socket.readyState).toBe(WebSocket.OPEN);
  expect(owner.socket.readyState).toBe(WebSocket.OPEN);
  const expiring = await f.credential(
    "Expires",
    [peer.deviceId],
    new Date(Date.now() + 500).toISOString(),
  );
  const expired = await f.events(bearer(expiring.token));
  await expect.poll(() => expired.socket.readyState, { timeout: 2500 }).toBe(WebSocket.CLOSED);
  expect((await f.call("/api/session", "GET", undefined, bearer(expiring.token))).status).toBe(401);
  expect((await f.call("/api/session", "GET", undefined, bearer(b.token))).status).toBe(200);
  expect(other.socket.readyState).toBe(WebSocket.OPEN);
  expect(owner.socket.readyState).toBe(WebSocket.OPEN);
  closed = once(other.socket, "close");
  const logout = await f.call("/api/logout", "POST", {}, bearer(b.token));
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toBeNull();
  expect((await closed)[0]).toBe(controlCloseCodes.accessRevoked);
  expect((await f.call("/api/session", "GET", undefined, bearer(b.token))).status).toBe(401);
  expect(owner.socket.readyState).toBe(WebSocket.OPEN);
  expect((await f.call("/api/session")).status).toBe(200);
});

test("revoking a credential while its RPC body is streaming prevents dispatch", async () => {
  const f = await fixture();
  const peer = await f.device();
  const cli = await f.credential("Streamed request", [peer.deviceId]);
  const payload = JSON.stringify({
    id: "late-cli",
    method: "directories.mkdir",
    params: { absolutePath: "/test" },
  });
  const admitted = once(f.app.server, "request");
  const req = request(f.origin + webPath(`/api/devices/${peer.deviceId}/rpc`), {
    method: "POST",
    headers: {
      origin: f.origin,
      ...bearer(cli.token),
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
  await admitted;
  expect((await f.call(`/api/credentials/${cli.credential.id}`, "DELETE")).status).toBe(200);
  req.end(payload.slice(10));
  expect(await response).toBe(401);
  expect(peer.messages.some((message) => message.id === "late-cli")).toBe(false);
});

test("a streamed owner request cannot fall back to its CLI Bearer after owner logout", async () => {
  const f = await fixture();
  const peer = await f.device();
  const cli = await f.credential("Fallback CLI", [peer.deviceId]);
  const payload = JSON.stringify({
    name: "Forbidden delegation",
    deviceIds: [peer.deviceId],
    expiresAt: null,
  });
  const admitted = once(f.app.server, "request");
  const req = request(f.origin + webPath("/api/credentials"), {
    method: "POST",
    headers: {
      origin: f.origin,
      ...f.ownerHeaders,
      ...bearer(cli.token),
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
  await admitted;
  expect((await f.call("/api/logout", "POST", {})).status).toBe(200);
  req.end(payload.slice(10));
  expect(await response).toBe(401);
  expect(f.store.credentials()).toEqual([cli.credential]);
  expect((await f.call("/api/session", "GET", undefined, bearer(cli.token))).status).toBe(200);
});
