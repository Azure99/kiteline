import { serverLimits } from "./limits.js";
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { AppError, appVersion, asError, limits, record, string } from "@kiteline/shared/protocol";
import type { ServerConfig } from "./config.js";
import { Store, password } from "./store.js";
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
  loginCookie,
} from "./http.js";
import { Connections } from "./connections.js";
import { Channels } from "./channels.js";
import { HttpProxy, isProxyPath } from "./http-proxy.js";
import {
  installationCommands,
  serveAgentInstallation,
  upgradeCommand,
} from "./agent-installation.js";

export function createKitelineServer(config: ServerConfig, store: Store) {
  const connections = new Connections(store);
  const channels = new Channels(connections);
  const proxy = new HttpProxy(config, store, connections, channels);
  const bindingLimiter = new AttemptLimiter();
  const authenticationLimiter = new AttemptLimiter();
  async function loginBody(request: IncomingMessage, entryOrigin: string) {
    const input = record(await body(request));
    // Reading the body can outlive the login that admitted the request.
    requireLogin(store, request, entryOrigin);
    return input;
  }
  function newLogin(response: ServerResponse, entryOrigin: string) {
    const login = store.createLogin(serverLimits.loginLifetime);
    response.setHeader("set-cookie", loginCookie(entryOrigin, login.token, login.expiresAt));
    json(response, 200, { expiresAt: login.expiresAt });
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
      bindingLimiter.check(request.socket.remoteAddress ?? "unknown");
      const input = record(await body(request));
      const result = store.bind(
        string(input.code, "binding code", 128),
        string(input.name, "device name", limits.nameLength),
      );
      connections.broadcastDevices();
      return json(response, 200, result);
    }
    if (path.startsWith("/api/")) {
      if (!["GET", "HEAD"].includes(method)) requireOrigin(request, entryOrigin);
      if (path === "/api/bootstrap" && method === "GET")
        return json(response, 200, { initialized: store.initialized() });
      if ((path === "/api/setup" || path === "/api/login") && method === "POST") {
        authenticationLimiter.check(request.socket.remoteAddress ?? "unknown");
        const input = record(await body(request));
        const value = password(input.password);
        if (path === "/api/setup")
          await store.setup(string(input.setupToken, "setup token", 256), value);
        else if (!(await store.verifyPassword(value)))
          throw new AppError("unauthenticated", "Incorrect password");
        return newLogin(response, entryOrigin);
      }
      const login = requireLogin(store, request, entryOrigin);
      if (path === "/api/session" && method === "GET")
        return json(response, 200, {
          expiresAt: login.expiresAt,
        });
      if (path === "/api/logout" && method === "POST") {
        store.logout(login.id);
        connections.closeLogin(login.id);
        response.setHeader("set-cookie", loginCookie(entryOrigin, "", ""));
        return json(response, 200, {});
      }
      if (path === "/api/devices" && method === "GET")
        return json(response, 200, { devices: connections.devices() });
      if (path === "/api/agent/upgrade-command" && method === "GET")
        return json(response, 200, upgradeCommand(entryOrigin));
      requireVersion(url.searchParams.get("appVersion"), "web");
      if (path === "/api/tasks" && method === "GET")
        return json(response, 200, {
          devices: connections.taskSummaries(url.searchParams.get("deviceId") ?? undefined),
        });
      if (path === "/api/bindings" && method === "POST") {
        const binding = store.newBinding();
        return json(response, 200, {
          ...binding,
          commands: installationCommands(entryOrigin, binding.code),
        });
      }
      const binding = /^\/api\/bindings\/([^/]+)$/.exec(path);
      if (binding && method === "GET")
        return json(response, 200, store.binding(decodePath(binding[1]!)));
      const device = /^\/api\/devices\/([^/]+)(.*)$/.exec(path);
      const channel = /^\/api\/channels\/([^/]+)$/.exec(path);
      const content = /^\/api\/channels\/([^/]+)\/content$/.exec(path);
      if (content && (method === "GET" || method === "PUT"))
        return channels.content(decodePath(content[1]!), login.id, request, response);
      if (channel && method === "DELETE")
        return json(response, 200, {
          found: channels.cancel(
            decodePath(channel[1]!),
            new AppError("cancelled", "Channel cancelled"),
            login.id,
          ),
        });
      if (device) {
        const id = decodePath(device[1]!);
        const suffix = device[2];
        if (suffix === "/download" && method === "GET") {
          const pending = channels.create(
            id,
            login,
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
          const input = await loginBody(request, entryOrigin);
          const pending = channels.create(id, login, string(input.kind), record(input.params));
          response.on("close", () => {
            if (!response.writableFinished)
              channels.cancel(pending.id, new AppError("cancelled", "Request closed"));
          });
          return json(response, 200, await pending.ready);
        }
        if (!suffix && method === "PATCH") {
          const input = await loginBody(request, entryOrigin);
          store.renameDevice(id, string(input.name, "device name", limits.nameLength));
          connections.broadcastDevices();
          return json(response, 200, {});
        }
        if (!suffix && method === "DELETE") {
          connections.deleteDevice(id);
          return json(response, 200, {});
        }
        if (suffix === "/rpc" && method === "POST") {
          const input = await loginBody(request, entryOrigin);
          const requestId = string(input.id, "request id", 128);
          const pending = connections.rpc(
            id,
            login,
            requestId,
            string(input.method, "method", 128),
            record(input.params),
          );
          response.on("close", () => {
            if (!response.writableFinished) connections.cancel(id, requestId, login.id);
          });
          return json(response, 200, await pending);
        }
        const cancel = /^\/requests\/([^/]+)$/.exec(suffix ?? "");
        if (cancel && method === "DELETE")
          return json(response, 200, {
            found: connections.cancel(id, decodePath(cancel[1]!), login.id),
          });
      }
      throw new AppError("not_found", "API endpoint not found");
    }
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
    closeIfBodyUnread(response);
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-cache",
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
        requireVersion(url.searchParams.get("appVersion"), "web");
        return login;
      }
      const agentChannel = /^\/api\/agent\/channels\/([^/]+)$/.exec(url.pathname);
      const browserChannel = /^\/api\/channels\/([^/]+)\/terminal$/.exec(url.pathname);
      if (agentChannel) {
        const device = requireAgent(store, request);
        const id = decodePath(agentChannel[1]!);
        const kind = channels.checkAgent(
          id,
          device.id,
          string(url.searchParams.get("connectionId")),
        );
        (kind === "http.proxy" ? httpSockets : sockets).handleUpgrade(request, socket, head, (ws) =>
          channels.acceptAgent(id, ws),
        );
      } else if (browserChannel) {
        const login = browserLogin();
        const id = decodePath(browserChannel[1]!);
        channels.checkBrowser(id, login.id);
        sockets.handleUpgrade(request, socket, head, (ws) => channels.acceptBrowser(id, ws));
      } else if (url.pathname === "/api/agent/control") {
        const device = requireAgent(store, request);
        connections.checkAgentVersion(device.id, url.searchParams.get("appVersion"));
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
      channels.close();
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
