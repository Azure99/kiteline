import { connectServerSocket } from "@kiteline/shared/node/network";
import type { ClientOptions } from "ws";
import type { Identity } from "./config.js";

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
