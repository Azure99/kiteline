import { request } from "node:http";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { apiFixture, restoreServerLimits, webPath } from "./fixture.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    restoreServerLimits();
  }
});
async function fixture() {
  const base = await apiFixture();
  cleanups.push(base.close);
  return base;
}

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
