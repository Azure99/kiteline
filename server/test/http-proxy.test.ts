import { afterEach, expect, test } from "vitest";
import {
  createServer,
  request,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from "node:http";
import { createServer as secureServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { connect, type AddressInfo, type Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { createKitelineServer } from "../src/app.js";
import { Store } from "../src/store.js";
import type { ServerConfig } from "../src/config.js";
import { Agent } from "../../agent/src/control.js";
import { defaultAgentLimits } from "../../agent/src/config.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server, host = "127.0.0.1", port = 0) {
  server.listen(port, host);
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}
async function fixture(handler: RequestListener, channels = 128) {
  const root = await mkdtemp("/var/tmp/kiteline-http-");
  const keyFile = join(root, "key.pem"),
    certFile = join(root, "cert.pem");
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout",
    keyFile,
    "-out",
    certFile,
  ]);
  const key = await readFile(keyFile),
    cert = await readFile(certFile);
  const originalCA = getCACertificates();
  setDefaultCACertificates([...originalCA, cert]);
  const store = new Store(root);
  const config: ServerConfig = {
    dataDir: root,
    trustProxyProto: true,
    hostname: "127.0.0.1",
    port: 0,
    webDir: root,
    downloadsDir: root,
    limits: {
      sessionLifetime: 60_000,
      draftTotalBytes: 1000,
      channelsPerDevice: channels,
      channelPairTimeout: 1000,
      channelIdleTimeout: 100,
    },
  };
  const kiteline = createKitelineServer(config, store);
  const port = await listen(kiteline.server);
  const tls = secureServer({ key, cert }, (req, res) => {
    req.headers["x-forwarded-proto"] = "https";
    kiteline.server.emit("request", req, res);
  });
  tls.on("upgrade", (req, socket, head) => {
    req.headers["x-forwarded-proto"] = "https";
    kiteline.server.emit("upgrade", req, socket, head);
  });
  const entryOrigin = `https://127.0.0.1:${await listen(tls)}`;
  const upstream = createServer(handler),
    upstreamPort = await listen(upstream);
  const identity = store.bind(store.newBinding().code, "Proxy Device");
  const home = join(root, "agent"),
    run = join(home, "run");
  await mkdir(run, { recursive: true });
  const agent = new Agent(
    {
      dataDir: home,
      runDir: run,
      shell: "/bin/sh",
      limits: {
        ...defaultAgentLimits,
        channelPairTimeout: 1000,
        channelIdleTimeout: 100,
        channelsPerDevice: channels,
      },
    },
    { ...identity, server: entryOrigin },
  );
  await agent.start();
  cleanup.push(async () => {
    await agent.close();
    if (kiteline.server.listening) await kiteline.close();
    tls.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => tls.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    store.close();
    setDefaultCACertificates(originalCA);
    await rm(root, { recursive: true, force: true });
  });
  await expect.poll(() => kiteline.connections.devices()[0]?.status).toBe("online");
  const login = store.createSession(60_000);
  const cookie = `kiteline_session=${login.token}`;
  const browserHeaders = {
    cookie,
    origin: entryOrigin,
    host: new URL(entryOrigin).host,
    "x-forwarded-proto": "https",
  };
  const prefix = `/proxy/${identity.deviceId}/${upstreamPort}`;
  function open(path = prefix + "/", method = "GET", headers: Record<string, string> = {}) {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: { ...browserHeaders, ...headers },
    });
    const result = new Promise<IncomingMessage>((resolve, reject) => {
      req.once("response", resolve);
      req.once("error", reject);
    });
    return { req, result };
  }
  async function call(
    path = prefix + "/",
    method = "GET",
    headers: Record<string, string> = {},
    body?: string,
  ) {
    const { req, result } = open(path, method, headers);
    req.end(body);
    const res = await result;
    const parts: Buffer[] = [];
    for await (const chunk of res) parts.push(chunk);
    return { status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString() };
  }
  return {
    root,
    kiteline,
    store,
    config,
    agent,
    upstream,
    upstreamPort,
    port,
    identity,
    login,
    cookie,
    entryOrigin,
    browserHeaders,
    prefix,
    open,
    call,
  };
}

test("real HTTP tunnel preserves raw paths, bodies, finite header rules and application errors", async () => {
  const f = await fixture(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk);
    if (req.url === "/bad-status") {
      req.socket.end("HTTP/1.1 000 Invalid\r\nContent-Length: 0\r\n\r\n");
    } else if (req.url === "/hop") {
      res
        .writeHead(200, {
          connection: "close, set-cookie, location",
          "set-cookie": ["project=one"],
          location: "/next",
        })
        .end();
    } else if (req.url === "/redirect") {
      res
        .writeHead(302, {
          location: "/next",
          "set-cookie": [
            "kiteline_session=bad; Path=/",
            "kiteline_session_http=bad; Path=/",
            "project=good; Path=/",
          ],
          "service-worker-allowed": "/",
        })
        .end();
    } else if (req.url === "/unauthorized") res.writeHead(401).end("application login");
    else
      res.end(
        JSON.stringify({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(parts).toString(),
        }),
      );
  });
  const raw = await f.call(
    f.prefix + "/a//b/../c%2fd?",
    "POST",
    {
      cookie: f.cookie + "; kiteline_session_http=other; project=one",
      forwarded: "spoof",
      "x-forwarded-host": "wrong",
      connection: "close, x-hop",
      "x-hop": "hidden",
      authorization: "Project auth",
      expect: "100-continue",
      "transfer-encoding": "chunked",
    },
    "hello",
  );
  expect(raw.status).toBe(200);
  expect(JSON.parse(raw.text)).toMatchObject({
    url: "/a//b/../c%2fd?",
    method: "POST",
    body: "hello",
    headers: {
      cookie: "project=one",
      host: new URL(f.entryOrigin).host,
      "x-forwarded-proto": "https",
      authorization: "Project auth",
    },
  });
  expect(JSON.parse(raw.text).headers).not.toHaveProperty("x-hop");
  expect(JSON.parse(raw.text).headers).not.toHaveProperty("forwarded");
  const httpOrigin = `http://127.0.0.1:${f.port}`;
  const http = await f.call(
    f.prefix + "/http",
    "POST",
    {
      host: new URL(httpOrigin).host,
      origin: httpOrigin,
      "x-forwarded-proto": "http",
      cookie: `kiteline_session_http=${f.login.token}; kiteline_session=other; project=two`,
    },
    "HTTP body",
  );
  expect(http.status).toBe(200);
  expect(JSON.parse(http.text)).toMatchObject({
    body: "HTTP body",
    headers: {
      host: new URL(httpOrigin).host,
      "x-forwarded-host": new URL(httpOrigin).host,
      "x-forwarded-proto": "http",
      cookie: "project=two",
    },
  });
  expect((await f.call(f.prefix + "/bad-status")).status).toBe(502);
  const hop = await f.call(f.prefix + "/hop");
  expect(hop.headers).not.toHaveProperty("set-cookie");
  expect(hop.headers).not.toHaveProperty("location");
  expect(
    JSON.parse((await f.call(f.prefix + "/echo", "GET", { connection: "close, cookie" })).text)
      .headers,
  ).not.toHaveProperty("cookie");
  for (const method of ["DELETE", "OPTIONS"])
    expect(
      JSON.parse(
        (await f.call(f.prefix + "/", method, { "transfer-encoding": "chunked" }, "body")).text,
      ).body,
    ).toBe("body");
  expect((await f.call(f.prefix + "?")).headers.location).toBe(f.prefix + "/?");
  const absolute = f.prefix.replace("/proxy/", "/absproxy/") + "/a//b?";
  expect(JSON.parse((await f.call(absolute)).text).url).toBe(absolute);
  const redirect = await f.call(f.prefix + "/redirect");
  expect(redirect.headers.location).toBe(f.prefix + "/next");
  expect(redirect.headers["set-cookie"]).toEqual(["project=good; Path=/"]);
  expect(redirect.headers["service-worker-allowed"]).toBe("/");
  expect(await f.call(f.prefix + "/unauthorized")).toMatchObject({
    status: 401,
    text: "application login",
  });
  expect((await f.call(f.prefix + "/", "GET", { cookie: "" })).status).toBe(401);
  expect(
    (await f.call(f.prefix + "/", "GET", { cookie: "", "sec-fetch-mode": "navigate" })).headers
      .location,
  ).toBe(`/login?returnTo=${encodeURIComponent(f.prefix + "/")}`);
  expect((await f.call(f.prefix + "/", "POST", { origin: "https://wrong.test" })).status).toBe(403);
  expect((await f.call(`/proxy/missing/${f.upstreamPort}/`)).status).toBe(404);
}, 15_000);

test.each(["reject", "upgrade"])(
  "raw proxy %s releases a half-open browser after its final bytes",
  async (mode) => {
    const f = await fixture((_req, res) => res.end("HTTP"));
    const servicePeers = new Set<Socket>();
    let raw: Socket | undefined;
    f.kiteline.server.on("upgrade", (req, socket) => {
      if (req.url?.startsWith(f.prefix)) raw = socket as Socket;
    });
    f.upstream.on("upgrade", (req, socket) => {
      servicePeers.add(socket as Socket);
      socket.on("close", () => servicePeers.delete(socket as Socket));
      const payload =
        mode === "reject"
          ? "HTTP/1.1 403 Forbidden\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello"
          : "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
            createHash("sha1")
              .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
              .digest("base64") +
            "\r\n\r\n\x81\x04last";
      socket.end(Buffer.from(payload, "latin1"));
    });
    const browser = connect({ host: "127.0.0.1", port: f.port, allowHalfOpen: true });
    const received: Buffer[] = [];
    browser.on("data", (part: Buffer) => received.push(part));
    browser.on("error", () => {});
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      await once(browser, "connect");
      const end = once(browser, "end");
      browser.write(
        [
          `GET ${f.prefix}/ HTTP/1.1`,
          ...Object.entries(f.browserHeaders).map(([key, value]) => `${key}: ${value}`),
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n"),
      );
      await end;
      expect(Buffer.concat(received).toString("latin1")).toContain(
        mode === "reject" ? "\r\n\r\nhello" : "\r\n\r\n\x81\x04last",
      );
      closing = f.kiteline.close().then(() => {
        closed = true;
      });
      await expect.poll(() => closed).toBe(true);
    } finally {
      browser.destroy();
      raw?.destroy();
      for (const peer of servicePeers) peer.destroy();
      await closing;
    }
  },
);

test("upstream can reject a request before the client sends its body", async () => {
  const f = await fixture((_req, res) => res.writeHead(413).end("body rejected"));
  const { req, result } = f.open(f.prefix + "/", "POST", { "content-length": "1048576" });
  req.setTimeout(2000, () => req.destroy(new Error("response waited for request body")));
  req.flushHeaders();
  try {
    const response = await result;
    const parts: Buffer[] = [];
    for await (const part of response) parts.push(part);
    expect(response.statusCode).toBe(413);
    expect(Buffer.concat(parts).toString()).toBe("body rejected");
  } finally {
    req.destroy();
  }
});

test("real WebSocket messages exceed transport blocks and upgrade rejection is dechunked", async () => {
  const f = await fixture((_req, res) => res.end("HTTP"));
  const ws = new WebSocketServer({ noServer: true });
  const peers = new Set<WebSocket>();
  let receivedHeaders: IncomingMessage["headers"] | undefined;
  f.upstream.on("upgrade", (req, socket, head) => {
    receivedHeaders = req.headers;
    if (req.url === "/reject")
      return socket.end(
        "HTTP/1.1 403 Forbidden\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
      );
    ws.handleUpgrade(req, socket, head, (peer) => {
      peers.add(peer);
      peer.on("close", () => peers.delete(peer));
      peer.on("message", (data, binary) => peer.send(data, { binary }));
    });
  });
  cleanup.push(async () => {
    for (const peer of peers) peer.terminate();
    ws.close();
  });
  const client = new WebSocket(`ws://127.0.0.1:${f.port}${f.prefix}/`, ["echo"], {
    headers: {
      ...f.browserHeaders,
      cookie: f.cookie + "; kiteline_session_http=other; project=one",
    },
  });
  cleanup.push(async () => {
    client.terminate();
  });
  await once(client, "open");
  expect(client.protocol).toBe("echo");
  expect(receivedHeaders).toMatchObject({
    host: new URL(f.entryOrigin).host,
    "x-forwarded-proto": "https",
    cookie: "project=one",
  });
  const body = Buffer.alloc(2 * 1024 * 1024, 65);
  const reply = once(client, "message");
  client.send(body);
  expect((await reply)[0]).toEqual(body);
  client.close();
  await once(client, "close");
  const rejected = new WebSocket(`ws://127.0.0.1:${f.port}${f.prefix}/reject`, {
    headers: f.browserHeaders,
  });
  const result = await new Promise<{ status?: number; text: string }>((resolve, reject) => {
    rejected.on("error", reject);
    rejected.on("unexpected-response", (_req, res) => {
      void (async () => {
        const parts: Buffer[] = [];
        for await (const part of res) parts.push(part);
        resolve({ status: res.statusCode, text: Buffer.concat(parts).toString() });
      })().catch(reject);
    });
  });
  expect(result).toEqual({ status: 403, text: "hello" });
}, 15_000);

test("quiet SSE occupies the shared budget and logout closes only its original login", async () => {
  let open = 0;
  const f = await fixture((_req, res) => {
    open++;
    res.on("close", () => open--);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
  }, 2);
  const { req, result } = f.open();
  req.end();
  const response = await result;
  const first = await once(response, "data");
  expect(first[0].toString()).toBe("data: first\n\n");
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(open).toBe(1);
  const other = f.store.createSession(60_000);
  const additional = f.open(undefined, "GET", { cookie: `kiteline_session=${other.token}` });
  additional.req.end();
  const otherResponse = await additional.result;
  await once(otherResponse, "data");
  expect((await f.call()).status).toBe(429);
  const closed = new Promise<void>((resolve) => response.once("close", resolve));
  response.on("error", () => {});
  f.store.logout(f.login.id);
  f.kiteline.connections.closeLogin(f.login.id);
  await closed;
  await expect.poll(() => open).toBe(1);
  expect(otherResponse.destroyed).toBe(false);
  otherResponse.destroy();
  await expect.poll(() => open).toBe(0);
}, 15_000);
