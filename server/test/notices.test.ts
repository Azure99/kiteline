import { type BrowserEvent } from "@kiteline/shared/protocol";
import { once } from "node:events";
import { request } from "node:http";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { apiFixture, webPath } from "./fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await apiFixture();
  cleanups.push(f.close);
  return { ...f, cookie: `kiteline_session_http=${f.store.createLogin(60_000).token}` };
}
async function browser(origin: string, headers: Record<string, string>) {
  const socket = new WebSocket(origin.replace("http:", "ws:") + webPath("/api/events"), {
    headers: { origin, ...headers },
  });
  const events: BrowserEvent[] = [];
  socket.on("message", (data) => events.push(JSON.parse(data.toString())));
  await expect.poll(() => events.some((event) => event.type === "notices.reset")).toBe(true);
  return { socket, events };
}
const reports = (events: BrowserEvent[]) =>
  events.filter((event) => event.type === "terminal.notice");
const cleared = (events: BrowserEvent[]) =>
  events.filter((event) => event.type === "notice.cleared");
function report(socket: WebSocket, body: string, sessionId = "x") {
  socket.send(
    JSON.stringify({
      type: "terminal.notice",
      workspaceId: "work",
      sessionId,
      name: sessionId,
      notice: { title: "", body, blocked: false },
    }),
  );
}

test("new connections and explicit sync receive only the latest permitted reports with stable IDs", async () => {
  const f = await fixture();
  const first = await f.device("First");
  const second = await f.device("Second");
  const live = await browser(f.origin, { cookie: f.cookie });
  report(first.socket, "old");
  report(first.socket, "latest");
  report(first.socket, "other session", "y");
  report(second.socket, "other device");
  await expect.poll(() => reports(live.events)).toHaveLength(4);
  const latest = reports(live.events).filter((event) => event.notice.body !== "old");
  expect(new Set(reports(live.events).map((event) => event.noticeId)).size).toBe(4);
  expect(latest.every((event) => event.receivedAt > 0)).toBe(true);
  const restored = await browser(f.origin, { cookie: f.cookie });
  await expect.poll(() => reports(restored.events)).toHaveLength(3);
  expect(reports(restored.events)).toEqual(expect.arrayContaining(latest));

  const token = f.store.createCredential("First only", [first.deviceId], null).token;
  const restricted = await browser(f.origin, { authorization: `Bearer ${token}` });
  const permitted = latest.filter((event) => event.deviceId === first.deviceId);
  await expect.poll(() => reports(restricted.events)).toEqual(permitted);
  restricted.events.length = 0;
  restricted.socket.send(JSON.stringify({ type: "notices.sync" }));
  await expect.poll(() => reports(restricted.events)).toEqual(permitted);
  expect(restricted.events[0]).toEqual({ type: "notices.reset" });
});

test("activation clears the report present when the server processes the request across all permitted clients", async () => {
  const f = await fixture();
  const peer = await f.device();
  const other = await f.device("Other");
  const a = await browser(f.origin, { cookie: f.cookie });
  const b = await browser(f.origin, { cookie: f.cookie });
  const token = f.store.createCredential("Other only", [other.deviceId], null).token;
  const restricted = await browser(f.origin, { authorization: `Bearer ${token}` });
  report(peer.socket, "before");
  await expect.poll(() => reports(a.events)).toHaveLength(1);
  const path = `/api/devices/${peer.deviceId}/notices/activate`;
  const body = JSON.stringify({ workspaceId: "work", sessionId: "x" });
  const denied = await fetch(f.origin + webPath(path), {
    method: "POST",
    headers: {
      origin: f.origin,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body,
  });
  expect(denied.status).toBe(403);
  expect(cleared(a.events)).toEqual([]);
  expect((await f.call(path, "POST", { workspaceId: "work" }, f.cookie)).status).toBe(400);

  // Keep the real HTTP body incomplete so a newer report arrives before activation is processed.
  const activation = request(f.origin + webPath(path), {
    method: "POST",
    headers: {
      origin: f.origin,
      cookie: f.cookie,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  const response = once(activation, "response");
  activation.write(body.slice(0, -1));
  report(peer.socket, "while request is in flight");
  await expect.poll(() => reports(a.events)).toHaveLength(2);
  expect(cleared(a.events)).toEqual([]);
  const current = reports(a.events)[1]!;
  activation.end(body.slice(-1));
  const [reply] = await response;
  reply.resume();
  expect(reply.statusCode).toBe(200);
  const expected = {
    type: "notice.cleared",
    deviceId: peer.deviceId,
    workspaceId: "work",
    sessionId: "x",
    noticeId: current.noticeId,
  };
  await expect.poll(() => cleared(a.events)).toEqual([expected]);
  await expect.poll(() => cleared(b.events)).toEqual([expected]);
  expect(reports(restricted.events)).toEqual([]);
  expect(cleared(restricted.events)).toEqual([]);

  report(peer.socket, "after activation");
  await expect.poll(() => reports(a.events)).toHaveLength(3);
  const newest = reports(a.events)[2]!;
  expect(newest.noticeId).not.toBe(current.noticeId);
  const restored = await browser(f.origin, { cookie: f.cookie });
  await expect.poll(() => reports(restored.events)).toEqual([newest]);
  expect(cleared(a.events)).toEqual([expected]);
});

test("session updates and disconnect retain history, while deleting a device removes its reports", async () => {
  const f = await fixture();
  const peer = await f.device();
  const live = await browser(f.origin, { cookie: f.cookie });
  report(peer.socket, "historical report");
  await expect.poll(() => reports(live.events)).toHaveLength(1);
  const historical = reports(live.events)[0]!;
  peer.socket.send(JSON.stringify({ type: "sessions.changed", workspaceId: "work" }));
  peer.socket.close();
  await expect.poll(() => f.app.connections.devices()[0]!.status).toBe("offline");
  const restored = await browser(f.origin, { cookie: f.cookie });
  await expect.poll(() => reports(restored.events)).toEqual([historical]);
  expect(
    (await f.call(`/api/devices/${peer.deviceId}`, "DELETE", undefined, f.cookie)).status,
  ).toBe(200);
  await expect
    .poll(() => cleared(restored.events).map((event) => event.noticeId))
    .toEqual([historical.noticeId]);
  const afterDelete = await browser(f.origin, { cookie: f.cookie });
  expect(reports(afterDelete.events)).toEqual([]);
});
