import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { AppError, appVersion, asError, limits, record, string } from "@kiteline/shared/protocol";
import type { ServerConfig } from "./config.js";
import type { Store } from "./store.js";
import {
  AttemptLimiter,
  requireAgent,
  body,
  requireLogin,
  decodePath,
  errorStatus,
  failure,
  closeIfBodyUnread,
  json,
  requireOrigin,
  rawHead,
  requestOrigin,
  requireVersion,
  serverError,
} from "./http.js";
import { Connections } from "./connections.js";
import type { ChannelPolicy } from "./channels.js";
import { HttpProxy, isProxyPath } from "./http-proxy.js";
import { serveAgentInstallation } from "./agent-installation.js";
import { createApiHandler } from "./api.js";

export function createKitelineServer(
  config: ServerConfig,
  store: Store,
  channelPolicy?: Partial<ChannelPolicy>,
) {
  const connections = new Connections(store, channelPolicy);
  const channels = connections.channels;
  const proxy = new HttpProxy(config, store, connections, channels);
  const bindingLimiter = new AttemptLimiter();
  const serveApi = createApiHandler(config, store, connections);
  async function route(request: IncomingMessage, response: ServerResponse) {
    if (isProxyPath(request.url ?? "")) return proxy.handle(request, response);
    const entryOrigin = requestOrigin(request, config.trustProxyProto);
    const url = new URL(request.url ?? "/", entryOrigin);
    const path = url.pathname;
    const method = request.method ?? "GET";
    if (path.startsWith("/api/")) response.setHeader("x-kiteline-version", appVersion);
    if (await serveAgentInstallation(path, config.downloadsDir, entryOrigin, request, response))
      return;
    if (path === "/healthz" && method === "GET")
      return json(response, 200, { status: "ok", version: appVersion });
    if (path === "/api/agent/bind" && method === "POST") {
      bindingLimiter.check(request.socket.remoteAddress ?? "unknown");
      const input = record(await body(request));
      const result = connections.bind(
        string(input.code, "binding code", 128),
        string(input.name, "device name", limits.nameLength),
      );
      return json(response, 200, result);
    }
    if (path.startsWith("/api/")) return serveApi(request, response, url, entryOrigin);
    if (method !== "GET" && method !== "HEAD") {
      closeIfBodyUnread(response);
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const decodedPath = decodePath(path);
    if (decodedPath.includes("\0")) throw new AppError("invalid_argument", "Invalid URL path");
    const file = resolve(config.webDir, "." + decodedPath);
    if (file !== config.webDir && !file.startsWith(config.webDir + sep))
      throw new AppError("not_found", "File not found");
    const extensions: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".md": "text/plain; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".webmanifest": "application/manifest+json",
      ".woff2": "font/woff2",
    };
    let content: Buffer;
    let type: string;
    try {
      content = await readFile(file);
      type = extensions[extname(file)] ?? "application/octet-stream";
    } catch (error) {
      if (!["ENOENT", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (path.startsWith("/assets/")) throw new AppError("not_found", "Resource not found");
      content = await readFile(resolve(config.webDir, "index.html"));
      type = "text/html; charset=utf-8";
    }
    if (type === "text/html; charset=utf-8")
      response.setHeader("content-security-policy", "frame-ancestors 'none'");
    closeIfBodyUnread(response);
    response.writeHead(200, {
      "content-type": type,
      "cache-control":
        type !== "text/html; charset=utf-8" &&
        file.startsWith(resolve(config.webDir, "assets") + sep)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      "x-content-type-options": "nosniff",
    });
    response.end(method === "HEAD" ? undefined : content);
  }
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => failure(response, error));
  });
  server.requestTimeout = 0;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: limits.controlMessageBytes });
  const httpSockets = new WebSocketServer({ noServer: true, maxPayload: limits.dataChunkBytes });
  server.on("connect", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    void proxy.handle(request, socket, head);
  });
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    request.socket.setKeepAlive(true, limits.tcpKeepAliveDelayMs);
    try {
      if (isProxyPath(request.url ?? "")) {
        void proxy.handle(request, socket, head);
        return;
      }
      const entryOrigin = requestOrigin(request, config.trustProxyProto);
      const url = new URL(request.url ?? "/", entryOrigin);
      function browserLogin() {
        requireOrigin(request, entryOrigin);
        const login = requireLogin(store, request, entryOrigin);
        requireVersion(url.searchParams.get("appVersion"), login.kind === "owner" ? "web" : "cli");
        return login;
      }
      const agentChannel = /^\/api\/agent\/channels\/([^/]+)$/.exec(url.pathname);
      const browserChannel = /^\/api\/channels\/([^/]+)\/terminal$/.exec(url.pathname);
      if (agentChannel) {
        const device = requireAgent(store, request);
        const id = decodePath(agentChannel[1]!);
        const join = channels.checkAgent(
          id,
          device.id,
          string(url.searchParams.get("connectionId")),
        );
        (join.kind === "http.proxy" ? httpSockets : sockets).handleUpgrade(
          request,
          socket,
          head,
          join.accept,
        );
      } else if (browserChannel) {
        const login = browserLogin();
        const id = decodePath(browserChannel[1]!);
        const join = channels.checkBrowser(id, login.id);
        sockets.handleUpgrade(request, socket, head, join.accept);
      } else if (url.pathname === "/api/agent/control") {
        const device = requireAgent(store, request);
        connections.observeAndRequireAgentVersion(device.id, url.searchParams.get("appVersion"));
        sockets.handleUpgrade(request, socket, head, (ws) =>
          connections.acceptAgent(device.id, ws),
        );
      } else if (url.pathname === "/api/events") {
        const login = browserLogin();
        sockets.handleUpgrade(request, socket, head, (ws) => connections.acceptBrowser(ws, login));
      } else socket.end(rawHead(404, "Not Found", { Connection: "close" }), () => socket.destroy());
    } catch (cause) {
      const error = serverError(cause);
      const status = errorStatus(error);
      const payload = JSON.stringify({ error: asError(error) });
      socket.end(
        rawHead(status, STATUS_CODES[status]!, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Content-Length": Buffer.byteLength(payload),
          Connection: "close",
        }) + payload,
        () => socket.destroy(),
      );
    }
  });
  return {
    server,
    connections,
    channels,
    close: async () => {
      connections.close();
      sockets.close();
      httpSockets.close();
      if (server.listening)
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
    },
  };
}
