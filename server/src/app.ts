import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import {
  AppError,
  appVersion,
  asError,
  limits,
  protocolVersion,
  record,
  string,
} from "@kiteline/shared/protocol";
import type { ServerConfig } from "./config.js";
import { Store, password } from "./store.js";
import {
  AttemptLimiter,
  body,
  cookie,
  errorStatus,
  failure,
  json,
  origin,
  requestOrigin,
  requireVersion,
  sessionCookie,
} from "./http.js";
import { bearer, Connections } from "./connections.js";
import { Channels } from "./channels.js";
import { HttpProxy, isProxyPath } from "./http-proxy.js";
import {
  installationCommands,
  serveAgentInstallation,
  upgradeCommand,
} from "./agent-installation.js";

export function createKitelineServer(config: ServerConfig, store: Store) {
  const connections = new Connections(store);
  const channels = new Channels(connections, config);
  const proxy = new HttpProxy(config, store, connections, channels);
  const limiter = new AttemptLimiter();
  function login(request: IncomingMessage, entryOrigin: string) {
    const session = store.session(cookie(request, entryOrigin));
    if (!session) throw new AppError("unauthenticated", "Please sign in");
    return session;
  }
  function newSession(response: ServerResponse, entryOrigin: string) {
    const session = store.createSession(config.limits.sessionLifetime);
    response.setHeader("set-cookie", sessionCookie(entryOrigin, session.token, session.expiresAt));
    json(response, 200, { expiresAt: session.expiresAt });
  }
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
      limiter.check(request.socket.remoteAddress ?? "unknown");
      const input = record(await body(request));
      const result = store.bind(
        string(input.code, "binding code", 128),
        string(input.name, "device name", 256),
      );
      connections.broadcastDevices();
      return json(response, 200, result);
    }
    if (path.startsWith("/api/")) {
      if (!["GET", "HEAD"].includes(method)) origin(request, entryOrigin);
      if (path === "/api/bootstrap" && method === "GET")
        return json(response, 200, { initialized: store.initialized() });
      if ((path === "/api/setup" || path === "/api/login") && method === "POST") {
        limiter.check(request.socket.remoteAddress ?? "unknown");
        const input = record(await body(request));
        const value = password(input.password);
        if (path === "/api/setup")
          await store.setup(string(input.setupToken, "setup token", 256), value);
        else if (!(await store.verifyPassword(value)))
          throw new AppError("unauthenticated", "Incorrect password");
        return newSession(response, entryOrigin);
      }
      const session = login(request, entryOrigin);
      if (path === "/api/session" && method === "GET")
        return json(response, 200, {
          expiresAt: session.expiresAt,
          draftTotalBytes: config.limits.draftTotalBytes,
        });
      if (path === "/api/logout" && method === "POST") {
        store.logout(session.id);
        connections.closeLogin(session.id);
        response.setHeader("set-cookie", sessionCookie(entryOrigin, "", ""));
        return json(response, 200, {});
      }
      if (path === "/api/devices" && method === "GET")
        return json(response, 200, { devices: connections.devices() });
      if (path === "/api/agent/upgrade-command" && method === "GET")
        return json(response, 200, upgradeCommand(entryOrigin));
      requireVersion(url.searchParams.get("appVersion"), "web");
      if (path === "/api/bindings" && method === "POST") {
        const binding = store.newBinding();
        return json(response, 200, {
          ...binding,
          commands: installationCommands(entryOrigin, binding.code),
        });
      }
      const binding = /^\/api\/bindings\/([^/]+)$/.exec(path);
      if (binding && method === "GET")
        return json(response, 200, store.binding(decodeURIComponent(binding[1]!)));
      const device = /^\/api\/devices\/([^/]+)(.*)$/.exec(path);
      const channel = /^\/api\/channels\/([^/]+)$/.exec(path);
      const content = /^\/api\/channels\/([^/]+)\/content$/.exec(path);
      if (content && (method === "GET" || method === "PUT"))
        return channels.content(decodeURIComponent(content[1]!), session.id, request, response);
      if (channel && method === "DELETE")
        return json(response, 200, {
          found: channels.cancel(
            decodeURIComponent(channel[1]!),
            new AppError("cancelled", "Channel cancelled"),
            session.id,
          ),
        });
      if (device) {
        const id = decodeURIComponent(device[1]!);
        const suffix = device[2];
        if (suffix === "/download" && method === "GET") {
          const pending = channels.create(
            id,
            session,
            "file.read",
            {
              workspaceId: string(url.searchParams.get("workspaceId")),
              path: string(url.searchParams.get("path")),
              purpose: "download",
            },
            { request, response },
          );
          await pending.ready;
          return;
        }
        if (suffix === "/channels" && method === "POST") {
          const input = record(await body(request));
          login(request, entryOrigin);
          const pending = channels.create(id, session, string(input.kind), record(input.params));
          response.on("close", () => {
            if (!response.writableFinished)
              channels.cancel(pending.id, new AppError("cancelled", "Request closed"));
          });
          return json(response, 200, await pending.ready);
        }
        if (!suffix && method === "PATCH") {
          const input = record(await body(request));
          login(request, entryOrigin);
          store.renameDevice(id, string(input.name, "device name", 256));
          connections.broadcastDevices();
          return json(response, 200, {});
        }
        if (suffix === "/revoke" && method === "POST") {
          connections.revoke(id);
          return json(response, 200, {});
        }
        if (suffix === "/rpc" && method === "POST") {
          const input = record(await body(request));
          login(request, entryOrigin);
          const requestId = string(input.id, "request id", 128);
          const pending = connections.rpc(
            id,
            session,
            requestId,
            string(input.method, "method", 128),
            record(input.params),
          );
          response.on("close", () => {
            if (!response.writableFinished) connections.cancel(id, requestId, session.id);
          });
          return json(response, 200, await pending);
        }
        const cancel = /^\/requests\/([^/]+)$/.exec(suffix ?? "");
        if (cancel && method === "DELETE")
          return json(response, 200, {
            found: connections.cancel(id, decodeURIComponent(cancel[1]!), session.id),
          });
      }
      throw new AppError("not_found", "API endpoint not found");
    }
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      throw new AppError("invalid_argument", "Invalid URL path");
    }
    const file = resolve(config.webDir, "." + decodedPath);
    if (file !== config.webDir && !file.startsWith(config.webDir + sep))
      throw new AppError("not_found", "File not found");
    const extensions: Record<string, string> = {
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
      type = extensions[extname(file)] ?? "text/html; charset=utf-8";
    } catch (error) {
      if (!["ENOENT", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (path.startsWith("/assets/")) throw new AppError("not_found", "Resource not found");
      content = await readFile(resolve(config.webDir, "index.html"));
      type = "text/html; charset=utf-8";
    }
    response.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    response.end(method === "HEAD" ? undefined : content);
  }
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => failure(response, error));
  });
  server.requestTimeout = 0;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: limits.controlMessageBytes });
  const httpSockets = new WebSocketServer({ noServer: true, maxPayload: limits.dataChunkBytes });
  server.on("connect", (request, socket, head) => void proxy.handle(request, socket, head));
  server.on("upgrade", (request, socket, head) => {
    request.socket.setKeepAlive(true, limits.tcpKeepAliveDelayMs);
    try {
      if (isProxyPath(request.url ?? "")) {
        void proxy.handle(request, socket, head);
        return;
      }
      const entryOrigin = requestOrigin(request, config.trustProxyProto);
      const url = new URL(request.url ?? "/", entryOrigin);
      const agentChannel = /^\/api\/agent\/channels\/([^/]+)$/.exec(url.pathname);
      const browserChannel = /^\/api\/channels\/([^/]+)\/terminal$/.exec(url.pathname);
      if (agentChannel) {
        const device = store.authenticateAgent(bearer(request));
        if (!device) throw new AppError("unauthenticated", "Invalid device credentials");
        const id = decodeURIComponent(agentChannel[1]!);
        const kind = channels.checkAgent(
          id,
          device.id,
          string(url.searchParams.get("connectionId")),
        );
        (kind === "http.proxy" ? httpSockets : sockets).handleUpgrade(request, socket, head, (ws) =>
          channels.acceptAgent(id, ws),
        );
      } else if (browserChannel) {
        origin(request, entryOrigin);
        const session = login(request, entryOrigin);
        requireVersion(url.searchParams.get("appVersion"), "web");
        const id = decodeURIComponent(browserChannel[1]!);
        channels.checkBrowser(id, session.id);
        sockets.handleUpgrade(request, socket, head, (ws) => channels.acceptBrowser(id, ws));
      } else if (url.pathname === "/api/agent/control") {
        const device = store.authenticateAgent(bearer(request));
        if (!device) throw new AppError("unauthenticated", "Invalid device credentials");
        connections.checkAgentVersion(device.id, url.searchParams.get("appVersion"));
        if (url.searchParams.get("protocolVersion") !== String(protocolVersion))
          throw new AppError("unsupported", "Protocol version mismatch");
        sockets.handleUpgrade(request, socket, head, (ws) =>
          connections.acceptAgent(device.id, ws),
        );
      } else if (url.pathname === "/api/events") {
        origin(request, entryOrigin);
        const session = login(request, entryOrigin);
        requireVersion(url.searchParams.get("appVersion"), "web");
        sockets.handleUpgrade(request, socket, head, (ws) =>
          connections.acceptBrowser(ws, session),
        );
      } else socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    } catch (error) {
      const status =
        error instanceof AppError && error.code === "unsupported" ? 426 : errorStatus(error);
      const payload = JSON.stringify({ error: asError(error) });
      socket.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
      );
    }
  });
  return {
    server,
    connections,
    channels,
    close: async () => {
      channels.close();
      connections.close();
      sockets.close();
      httpSockets.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
