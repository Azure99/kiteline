import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { WebSocket, WebSocketServer } from "ws";
import { Agent } from "../src/control.js";
import { defaultAgentLimits } from "../src/config.js";

test("stale workspace subscriptions preserve the control connection and remaining watches", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-agent-control-");
  const certificates = getCACertificates("default");
  let agent: Agent | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let sockets: WebSocketServer | undefined;
  try {
    const key = join(root, "key.pem"),
      cert = join(root, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
    setDefaultCACertificates([...certificates, await readFile(cert, "utf8")]);
    server = createServer({ key: await readFile(key), cert: await readFile(cert) });
    sockets = new WebSocketServer({ server });
    const messages: Record<string, unknown>[] = [];
    let peer: WebSocket | undefined;
    sockets.once("connection", (socket) => {
      socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
      socket.send(JSON.stringify({ type: "welcome", connectionId: "test" }));
      peer = socket;
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    agent = new Agent(
      { dataDir: root, runDir: join(root, "run"), shell: "/bin/bash", limits: defaultAgentLimits },
      {
        deviceId: "test",
        deviceToken: "test",
        server: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      },
    );
    for (const name of ["removed", "active"]) await mkdir(join(root, name));
    const removed = await agent.metadata.add(join(root, "removed"));
    const active = await agent.metadata.add(join(root, "active"));
    await agent.start();
    await expect.poll(() => peer).toBeDefined();
    const socket = peer!;
    await expect.poll(() => messages.some((message) => message.type === "hello")).toBe(true);
    await agent.dispatch(
      "workspaces.remove",
      { workspaceId: removed.id },
      new AbortController().signal,
    );
    socket.send(JSON.stringify({ type: "watch.set", workspaceIds: [removed.id, active.id] }));
    await expect
      .poll(() =>
        messages.some(
          (message) => message.type === "watch.status" && message.workspaceId === active.id,
        ),
      )
      .toBe(true);
    await writeFile(join(root, "active", "new.txt"), "change");
    await expect
      .poll(() =>
        messages.some(
          (message) => message.type === "workspace.changed" && message.workspaceId === active.id,
        ),
      )
      .toBe(true);
    socket.send(
      JSON.stringify({
        type: "rpc.request",
        id: "after-watch",
        method: "sessions.list",
        params: {},
      }),
    );
    await expect
      .poll(() =>
        messages.find(
          (message) =>
            message.type === "rpc.result" && (message.reply as { id: string }).id === "after-watch",
        ),
      )
      .toMatchObject({ reply: { outcome: "succeeded", result: { sessions: [] } } });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    await agent?.close();
    for (const socket of sockets?.clients ?? []) socket.terminate();
    if (sockets) await new Promise<void>((resolve) => sockets!.close(() => resolve()));
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    setDefaultCACertificates(certificates);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
