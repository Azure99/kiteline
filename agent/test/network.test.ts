import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { gzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { connectServerSocket, fetchServerJson } from "../src/network.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function fixture(secureProxy = false, credentials = "user:pass") {
  for (const name of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"])
    for (const key of [name, name.toUpperCase()]) vi.stubEnv(key, "");
  const root = await mkdtemp("/var/tmp/kiteline-network-");
  const keyFile = join(root, "key.pem"),
    certFile = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
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
    ],
    { stdio: "ignore" },
  );
  const tls = { key: await readFile(keyFile), cert: await readFile(certFile) };
  const certificates = getCACertificates("default");
  setDefaultCACertificates([...certificates, tls.cert]);
  const peers = new Set<Socket>();
  const proxyPeers = new Set<Socket>();
  let mode: "forward" | "reject" | "connect-stall" | "tls-stall" = "forward";
  const requests: { target: string; auth?: string }[] = [];
  const { username, password } = new URL(`http://${credentials}@localhost`);
  const authorization = `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString("base64")}`;
  const target = createSecureServer(tls, async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    if (req.url === "/redirect") {
      res.writeHead(307, { location: `https://localhost:${port}/json` }).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(
      gzipSync(JSON.stringify({ method: req.method, body: Buffer.concat(parts).toString() })),
    );
  });
  const ws = new WebSocketServer({ server: target });
  ws.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
  const proxy = secureProxy ? createSecureServer(tls) : createServer();
  for (const server of [target, proxy])
    server.on("connection", (socket) => {
      peers.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => peers.delete(socket));
    });
  proxy.on("connect", (req, socket, head) => {
    proxyPeers.add(socket);
    socket.on("close", () => proxyPeers.delete(socket));
    requests.push({ target: req.url!, auth: req.headers["proxy-authorization"] });
    if (mode !== "forward") {
      // The CONNECT handler owns reads and EOF once HTTP has handed off the socket.
      socket.on("end", () => socket.end());
      socket.resume();
    }
    if (mode === "reject" || req.headers["proxy-authorization"] !== authorization) {
      socket.write("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (mode === "connect-stall") return;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (mode === "tls-stall") return;
    const upstream = connect({ host: "127.0.0.1", port }, () => {
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const port = (target.address() as AddressInfo).port;
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyUrl = `${secureProxy ? "https" : "http"}://${credentials}@localhost:${(proxy.address() as AddressInfo).port}`;
  vi.stubEnv("HTTPS_PROXY", proxyUrl);
  cleanup.push(async () => {
    for (const socket of ws.clients) socket.terminate();
    for (const socket of peers) socket.destroy();
    await Promise.all(
      [target, proxy].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    setDefaultCACertificates(certificates);
    await rm(root, { recursive: true, force: true });
  });
  return {
    url: new URL(`https://127.0.0.1:${port}/json`),
    wsUrl: new URL(`wss://127.0.0.1:${port}/`),
    proxyUrl,
    requests,
    proxyPeers,
    setMode(value: typeof mode) {
      mode = value;
    },
  };
}

test.each([false, true])(
  "JSON and WSS use the selected HTTP(S) proxy (%s), then honor NO_PROXY",
  async (secure) => {
    const f = await fixture(secure);
    const options = { method: "POST", body: JSON.stringify({ code: "test" }) };
    expect(await fetchServerJson(f.url, options)).toEqual({
      ok: true,
      body: { method: "POST", body: options.body },
    });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.auth).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    // Lowercase takes precedence; ALL_PROXY is also used for WSS's HTTPS target.
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("https_proxy", f.proxyUrl);
    const proxied = connectServerSocket(f.wsUrl, { handshakeTimeout: 300 });
    await once(proxied, "open");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const echo = once(proxied, "message");
    proxied.send("still connected");
    expect((await echo)[0].toString()).toBe("still connected");
    expect(f.requests).toHaveLength(2);
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("ALL_PROXY", f.proxyUrl);
    await fetchServerJson(f.url, options);
    expect(f.requests).toHaveLength(3);
    vi.stubEnv("NO_PROXY", `127.0.0.1:${f.url.port}`);
    const direct = connectServerSocket(f.wsUrl, { handshakeTimeout: 300 });
    await once(direct, "open");
    await fetchServerJson(f.url, options);
    expect(f.requests).toHaveLength(3);
    const close = new Promise((resolve) => proxied.once("close", resolve));
    proxied.terminate();
    await close;
    const directEcho = once(direct, "message");
    direct.send("independent");
    expect((await directEcho)[0].toString()).toBe("independent");
    direct.terminate();
    await expect.poll(() => f.proxyPeers.size).toBe(0);
  },
);

test.each(["token:", ":password", "to%3Aken:"])(
  "binding and WSS authenticate with partial proxy credentials (%s)",
  async (credentials) => {
    const f = await fixture(false, credentials);
    expect((await fetchServerJson(f.url, { signal: AbortSignal.timeout(2000) })).ok).toBe(true);
    const socket = connectServerSocket(f.wsUrl, { handshakeTimeout: 300 });
    await once(socket, "open");
    const echo = once(socket, "message");
    socket.send("authenticated");
    expect((await echo)[0].toString()).toBe("authenticated");
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]?.auth).toBe(f.requests[1]?.auth);
    socket.terminate();
    await expect.poll(() => f.proxyPeers.size).toBe(0);
  },
);

test("binding redirects reselect the proxy for the destination and retain POST/compression", async () => {
  const f = await fixture();
  vi.stubEnv("NO_PROXY", "localhost");
  const result = await fetchServerJson(new URL("/redirect", f.url), {
    method: "POST",
    body: "binding",
  });
  expect(result).toEqual({ ok: true, body: { method: "POST", body: "binding" } });
  expect(f.requests).toHaveLength(1);
  await expect.poll(() => f.proxyPeers.size).toBe(0);
});

test.each(["reject", "connect-stall", "tls-stall", "cancel"] as const)(
  "WSS %s releases the CONNECT socket",
  async (mode) => {
    const f = await fixture();
    f.setMode(mode === "cancel" ? "connect-stall" : mode);
    const socket = connectServerSocket(f.wsUrl, { handshakeTimeout: 300 });
    socket.on("error", () => {});
    const close = new Promise((resolve) => socket.once("close", resolve));
    await expect.poll(() => f.requests.length).toBe(1);
    if (mode === "cancel") socket.terminate();
    await close;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    await expect.poll(() => f.proxyPeers.size).toBe(0);
  },
);

test.each(["connect-stall", "tls-stall"] as const)(
  "cancelled binding releases %s",
  async (mode) => {
    const f = await fixture();
    f.setMode(mode);
    await expect(fetchServerJson(f.url, { signal: AbortSignal.timeout(150) })).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
    await expect.poll(() => f.proxyPeers.size).toBe(0);
    vi.stubEnv("HTTPS_PROXY", "socks5://localhost:1080");
    expect(() => connectServerSocket(f.wsUrl, { handshakeTimeout: 300 })).toThrow(
      "must use HTTP or HTTPS",
    );
  },
);
