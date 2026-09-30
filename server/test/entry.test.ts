import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { request, type OutgoingHttpHeaders } from "node:http";
import { connect, type AddressInfo } from "node:net";
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
  return { store, call, events, port, server: app.server };
}

test("raw upgrade and CONNECT rejections drain responses and release half-open peers", async () => {
  const f = await fixture(false);
  const session = f.store.createSession(60_000);
  const device = f.store.bind(f.store.newBinding().code, "Raw connection test");
  const redirect = `/proxy/${device.deviceId}/5173`;
  for (const [path, status] of [
    ["/nope", 404],
    ["/api/events", 426],
    ["/proxy/missing/5173/", 404],
    ["CONNECT", 405],
    [redirect, 308],
  ] as const) {
    const socket = connect({ host: "127.0.0.1", port: f.port, allowHalfOpen: true });
    cleanup.push(async () => {
      socket.destroy();
    });
    await once(socket, "connect");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = once(socket, "end");
    socket.write(
      path === "CONNECT"
        ? "CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n"
        : `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nOrigin: http://127.0.0.1:${f.port}\r\nCookie: kiteline_session_http=${session.token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    );
    await ended;
    const response = Buffer.concat(chunks).toString();
    const boundary = response.indexOf("\r\n\r\n");
    expect(boundary).toBeGreaterThan(0);
    const head = response.slice(0, boundary);
    const body = response.slice(boundary + 4);
    expect(head).toContain(`HTTP/1.1 ${status} `);
    const length = /content-length: (\d+)/i.exec(head);
    expect(Buffer.byteLength(body)).toBe(length ? Number(length[1]) : 0);
    if (status === 426) expect(JSON.parse(body).error.code).toBe("version_mismatch");
    if (status === 308) expect(head).toContain(`location: ${redirect}/`);
  }
  await expect
    .poll(
      () =>
        new Promise<number>((resolve, reject) =>
          f.server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
        ),
    )
    .toBe(0);
});

test("a reset during a raw rejection leaves the server available", async () => {
  const f = await fixture(false);
  for (const path of ["/nope", "/api/events", "/proxy/missing/5173/", "CONNECT"]) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const socket = connect(f.port, "127.0.0.1");
      socket.on("error", () => {});
      await once(socket, "connect");
      socket.write(
        path === "CONNECT"
          ? "CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n"
          : `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.resetAndDestroy();
      await closed;
    }
  }
  expect((await f.call("/healthz", { host: `127.0.0.1:${f.port}` })).status).toBe(200);
});

test("upgrade scripts are public while command recovery retains login and origin rules", async () => {
  const f = await fixture(true);
  const origin = `http://127.0.0.1:${f.port}`;
  const response = await fetch(origin + "/upgrade.sh");
  const script = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(script));
  expect(response.headers.get("content-disposition")).toContain('filename="upgrade.sh"');
  expect(script).toContain(`${origin}/downloads/agent/${appVersion}/`);
  expect(script).toContain("kiteline-agent upgrade --archive");
  expect(script).not.toContain("--yes");
  expect(script).not.toContain("kiteline-agent bind");
  const head = await fetch(origin + "/upgrade.sh", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(response.headers.get("content-length"));
  expect(await head.text()).toBe("");
  const post = await fetch(origin + "/upgrade.sh", { method: "POST" });
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, HEAD");
  expect((await fetch(origin + "/api/agent/upgrade-command")).status).toBe(401);

  const session = f.store.createSession(60_000);
  const command = await f.call("/api/agent/upgrade-command?appVersion=old", {
    host: "kiteline.test:9443",
    "x-forwarded-proto": "https",
    cookie: `kiteline_session=${session.token}`,
  });
  expect(command.status).toBe(200);
  const upgrade = JSON.parse(command.text) as { version: string; commands: Record<string, string> };
  expect(upgrade.version).toBe(appVersion);
  expect(Object.keys(upgrade).sort()).toEqual(["commands", "version"]);
  expect(upgrade.commands.linux).toContain("https://kiteline.test:9443/upgrade.sh");
  expect(upgrade.commands.linux).toContain("--proto '=https' --proto-redir '=https'");
  expect(upgrade.commands.windows).toContain("https://kiteline.test:9443/upgrade.ps1");
  expect(upgrade.commands.macos).toContain("https://kiteline.test:9443/upgrade.sh");
  expect(upgrade.commands.macos).toContain("--proto '=https' --proto-redir '=https'");
  expect(upgrade.commands.macos).toContain("--platform macos");
  for (const command of Object.values(upgrade.commands)) {
    expect(command).not.toContain("--yes");
    expect(command).not.toContain("kiteline-agent bind");
  }
});

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
    expect(JSON.parse(binding.text).commands.linux.install).toContain(`${origin}/connect.sh`);
    expect(JSON.parse(binding.text).commands.windows.install).toContain(`${origin}/connect.ps1`);
    expect(JSON.parse(binding.text).commands.macos.install).toContain(`${origin}/connect.sh`);
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
