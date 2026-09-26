import { expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { WebSocket, WebSocketServer } from "ws";
import { Agent } from "../src/control.js";
import { defaultAgentLimits } from "../src/config.js";
import { localRequest } from "../src/local.js";
import {
  appVersion,
  limits,
  OperationError,
  type Reply,
  type Session,
} from "@kiteline/shared/protocol";
import type { DoctorReport } from "../src/doctor.js";
import { publish } from "../src/mutations.js";

test("control reconnects after handshake rejection, retains valid watches and scopes remote session end", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-agent-control-");
  const certificates = getCACertificates("default");
  let agent: Agent | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let sockets: WebSocketServer | undefined;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
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
    sockets = new WebSocketServer({ noServer: true });
    const refusals = [401, 426];
    let rejectVersion = false;
    server.on("upgrade", (request, socket, head) => {
      if (rejectVersion) {
        const body = JSON.stringify({
          error: {
            code: "version_mismatch",
            message: "Install the matching release 0.3.0-test",
            details: { serverVersion: "0.3.0-test" },
          },
        });
        socket.end(
          `HTTP/1.1 426 Rejected\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
        return;
      }
      const status = refusals.shift();
      if (status) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
      else sockets!.handleUpgrade(request, socket, head, (ws) => sockets!.emit("connection", ws));
    });
    const messages: Record<string, unknown>[] = [];
    let peer: WebSocket | undefined;
    sockets.once("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        messages.push(message);
        if (message.type === "hello")
          socket.send(
            JSON.stringify({ type: "welcome", connectionId: "test", serverVersion: appVersion }),
          );
      });
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
    await expect.poll(() => peer, { timeout: 8000 }).toBeDefined();
    expect(log.mock.calls.flat().join("\n")).toContain("HTTP 401. Check the device binding");
    expect(log.mock.calls.flat().join("\n")).toContain("HTTP 426. Install the agent version");
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
    const signal = new AbortController().signal;
    for (const method of ["missing.operation", "toString"])
      await expect(agent.dispatch(method, {}, signal)).rejects.toMatchObject({
        code: "unsupported",
      });
    const session = await agent.sessions.create(active.id, undefined, undefined, signal);
    await expect(
      agent.dispatch("sessions.end", { sessionId: session.id }, signal),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      agent.dispatch("sessions.end", { workspaceId: removed.id, sessionId: session.id }, signal),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(agent.sessions.list(active.id).sessions.map((item) => item.id)).toContain(session.id);
    await expect(
      agent.dispatch("sessions.end", { workspaceId: active.id, sessionId: session.id }, signal),
    ).resolves.toEqual({ ended: true });
    const local = await agent.sessions.create(active.id, undefined, undefined, signal);
    rejectVersion = true;
    socket.close();
    await expect
      .poll(() => log.mock.calls.flat().join("\n"), { timeout: 5000 })
      .toContain("Install the matching release 0.3.0-test");
    await localRequest(agent.config, "tasks.create", {
      taskId: "doctor-schedule",
      input: {
        name: "Doctor schedule",
        command: "printf ready",
        cwd: root,
        schedule: { kind: "cron", expression: "0 9 * * *" },
        timezone: "UTC",
      },
    });
    const report = await localRequest<DoctorReport>(agent.config, "doctor");
    expect(report.items.find((item) => item.name === "Scheduled Tasks")).toMatchObject({
      status: "ok",
      detail: "ready=true; tasks=1; active=0; needs_review=0",
    });
    expect(report.items.find((item) => item.name === "server")?.detail).toContain(
      "last server version=0.3.0-test",
    );
    const retained = await localRequest<{ sessions: Session[] }>(agent.config, "sessions.list");
    expect(retained.sessions).toMatchObject([{ id: local.id, state: "running" }]);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect
      .poll(() => log.mock.calls.flat().join("\n"), { timeout: 8000 })
      .toContain("ECONNREFUSED");
    const disconnected = await localRequest<DoctorReport>(agent.config, "doctor");
    expect(disconnected.items.find((item) => item.name === "server")?.detail).toContain(
      "ECONNREFUSED",
    );
    await expect(
      localRequest(agent.config, "sessions.end", { sessionId: local.id }),
    ).resolves.toEqual({ ended: true });
    expect(agent.sessions.list().sessions).toEqual([]);
  } finally {
    await agent?.close();
    for (const socket of sockets?.clients ?? []) socket.terminate();
    if (sockets) await new Promise<void>((resolve) => sockets!.close(() => resolve()));
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    setDefaultCACertificates(certificates);
    await rm(root, { recursive: true, force: true });
    log.mockRestore();
  }
}, 20000);

test("bulk file requests outlive the RPC timeout and still cancel while publication is blocked", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-bulk-control-");
  const server = createHttpServer();
  const sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const agent = new Agent(
    {
      dataDir: root,
      runDir: join(root, "run"),
      shell: "/bin/sh",
      limits: { ...defaultAgentLimits, rpcTimeout: 50 },
    },
    {
      deviceId: "test",
      deviceToken: "test",
      server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
  );
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const hold = async () => {
    let started = false;
    held = publish(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          started = true;
        }),
    );
    await expect.poll(() => started).toBe(true);
  };
  try {
    await mkdir(join(root, "workspace"));
    await writeFile(join(root, "workspace/source"), "actual copy");
    const workspace = await agent.metadata.add(join(root, "workspace"));
    const connected = once(sockets, "connection");
    await agent.start();
    const [peer] = (await connected) as [WebSocket];
    const replies: Reply[] = [];
    peer.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "rpc.result") replies.push(message.reply);
    });
    peer.send(JSON.stringify({ type: "welcome", connectionId: "test", serverVersion: appVersion }));
    const copy = (id: string) =>
      peer.send(
        JSON.stringify({
          type: "rpc.request",
          id,
          method: "files.copy",
          params: {
            workspaceId: workspace.id,
            items: [{ path: "source", targetPath: id, collision: "error" }],
          },
        }),
      );
    await hold();
    copy("waited");
    await expect.poll(() => agent.requests.has("waited")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(replies).toEqual([]);
    expect(agent.requests.get("waited")!.signal.aborted).toBe(false);
    release!();
    await held;
    await expect
      .poll(() => replies.find((reply) => reply.id === "waited"))
      .toMatchObject({ outcome: "succeeded" });
    expect(await readFile(join(root, "workspace/waited"), "utf8")).toBe("actual copy");

    await hold();
    copy("cancelled");
    await expect.poll(() => agent.requests.has("cancelled")).toBe(true);
    peer.send(JSON.stringify({ type: "rpc.cancel", id: "cancelled" }));
    await expect
      .poll(() => replies.find((reply) => reply.id === "cancelled"))
      .toMatchObject({ outcome: "failed", error: { code: "cancelled" } });
    await expect(readFile(join(root, "workspace/cancelled"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    copy("disconnected");
    await expect.poll(() => agent.requests.has("disconnected")).toBe(true);
    peer.close();
    await expect.poll(() => agent.requests.has("disconnected")).toBe(false);
    release!();
    await held;
    await expect(readFile(join(root, "workspace/disconnected"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    release?.();
    await held;
    await agent.close();
    for (const peer of sockets.clients) peer.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("control bounds replies without losing outcomes and ignores buffered requests after rejection", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-control-budget-");
  const server = createHttpServer();
  const sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const agent = new Agent(
    { dataDir: root, runDir: join(root, "run"), shell: "/bin/bash", limits: defaultAgentLimits },
    {
      deviceId: "test",
      deviceToken: "test",
      server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
  );
  try {
    const connection = once(sockets, "connection");
    await agent.start();
    const [peer] = (await connection) as [WebSocket];
    const replies: Record<string, unknown>[] = [];
    peer.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "rpc.result") replies.push(message.reply);
    });
    // Exercise the wire limit independently of how each tool produces its result.
    const dispatch = vi.spyOn(agent, "dispatch");
    for (const outcome of ["failed", "partial", "unknown", "succeeded"] as const) {
      const large = "x".repeat(limits.controlMessageBytes);
      if (outcome === "succeeded") dispatch.mockResolvedValueOnce(large);
      else dispatch.mockRejectedValueOnce(new OperationError("command_failed", large, outcome));
      peer.send(
        JSON.stringify({ type: "rpc.request", id: outcome, method: "sessions.list", params: {} }),
      );
      await expect
        .poll(() => replies.find((r) => r.id === outcome))
        .toMatchObject({
          outcome: outcome === "succeeded" ? "unknown" : outcome,
          error: { code: "limit_exceeded" },
        });
    }
    dispatch.mockRestore();
    const closed = once(peer, "close");
    const transport = (peer as WebSocket & { _socket: Socket })._socket;
    transport.cork();
    peer.send(
      JSON.stringify({
        type: "rpc.request",
        id: "invalid",
        method: "workspaces.add",
        params: null,
      }),
    );
    peer.send(
      JSON.stringify({
        type: "rpc.request",
        id: "following",
        method: "settings.update",
        params: { historyLines: 1234 },
      }),
    );
    transport.uncork();
    await closed;
    await agent.close();
    expect(agent.metadata.value.settings.historyLines).not.toBe(1234);
  } finally {
    vi.restoreAllMocks();
    await agent.close();
    for (const peer of sockets.clients) peer.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
