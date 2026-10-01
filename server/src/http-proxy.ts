import {
  request as httpRequest,
  ServerResponse,
  STATUS_CODES,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import type { Duplex } from "node:stream";
import { AppError, asError, integer } from "@kiteline/shared/protocol";
import type { ServerConfig } from "./config.js";
import type { Store, Login } from "./store.js";
import type { Connections } from "./connections.js";
import type { Channels } from "./channels.js";
import { cookie, decodePath, finishRequest, origin, requestOrigin } from "./http.js";
import { requestHeaders, responseHeaders } from "./proxy-headers.js";

interface Target {
  deviceId: string;
  port: number;
  prefix: string;
  path: string;
  strip: boolean;
  redirect?: string;
}
export const isProxyPath = (path: string) => /^\/(?:proxy|absproxy)(?:[/?]|$)/.test(path);
export function proxyTarget(raw: string): Target {
  const match = /^(\/(proxy|absproxy)\/([^/?]+)\/(\d{1,5}))((?:[/?].*)?)$/.exec(raw);
  if (!match) throw new AppError("invalid_argument", "Invalid device port path");
  const [, prefix, kind, encodedDevice, port, suffix = ""] = match;
  const deviceId = decodePath(encodedDevice!, "Invalid device ID");
  const targetPort = integer(Number(port), "port", 1, 65535);
  return {
    deviceId,
    port: targetPort,
    prefix: prefix!,
    path: kind === "proxy" ? suffix : raw,
    strip: kind === "proxy",
    ...(!suffix.startsWith("/") ? { redirect: `${prefix}/${suffix}` } : {}),
  };
}
function navigation(request: IncomingMessage) {
  return (
    request.method === "GET" &&
    (request.headers["sec-fetch-mode"] === "navigate" ||
      request.headers["sec-fetch-dest"] === "document")
  );
}
function escape(text: string) {
  return text.replace(
    /[&<>"']/g,
    (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!,
  );
}
function rawHead(status: number, message: string, headers: OutgoingHttpHeaders) {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (const [key, value] of Object.entries(headers))
    if (value !== undefined)
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
  return lines.join("\r\n") + "\r\n\r\n";
}
function write(stream: Duplex, bytes: string | Buffer) {
  return new Promise<void>((resolve, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
}
function failure(
  request: IncomingMessage,
  destination: ServerResponse | Duplex,
  error: unknown,
  target?: Target,
) {
  if (destination.destroyed) return;
  if (destination instanceof ServerResponse && destination.headersSent)
    return destination.destroy();
  const detail = asError(error);
  const statuses: Record<string, number> = {
    unauthenticated: 401,
    forbidden: 403,
    not_found: 404,
    unsupported: 405,
    invalid_argument: 400,
    offline: 503,
    version_mismatch: 426,
    busy: 429,
    timeout: 504,
  };
  const status = statuses[detail.code] ?? 502;
  if (status === 401 && navigation(request) && destination instanceof ServerResponse) {
    destination
      .writeHead(302, {
        location: `/login?returnTo=${encodeURIComponent(request.url ?? "/")}`,
        "cache-control": "no-store",
        connection: "close",
      })
      .end();
    return;
  }
  const title = target ? `Device port ${target.port}` : "Device HTTP access";
  const message =
    detail.message +
    (status === 502 ? "; check the port, listening address, and container network." : "");
  const html = navigation(request);
  const content = html
    ? `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
body{font:15px/1.6 system-ui,sans-serif;color:#263247;margin:48px auto;padding:0 24px;max-width:640px;overflow-wrap:anywhere}
h1{font-size:22px}
a,button{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;border:0;background:transparent;color:#4269ad;font:inherit;cursor:pointer}
</style>
<h1>${escape(title)}</h1>
<p>${escape(target?.deviceId ?? "")}</p>
<p>${escape(message)}</p>
<a href="/devices${target ? `/${encodeURIComponent(target.deviceId)}` : ""}">Back to device</a>
<button type="button" onclick="location.reload()">Reopen</button>
</html>`
    : message + "\n";
  const headers = {
    "content-type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store",
    connection: "close",
  };
  if (destination instanceof ServerResponse) destination.writeHead(status, headers).end(content);
  else
    destination.end(rawHead(status, STATUS_CODES[status]!, headers) + content, () =>
      destination.destroy(),
    );
}

export class HttpProxy {
  constructor(
    private config: ServerConfig,
    private store: Store,
    private connections: Connections,
    private channels: Channels,
  ) {}
  async handle(request: IncomingMessage, destination: ServerResponse | Duplex, head?: Buffer) {
    let target: Target | undefined;
    try {
      if (request.method === "CONNECT")
        throw new AppError("unsupported", "CONNECT is not supported");
      target = proxyTarget(request.url ?? "");
      const entryOrigin = requestOrigin(request, this.config.trustProxyProto);
      const login = this.store.session(cookie(request, entryOrigin));
      if (!login) throw new AppError("unauthenticated", "Please sign in");
      if (head !== undefined || !["GET", "HEAD"].includes(request.method ?? "GET"))
        origin(request, entryOrigin);
      const device = this.connections.devices().find((value) => value.id === target!.deviceId);
      if (!device) throw new AppError("not_found", "Device not found");
      if (target.redirect) {
        if (destination instanceof ServerResponse) {
          finishRequest(destination);
          destination.writeHead(308, { location: target.redirect }).end();
        } else
          destination.end(
            rawHead(308, "Permanent Redirect", {
              location: target.redirect,
              "content-length": 0,
              connection: "close",
            }),
            () => destination.destroy(),
          );
        return;
      }
      if (head !== undefined && request.headers.upgrade?.toLowerCase() !== "websocket")
        throw new AppError("unsupported", "Only WebSocket upgrades are supported");
      await this.forward(request, destination, target, login, entryOrigin, head);
    } catch (error) {
      failure(request, destination, error, target);
    }
  }
  private async forward(
    request: IncomingMessage,
    destination: ServerResponse | Duplex,
    target: Target,
    login: Login,
    entryOrigin: string,
    head?: Buffer,
  ) {
    const response = destination instanceof ServerResponse ? destination : undefined;
    const browser = destination instanceof ServerResponse ? undefined : destination;
    let upstream: ClientRequest | undefined = undefined;
    let incoming: IncomingMessage | undefined;
    let peer: Duplex | undefined;
    let finished = false,
      upgraded = false,
      sentHead = false;
    let channelId: string | undefined = undefined;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      request.unpipe();
      upstream?.destroy();
      peer?.destroy();
      if (channelId) {
        if (error) this.channels.cancel(channelId, error);
        else this.channels.finishHttp(channelId);
      }
    };
    const fail = (error: unknown) => {
      if (finished || (!upgraded && incoming?.complete && (response?.headersSent || sentHead)))
        return;
      if (sentHead && !response) destination.destroy();
      else failure(request, destination, error, target);
      finish(error);
    };
    destination.on("error", fail);
    destination.on("close", () => {
      if (response?.writableFinished) finish();
      else finish(new AppError("cancelled", "HTTP connection closed"));
    });
    destination.on("finish", () => {
      finish();
      browser?.destroy();
    });
    request.on("aborted", () => fail(new AppError("cancelled", "Request cancelled")));
    request.on("error", fail);
    const pending = this.channels.createHttp(target.deviceId, login, target.port, fail);
    channelId = pending.id;
    let tunnel: Duplex;
    try {
      tunnel = await pending.ready;
    } catch (error) {
      fail(error);
      return;
    }
    if (finished) return tunnel.destroy();
    upstream = httpRequest({
      createConnection: () => tunnel,
      hostname: "localhost",
      port: target.port,
      method: request.method,
      path: target.path,
      headers: requestHeaders(request.headers, entryOrigin, head !== undefined),
    });
    upstream.on("error", fail);
    upstream.on("response", (result) => {
      try {
        if (result.statusCode! < 100)
          throw new AppError("io_error", "Local service returned an invalid HTTP status");
        incoming = result;
        result.on("error", fail);
        result.on("close", () => {
          if (!result.complete)
            fail(new AppError("io_error", "Local response ended before completion"));
        });
        const headers = responseHeaders(result.headers, target.prefix, target.strip);
        if (response) {
          finishRequest(response);
          response.writeHead(result.statusCode!, result.statusMessage, headers);
          response.flushHeaders();
          result.pipe(response);
        } else {
          headers.connection = "close";
          sentHead = true;
          void write(browser!, rawHead(result.statusCode!, result.statusMessage ?? "", headers))
            .then(() => result.pipe(destination))
            .catch(fail);
        }
      } catch (error) {
        fail(error);
      }
    });
    upstream.on("upgrade", (result, socket, upstreamHead) => {
      if (response || result.headers.upgrade?.toLowerCase() !== "websocket") {
        socket.destroy();
        return fail(new AppError("io_error", "Invalid upstream upgrade response"));
      }
      peer = socket;
      socket.pause();
      browser!.pause();
      socket.on("error", fail);
      socket.on("close", () => finish());
      upgraded = true;
      sentHead = true;
      void (async () => {
        await write(
          browser!,
          rawHead(
            101,
            result.statusMessage ?? "Switching Protocols",
            responseHeaders(result.headers, target.prefix, target.strip, true),
          ),
        );
        if (upstreamHead.length) await write(browser!, upstreamHead);
        if (head!.length) await write(socket, head!);
        if (finished) return;
        browser!.pipe(socket).pipe(browser!);
      })().catch(fail);
    });
    if (head !== undefined) upstream.end();
    else {
      upstream.flushHeaders();
      request.pipe(upstream);
    }
  }
}
