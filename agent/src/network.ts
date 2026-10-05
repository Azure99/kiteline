import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { ConnectionOptions } from "node:tls";
import { getProxyForUrl } from "proxy-from-env";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Agent, Pool, ProxyAgent } from "undici";
import { WebSocket, type ClientOptions } from "ws";
import type { Identity } from "./config.js";

function proxyFor(target: string | URL) {
  const url = new URL(target);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  const proxy = getProxyForUrl(url.href);
  if (proxy && !["http:", "https:"].includes(new URL(proxy).protocol))
    throw new Error("Agent environment proxy must use HTTP or HTTPS");
  return proxy;
}

export async function fetchServerJson(url: URL, options: RequestInit) {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  // Node accepts the net cancellation option in TLS connectors too.
  const tlsOptions: ConnectionOptions & { signal: AbortSignal } = { signal };
  const dispatcher = new Agent({
    factory(origin) {
      const proxy = proxyFor(origin);
      if (!proxy) return new Pool(origin, { connect: { signal } });
      const { username, password } = new URL(proxy);
      // Undici's URL authentication omits credentials with an empty password.
      const token =
        username || password
          ? `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString("base64")}`
          : undefined;
      return new ProxyAgent({ uri: proxy, token, proxyTls: tlsOptions, requestTls: tlsOptions });
    },
  });
  try {
    const request = { ...options, dispatcher, signal };
    const response = await fetch(url, request);
    return { ok: response.ok, body: (await response.json()) as unknown };
  } finally {
    controller.abort();
    await dispatcher.destroy();
  }
}

export function connectServer(
  identity: Identity,
  path: string,
  query: Record<string, string>,
  options: Omit<ClientOptions, "headers">,
) {
  const url = new URL(path, identity.server);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return connectServerSocket(url, {
    ...options,
    headers: { authorization: `Bearer ${identity.deviceToken}` },
  });
}

export function connectChannel(
  identity: Identity,
  channelId: string,
  connectionId: string,
  options: Omit<ClientOptions, "headers">,
) {
  return connectServer(
    identity,
    `/api/agent/channels/${encodeURIComponent(channelId)}`,
    { connectionId },
    options,
  );
}

export function connectServerSocket(url: URL, options: ClientOptions) {
  const proxy = proxyFor(url);
  const controller = new AbortController();
  const agent = proxy
    ? new HttpsProxyAgent(proxy, { signal: controller.signal })
    : url.protocol === "wss:"
      ? new HttpsAgent()
      : new HttpAgent();
  let socket: WebSocket;
  try {
    socket = new WebSocket(url, { ...options, agent });
  } catch (error) {
    controller.abort();
    agent.destroy();
    throw error;
  }
  // ws's handshake timeout does not cover an Agent's pending CONNECT/TLS dial.
  const deadline =
    options.handshakeTimeout === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new Error("Server connection timed out"));
          socket.terminate();
        }, options.handshakeTimeout);
  socket.once("open", () => clearTimeout(deadline));
  socket.once("close", () => {
    clearTimeout(deadline);
    controller.abort();
    agent.destroy();
  });
  return socket;
}
