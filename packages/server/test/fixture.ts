import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { BlockList, type AddressInfo } from "node:net";
import { expect } from "vitest";
import { WebSocket } from "ws";
import { appVersion, type AgentEnvironment } from "@kiteline/shared/protocol";
import { createKitelineServer } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import type { ChannelPolicy } from "../src/channels.js";
import { Store } from "../src/store.js";

export const agentEnvironment: AgentEnvironment = {
  os: "linux",
  homePath: "/home/project",
  rootPaths: ["/"],
  dataDir: "/var/tmp/kiteline-data",
};

export function hello() {
  return {
    type: "hello",
    environment: agentEnvironment,
    editorBytes: 2000,
    snapshot: {
      schemaVersion: 1,
      revision: 0,
      workspaces: [],
      shortcuts: [],
      settings: { historyLines: 1000 },
    },
  };
}

export const agentPath = `/api/agent/control?appVersion=${appVersion}`;
export const webPath = (path: string) =>
  `${path}${path.includes("?") ? "&" : "?"}appVersion=${appVersion}`;

export async function serverFixture(
  options: {
    trustProxyProto?: boolean;
    hostname?: string;
    channelPolicy?: Partial<ChannelPolicy>;
  } = {},
) {
  const { trustProxyProto = false, hostname = "127.0.0.1", channelPolicy } = options;
  const dataDir = await mkdtemp("/var/tmp/kiteline-server-test-");
  const store = new Store(dataDir);
  const config: ServerConfig = {
    dataDir,
    trustProxyProto,
    trustedProxies: new BlockList(),
    hostname,
    port: 0,
    webDir: dataDir,
    downloadsDir: dataDir,
  };
  const app = createKitelineServer(config, store, channelPolicy);
  await new Promise<void>((resolve) => app.server.listen(0, hostname, resolve));
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (app.server.listening) await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    })());
  return { dataDir, store, config, app, origin, port, close };
}

export async function apiFixture(channelPolicy?: Partial<ChannelPolicy>) {
  const base = await serverFixture({ channelPolicy });
  const { store, app, origin } = base;
  const dataSockets: WebSocket[] = [];
  function call(path: string, method = "GET", body?: unknown, cookie?: string, source = origin) {
    return fetch(origin + webPath(path), {
      method,
      headers: {
        origin: source,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function device(name = "Linux") {
    const binding = store.newBinding();
    const identity = store.bind(binding.code, name);
    const socket = new WebSocket(origin.replace("http:", "ws:") + agentPath, {
      headers: { authorization: `Bearer ${identity.deviceToken}` },
    });
    const messages: Record<string, unknown>[] = [];
    socket.on("message", (data) =>
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    await once(socket, "open");
    socket.send(JSON.stringify(hello()));
    await expect
      .poll(() => app.connections.devices().find((d) => d.id === identity.deviceId)?.status)
      .toBe("online");
    return { ...identity, socket, messages, binding };
  }
  async function dataChannel(deviceToken: string, channelId: string, connectionId: string) {
    const socket = new WebSocket(
      origin.replace("http:", "ws:") +
        `/api/agent/channels/${channelId}?connectionId=${connectionId}`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    dataSockets.push(socket);
    await once(socket, "open");
    return socket;
  }
  return {
    ...base,
    call,
    device,
    dataChannel,
    close: async () => {
      for (const socket of dataSockets) socket.terminate();
      await base.close();
    },
  };
}

export async function rejectedUpgrade(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers });
  try {
    return await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => reject(new Error("Expected the WebSocket upgrade to be rejected")));
      socket.once("unexpected-response", (_request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of response) chunks.push(chunk as Buffer);
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() });
        })().catch(reject);
      });
    });
  } finally {
    socket.terminate();
  }
}
