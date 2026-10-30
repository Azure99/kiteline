import {
  request as httpRequest,
  STATUS_CODES,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { AppError, asError, integer } from "@kiteline/shared/protocol";
import type { ServerConfig } from "./config.js";
import type { Store, Login } from "./store.js";
import type { Channels } from "./channels.js";
import {
  requireLogin,
  requireDevice,
  decodePath,
  closeIfBodyUnread,
  requireOrigin,
  rawHead,
  endRawResponse,
  requestOrigin,
} from "./http.js";
import { requestHeaders, responseHeaders } from "./proxy-headers.js";

interface Target {
  deviceId: string;
  port: number;
  prefix: string;
  path: string;
  strip: boolean;
  redirect?: string;
}
type Downstream =
  | { kind: "http"; destination: ServerResponse }
  | { kind: "upgrade"; destination: Duplex; browserHead: Buffer };
export const isProxyPath = (path: string) => /^\/(?:proxy|absproxy)(?:[/?]|$)/.test(path);
function proxyTarget(raw: string): Target {
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
function write(stream: Duplex, bytes: string | Buffer) {
  return new Promise<void>((resolve, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
}
function failure(
  request: IncomingMessage,
  downstream: Downstream | { kind: "connect"; destination: Duplex },
  error: unknown,
  target?: Target,
  deviceName?: string,
) {
  const { destination } = downstream;
  if (destination.destroyed) return;
  if (downstream.kind === "http" && downstream.destination.headersSent)
    return destination.destroy();
  const detail = asError(error);
  const statuses: Record<string, number> = {
    unauthenticated: 401,
    forbidden: 403,
    not_found: 404,
    unsupported: 501,
    invalid_argument: 400,
    offline: 503,
    version_mismatch: 426,
    busy: 429,
    timeout: 504,
  };
  const status = Object.hasOwn(statuses, detail.code) ? statuses[detail.code]! : 502;
  if (status === 401 && navigation(request) && downstream.kind === "http") {
    downstream.destination
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
:root{color-scheme:light dark;background:#fff;color:#263247}
body{font:15px/1.6 system-ui,sans-serif;margin:48px auto;padding:0 24px;max-width:640px;overflow-wrap:anywhere}
h1{font-size:22px}
a,button{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;border:0;background:transparent;color:#4269ad;font:inherit;cursor:pointer}
@media(prefers-color-scheme:dark){:root{background:#161b22;color:#dce3ed}a,button{color:#9fc5ff}}
</style>
<h1>${escape(title)}</h1>
<p>${escape(deviceName ?? "")}</p>
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
  if (downstream.kind === "http") downstream.destination.writeHead(status, headers).end(content);
  else
    endRawResponse(
      downstream.destination,
      rawHead(status, STATUS_CODES[status]!, headers) + content,
    );
}

export class HttpProxy {
  constructor(
    private config: ServerConfig,
    private store: Store,
    private channels: Channels,
  ) {}
  serve(request: IncomingMessage, response: ServerResponse) {
    return this.handle(request, { kind: "http", destination: response });
  }
  upgrade(request: IncomingMessage, socket: Duplex, browserHead: Buffer) {
    return this.handle(request, { kind: "upgrade", destination: socket, browserHead });
  }
  rejectConnect(request: IncomingMessage, socket: Duplex) {
    failure(
      request,
      { kind: "connect", destination: socket },
      new AppError("unsupported", "CONNECT is not supported"),
    );
  }
  private async handle(request: IncomingMessage, downstream: Downstream) {
    let target: Target | undefined;
    let deviceName: string | undefined;
    try {
      target = proxyTarget(request.url ?? "");
      const entryOrigin = requestOrigin(request, this.config.trustProxyProto);
      const login = requireLogin(this.store, request, entryOrigin);
      requireDevice(login, target.deviceId);
      if (downstream.kind === "upgrade" || !["GET", "HEAD"].includes(request.method ?? "GET"))
        requireOrigin(request, entryOrigin);
      deviceName = this.store.deviceName(target.deviceId);
      if (deviceName === undefined) throw new AppError("not_found", "Device not found");
      if (target.redirect) {
        if (downstream.kind === "http") {
          closeIfBodyUnread(downstream.destination);
          downstream.destination.writeHead(308, { location: target.redirect }).end();
        } else
          endRawResponse(
            downstream.destination,
            rawHead(308, "Permanent Redirect", {
              location: target.redirect,
              "content-length": 0,
              connection: "close",
            }),
          );
        return;
      }
      if (downstream.kind === "upgrade" && request.headers.upgrade?.toLowerCase() !== "websocket")
        throw new AppError("unsupported", "Only WebSocket upgrades are supported");
      await this.forward(request, downstream, target, deviceName, login, entryOrigin);
    } catch (error) {
      failure(request, downstream, error, target, deviceName);
    }
  }
  private async forward(
    request: IncomingMessage,
    downstream: Downstream,
    target: Target,
    deviceName: string,
    login: Login,
    entryOrigin: string,
  ) {
    const { destination } = downstream;
    let upstreamRequest: ClientRequest | undefined = undefined;
    let upstreamResponse: IncomingMessage | undefined;
    let upstreamSocket: Duplex | undefined;
    let resourcesEnded = false;
    let rawHeadStarted = false;
    let channelId: string | undefined = undefined;
    const finish = (error?: unknown) => {
      if (resourcesEnded) return;
      resourcesEnded = true;
      request.unpipe();
      upstreamRequest?.destroy();
      upstreamSocket?.destroy();
      if (channelId) {
        if (error) this.channels.cancel(channelId, error);
        else this.channels.finishHttp(channelId);
      }
    };
    const fail = (error: unknown) => {
      if (
        resourcesEnded ||
        (!upstreamSocket &&
          upstreamResponse?.complete &&
          (downstream.kind === "http" ? downstream.destination.headersSent : rawHeadStarted))
      )
        return;
      if (rawHeadStarted) destination.destroy();
      else failure(request, downstream, error, target, deviceName);
      finish(error);
    };
    destination.on("error", fail);
    destination.on("close", () => {
      if (downstream.kind === "http" && downstream.destination.writableFinished) finish();
      else finish(new AppError("cancelled", "HTTP connection closed"));
    });
    destination.on("finish", () => {
      finish();
      if (downstream.kind === "upgrade") downstream.destination.destroy();
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
    if (resourcesEnded) return tunnel.destroy();
    upstreamRequest = httpRequest({
      createConnection: () => tunnel,
      hostname: "localhost",
      port: target.port,
      method: request.method,
      path: target.path,
      headers: requestHeaders(
        request.headers,
        entryOrigin,
        downstream.kind === "upgrade",
        login.kind === "cli",
      ),
    });
    upstreamRequest.on("error", fail);
    upstreamRequest.on("response", (result) => {
      try {
        if (result.statusCode! < 100)
          throw new AppError("io_error", "Local service returned an invalid HTTP status");
        upstreamResponse = result;
        result.on("error", fail);
        result.on("close", () => {
          if (!result.complete)
            fail(new AppError("io_error", "Local response ended before completion"));
        });
        const headers = responseHeaders(result.headers, target.prefix, target.strip);
        if (downstream.kind === "http") {
          const response = downstream.destination;
          closeIfBodyUnread(response);
          response.writeHead(result.statusCode!, result.statusMessage, headers);
          response.flushHeaders();
          result.pipe(response);
        } else {
          headers.connection = "close";
          rawHeadStarted = true;
          void write(
            downstream.destination,
            rawHead(result.statusCode!, result.statusMessage ?? "", headers),
          )
            .then(() => result.pipe(destination))
            .catch(fail);
        }
      } catch (error) {
        fail(error);
      }
    });
    upstreamRequest.on("upgrade", (result, socket, upstreamHead) => {
      if (downstream.kind !== "upgrade" || result.headers.upgrade?.toLowerCase() !== "websocket") {
        socket.destroy();
        return fail(new AppError("io_error", "Invalid upstream upgrade response"));
      }
      upstreamSocket = socket;
      const browser = downstream.destination;
      socket.pause();
      browser.pause();
      socket.on("error", fail);
      socket.on("close", () => finish());
      rawHeadStarted = true;
      void (async () => {
        await write(
          browser,
          rawHead(
            101,
            result.statusMessage ?? "Switching Protocols",
            responseHeaders(result.headers, target.prefix, target.strip, true),
          ),
        );
        if (upstreamHead.length) await write(browser, upstreamHead);
        if (downstream.browserHead.length) await write(socket, downstream.browserHead);
        if (resourcesEnded) return;
        browser.pipe(socket).pipe(browser);
      })().catch(fail);
    });
    if (downstream.kind === "upgrade") upstreamRequest.end();
    else {
      upstreamRequest.flushHeaders();
      request.pipe(upstreamRequest);
    }
  }
}
