import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { WebSocket } from "ws";
import { appVersion, limits, type AgentEnvironment } from "@kiteline/shared/protocol";
import { createKitelineServer } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { serverLimits } from "../src/limits.js";
import { Store } from "../src/store.js";

const originalServerLimits = { ...serverLimits };
const originalInteractionTimeout = limits.interactionTimeout;

export function restoreServerLimits() {
  Object.assign(serverLimits, originalServerLimits);
  Object.assign(limits, { interactionTimeout: originalInteractionTimeout });
}

export const agentEnvironment: AgentEnvironment = {
  os: "linux",
  homePath: "/home/project",
  rootPaths: ["/"],
  cliPath: "/usr/local/bin/kiteline-agent",
  dataDir: "/var/tmp/kiteline-data",
  runDir: "/var/tmp/kiteline-run",
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

export async function serverFixture(trustProxyProto = false) {
  const dataDir = await mkdtemp("/var/tmp/kiteline-server-test-");
  const store = new Store(dataDir);
  const config: ServerConfig = {
    dataDir,
    trustProxyProto,
    hostname: "127.0.0.1",
    port: 0,
    webDir: dataDir,
    downloadsDir: dataDir,
  };
  const app = createKitelineServer(config, store);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (app.server.listening) await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    })());
  return { dataDir, store, config, app, origin, port, close };
}

export async function apiFixture() {
  const base = await serverFixture();
  const { store, app, origin } = base;
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
  return { ...base, call, device };
}
