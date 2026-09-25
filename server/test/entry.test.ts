import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { request, type OutgoingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { appVersion } from "@kiteline/shared/protocol";
import { createKitelineServer } from "../src/app.js";
import { Store } from "../src/store.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(trustProxyProto: boolean) {
  const root = await mkdtemp("/var/tmp/kiteline-entries-");
  const store = new Store(root);
  const app = createKitelineServer(
    {
      dataDir: root,
      hostname: "127.0.0.1",
      port: 0,
      trustProxyProto,
      webDir: root,
      downloadsDir: root,
      limits: {
        sessionLifetime: 60_000,
        draftTotalBytes: 1000,
        channelsPerDevice: 128,
        channelPairTimeout: 1000,
        channelIdleTimeout: 1000,
      },
    },
    store,
  );
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const port = (app.server.address() as AddressInfo).port;
  cleanup.push(async () => {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  function call(
    path: string,
    headers: OutgoingHttpHeaders | string[],
    method = "GET",
    body?: unknown,
  ) {
    return new Promise<{ status: number; cookie?: string; text: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, headers, method }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part: string) => (text += part));
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode!, cookie: res.headers["set-cookie"]?.[0], text }),
        );
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function events(headers: Record<string, string>) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events?appVersion=${appVersion}`, {
      headers,
    });
    await once(socket, "open");
    return socket;
  }
  return { store, call, events, port };
}

test("request authority and explicit proxy trust determine HTTP and Upgrade origins", async () => {
  const direct = await fixture(false);
  expect(
    (await direct.call("/healthz", { host: "kiteline.test:8443", "x-forwarded-proto": "invalid" }))
      .status,
  ).toBe(200);
  const session = direct.store.createSession(60_000);
  const directHeaders = {
    host: "kiteline.test:8443",
    origin: "http://kiteline.test:8443",
    "x-forwarded-proto": "https",
    cookie: `kiteline_session_http=${session.token}`,
  };
  expect((await direct.call("/api/logout", directHeaders, "POST")).status).toBe(200);

  const f = await fixture(true);
  const login = f.store.createSession(60_000);
  for (const [host, protocol, origin] of [
    ["kiteline.test:8443", "http", "http://kiteline.test:8443"],
    ["KITELINE.test:80", "http", "http://kiteline.test"],
    ["kiteline.test:443", "https", "https://kiteline.test"],
    ["kiteline-v4.test:9443", "https", "https://kiteline-v4.test:9443"],
    ["[::1]:8443", "http", "http://[::1]:8443"],
  ]) {
    const headers = {
      host: host!,
      "x-forwarded-proto": protocol!,
      origin: origin!,
      cookie: `${protocol === "https" ? "kiteline_session" : "kiteline_session_http"}=${login.token}`,
    };
    const binding = await f.call(`/api/bindings?appVersion=${appVersion}`, headers, "POST");
    expect(binding.status).toBe(200);
    expect(JSON.parse(binding.text).commands.foreground).toContain(`${origin}/connect.sh`);
    const socket = await f.events(headers);
    socket.close();
    await once(socket, "close");
  }
  for (const host of [
    "one.test, two.test",
    "user@kiteline.test",
    "kiteline.test/path",
    "kiteline.test?x",
    "kiteline.test#x",
    "kiteline.test:70000",
  ]) {
    expect((await f.call("/healthz", { host })).status).toBe(400);
  }
  expect((await f.call("/healthz", ["Host", "one.test", "Host", "two.test"])).status).toBe(400);
  for (const value of ["https,http", "HTTPS", "ws", ""]) {
    expect(
      (await f.call("/healthz", { host: "kiteline.test", "x-forwarded-proto": value })).status,
    ).toBe(400);
  }
  expect((await f.call("/healthz", { host: "kiteline.test" })).status).toBe(200);

  for (const source of [
    undefined,
    "http://kiteline.test",
    "https://kiteline.test:8443",
    "http://other.test:8443",
  ]) {
    const headers = {
      host: "kiteline.test:8443",
      ...(source ? { origin: source } : {}),
      cookie: `kiteline_session_http=${login.token}`,
    };
    expect((await f.call(`/api/bindings?appVersion=${appVersion}`, headers, "POST")).status).toBe(
      403,
    );
    const socket = new WebSocket(`ws://127.0.0.1:${f.port}/api/events?appVersion=${appVersion}`, {
      headers,
    });
    socket.on("error", () => {});
    const status = await new Promise<number>((resolve) =>
      socket.once("unexpected-response", (_req, res) => {
        res.resume();
        socket.terminate();
        resolve(res.statusCode!);
      }),
    );
    expect(status).toBe(403);
    await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
  }
});

test("HTTP and HTTPS use separate cookies and logout closes only the selected login", async () => {
  const f = await fixture(true);
  const password = "entry-test-password";
  await f.store.setup(f.store.newSetupToken(), password);
  const httpHeaders = { host: "kiteline.test:8443", origin: "http://kiteline.test:8443" };
  const httpsHeaders = {
    host: "kiteline.test",
    origin: "https://kiteline.test",
    "x-forwarded-proto": "https",
  };
  const http = await f.call("/api/login", httpHeaders, "POST", { password });
  const https = await f.call("/api/login", httpsHeaders, "POST", { password });
  expect(http.status).toBe(200);
  expect(https.status).toBe(200);
  expect(http.cookie).toMatch(
    /^kiteline_session_http=.+; Path=\/; HttpOnly; SameSite=Strict; Expires=/,
  );
  expect(https.cookie).toMatch(
    /^kiteline_session=.+; Path=\/; HttpOnly; Secure; SameSite=Strict; Expires=/,
  );
  const httpCookie = http.cookie!.split(";")[0]!;
  const httpsCookie = https.cookie!.split(";")[0]!;
  const cookie = `${httpsCookie}; ${httpCookie}`;
  expect((await f.call("/api/session", { ...httpHeaders, cookie: httpsCookie })).status).toBe(401);
  expect((await f.call("/api/session", { ...httpsHeaders, cookie: httpCookie })).status).toBe(401);
  const httpEvents = await f.events({ ...httpHeaders, cookie });
  const httpsEvents = await f.events({ ...httpsHeaders, cookie });
  expect(
    (await f.call(`/api/logout?appVersion=${appVersion}`, { ...httpHeaders, cookie })).status,
  ).toBe(404);
  expect((await f.call("/api/session", { ...httpHeaders, cookie })).status).toBe(200);
  const closed = once(httpEvents, "close");
  const logout = await f.call("/api/logout", { ...httpHeaders, cookie }, "POST");
  expect(logout.status).toBe(200);
  expect(logout.cookie).toBe(
    "kiteline_session_http=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
  );
  await closed;
  expect(httpsEvents.readyState).toBe(WebSocket.OPEN);
  expect((await f.call("/api/session", { ...httpHeaders, cookie })).status).toBe(401);
  expect((await f.call("/api/session", { ...httpsHeaders, cookie })).status).toBe(200);
  const httpsClosed = once(httpsEvents, "close");
  expect((await f.call("/api/logout", { ...httpsHeaders, cookie }, "POST")).status).toBe(200);
  await httpsClosed;
});
