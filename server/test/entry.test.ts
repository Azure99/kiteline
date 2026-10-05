import { appVersion } from "@kiteline/shared/protocol";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { Agent as HttpAgent, request, type OutgoingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { agentPath, apiFixture, serverFixture, webPath } from "./fixture.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(trustProxyProto: boolean) {
  const { dataDir: root, store, app, port, close } = await serverFixture(trustProxyProto);
  cleanup.push(close);
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
  return { store, call, events, port, server: app.server, downloadsDir: root };
}

test("raw upgrade and CONNECT rejections drain responses and release half-open peers", async () => {
  const f = await fixture(false);
  const login = f.store.createLogin(60_000);
  const device = f.store.bind(f.store.newBinding().code, "Raw connection test");
  const redirect = `/proxy/${device.deviceId}/5173`;
  for (const [path, status] of [
    ["/nope", 404],
    ["/api/events", 426],
    ["/proxy/missing/5173/", 404],
    ["CONNECT", 501],
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
        : `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nOrigin: http://127.0.0.1:${f.port}\r\nCookie: kiteline_session_http=${login.token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
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

test("installer resources stream GET/HEAD, reject other methods and never fall back to the SPA", async () => {
  const f = await fixture(false);
  const origin = `http://127.0.0.1:${f.port}`;
  const linux = `kiteline-agent-${appVersion}-linux-arm64.tar.gz`;
  const windows = `kiteline-agent-${appVersion}-windows-amd64.zip`;
  const macos = `kiteline-agent-${appVersion}-macos-amd64.tar.gz`;
  const macosArm = `kiteline-agent-${appVersion}-macos-arm64.tar.gz`;
  for (const [path, file, type] of [
    [`/downloads/agent/${appVersion}/${linux}`, linux, "application/gzip"],
    [`/downloads/agent/${appVersion}/${windows}`, windows, "application/zip"],
    [
      `/downloads/agent/${appVersion}/${windows}.sha256`,
      `${windows}.sha256`,
      "text/plain; charset=utf-8",
    ],
    [`/downloads/agent/${appVersion}/${macos}`, macos, "application/gzip"],
    [
      `/downloads/agent/${appVersion}/${macos}.sha256`,
      `${macos}.sha256`,
      "text/plain; charset=utf-8",
    ],
    [`/downloads/agent/${appVersion}/${macosArm}`, macosArm, "application/gzip"],
    [
      `/downloads/agent/${appVersion}/${macosArm}.sha256`,
      `${macosArm}.sha256`,
      "text/plain; charset=utf-8",
    ],
    ["/install.sh", "install.sh", "text/plain; charset=utf-8"],
    ["/install.ps1", "install.ps1", "text/plain; charset=utf-8"],
  ]) {
    expect((await fetch(origin + path)).status).toBe(404);
    const bytes = file === linux ? Buffer.alloc(512 * 1024, 93) : Buffer.from(`resource ${file}`);
    await writeFile(join(f.downloadsDir, file!), bytes);
    const response = await fetch(origin + path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
    expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    const head = await fetch(origin + path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect(head.headers.get("cache-control")).toBe("no-cache");
    expect(await head.text()).toBe("");
    const post = await fetch(origin + path, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  }
  for (const path of ["/connect.sh", "/upgrade.sh", "/connect.ps1", "/upgrade.ps1"]) {
    const response = await fetch(origin + path);
    const script = await response.text();
    expect(response.status).toBe(200);
    expect(script).toContain(
      path === "/upgrade.sh"
        ? `${origin}/downloads/agent/${appVersion}/`
        : `${origin}/install.${path.endsWith(".ps1") ? "ps1" : "sh"}`,
    );
    expect(script).toContain(appVersion);
    expect(response.headers.get("content-disposition")).toContain(`filename="${path.slice(1)}"`);
    const head = await fetch(origin + path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength(script));
    expect(await head.text()).toBe("");
    expect((await fetch(origin + path, { method: "POST" })).status).toBe(405);
  }
  for (const path of [
    "/downloads/agent/unknown/missing",
    `/downloads/agent/old/${windows}`,
    `/downloads/agent/${appVersion}/kiteline-agent-${appVersion}-windows-arm64.zip`,
    `/downloads/agent/${appVersion}/${windows}/extra`,
    `/downloads/agent/old/${macos}`,
    `/downloads/agent/${appVersion}/${macos}/extra`,
  ])
    expect((await fetch(origin + path)).status).toBe(404);
  const interrupted = await fetch(origin + `/downloads/agent/${appVersion}/${linux}`);
  await interrupted.body!.cancel();
  expect((await fetch(origin + "/healthz")).status).toBe(200);
});

test("upgrade command recovery retains login and origin rules", async () => {
  const f = await fixture(true);
  const origin = `http://127.0.0.1:${f.port}`;
  expect((await fetch(origin + "/api/agent/upgrade-command")).status).toBe(401);

  const login = f.store.createLogin(60_000);
  const command = await f.call("/api/agent/upgrade-command?appVersion=old", {
    host: "kiteline.test:9443",
    "x-forwarded-proto": "https",
    cookie: `kiteline_session=${login.token}`,
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
  const directLogin = direct.store.createLogin(60_000);
  const directHeaders = {
    host: "kiteline.test:8443",
    origin: "http://kiteline.test:8443",
    "x-forwarded-proto": "https",
    cookie: `kiteline_session_http=${directLogin.token}`,
  };
  expect((await direct.call("/api/logout", directHeaders, "POST")).status).toBe(200);

  const f = await fixture(true);
  const login = f.store.createLogin(60_000);
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

async function httpFixture() {
  const base = await apiFixture();
  cleanup.push(base.close);
  return base;
}

test("WebSocket handshake distinguishes version, authentication, origin and missing channel", async () => {
  const f = await httpFixture();
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
  const f = await httpFixture();
  const response = await f.call("/devices/%");
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_argument" } });
});

test("stale Web releases cannot use business endpoints but can read recovery information", async () => {
  const f = await httpFixture();
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

test("binding returns versioned installation commands from the current request origin", async () => {
  const f = await httpFixture();
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
  const f = await httpFixture();
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
  const f = await httpFixture();
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
  const f = await httpFixture();
  const client = new HttpAgent({ keepAlive: true, maxSockets: 1 });
  cleanup.push(() => client.destroy());
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
