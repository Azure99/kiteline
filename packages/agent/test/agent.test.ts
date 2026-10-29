import { expect, test, vi } from "vitest";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { Agent } from "../src/agent.js";
import { privateDirectory } from "../src/config.js";
import { testConfig } from "./support/config.js";
import { localRequest } from "../src/local.js";
import {
  AppError,
  appVersion,
  checkMetadata,
  limits,
  OperationError,
  type Reply,
  type Session,
  type TaskRun,
} from "@kiteline/shared/protocol";
import type { DoctorReport } from "../src/doctor.js";
import { withPublicationLock } from "../src/files/publish.js";
import { Files } from "../src/files/index.js";
import { FileOperations } from "../src/files/operations.js";

test("shortcut icons round-trip through RPC and metadata, and omitting one clears the old value", async () => {
  const dataDir = await mkdtemp("/var/tmp/kiteline-shortcut-rpc-");
  const agent = new Agent(testConfig(dataDir), {
    deviceId: "test",
    deviceToken: "test",
    server: "https://localhost",
  });
  try {
    const signal = new AbortController().signal;
    await agent.dispatch(
      "shortcuts.put",
      { id: "claude", name: "Custom", command: "echo custom", icon: "rocket" },
      signal,
    );
    const read = async () =>
      checkMetadata(JSON.parse(await readFile(join(dataDir, "agent.json"), "utf8")));
    expect((await read()).shortcuts[0]).toMatchObject({
      name: "Custom",
      command: "echo custom",
      icon: "rocket",
    });
    await expect(
      agent.dispatch(
        "shortcuts.put",
        { id: "claude", name: "Custom", command: "echo custom", icon: "other" },
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    const result = await agent.dispatch(
      "shortcuts.put",
      { id: "claude", name: "Custom", command: "echo custom" },
      signal,
    );
    expect(result).not.toHaveProperty("icon", "rocket");
    expect((await read()).shortcuts[0]).toEqual({
      id: "claude",
      name: "Custom",
      command: "echo custom",
    });
    expect(agent.metadata.hello().snapshot.shortcuts[0]?.icon).toBeUndefined();
  } finally {
    await agent.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RPC admission rejects stopped before aborted before unknown without domain work or write notifications", async () => {
  const dataDir = await mkdtemp("/var/tmp/kiteline-rpc-admission-");
  const root = join(dataDir, "workspace");
  await mkdir(root);
  await writeFile(join(root, "source"), "unchanged");
  const agent = new Agent(testConfig(dataDir), {
    deviceId: "test",
    deviceToken: "test",
    server: "https://localhost",
  });
  const workspace = await agent.metadata.add(root);
  const domainCalls = [
    vi.spyOn(Files.prototype, "create"),
    vi.spyOn(FileOperations.prototype, "run"),
    vi.spyOn(agent.gitWrites, "run"),
    vi.spyOn(agent.schedules, "assertAvailable"),
    vi.spyOn(agent.sessions, "list"),
  ];
  const notified = vi.spyOn(agent.watches, "notifyWritten");
  const progress = vi.fn();
  const signal = new AbortController().signal;
  const controller = new AbortController();
  const reason = new AppError("cancelled", "Cancelled before admission");
  controller.abort(reason);
  const params = {
    workspaceId: workspace.id,
    path: "target",
    kind: "file",
    items: [{ path: "source", targetPath: "copy", collision: "error" }],
    repoId: "unresolved",
    paths: ["source"],
  };
  const unknown = ["missing.operation", "toString", "constructor"];
  const methods = [
    "files.create",
    "files.copy",
    "git.stage",
    "tasks.list",
    "sessions.list",
    ...unknown,
  ];
  try {
    for (const method of unknown)
      await expect(agent.dispatch(method, params, signal, progress)).rejects.toMatchObject({
        code: "unsupported",
      });
    for (const method of methods)
      await expect(agent.dispatch(method, params, controller.signal, progress)).rejects.toBe(
        reason,
      );
    for (const call of domainCalls) expect(call).not.toHaveBeenCalled();
    expect(notified).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();

    await agent.close();
    for (const call of domainCalls) call.mockClear();
    for (const currentSignal of [signal, controller.signal])
      for (const method of methods)
        await expect(agent.dispatch(method, params, currentSignal, progress)).rejects.toMatchObject(
          {
            code: "cancelled",
            message: "Agent is stopping",
          },
        );
    for (const call of domainCalls) expect(call).not.toHaveBeenCalled();
    expect(notified).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["source"]);
    expect(await readFile(join(root, "source"), "utf8")).toBe("unchanged");
  } finally {
    for (const call of domainCalls) call.mockRestore();
    notified.mockRestore();
    await agent.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test.each([401, 426])(
  "HTTP %i preserves local tasks with the expected reconnect behavior",
  async (status) => {
    const root = await mkdtemp("/var/tmp/kiteline-control-response-");
    const server = createHttpServer();
    let attempts = 0;
    server.on("upgrade", (_request, socket) => {
      attempts++;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const config = testConfig(root);
    const agent = new Agent(config, {
      deviceId: "test",
      deviceToken: "test",
      server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    try {
      for (const path of [config.dataDir, config.runDir]) await privateDirectory(path);
      await agent.start();
      await expect
        .poll(async () => {
          const report = await localRequest<DoctorReport>(config, "doctor");
          return report.items.find((item) => item.name === "server")?.detail;
        })
        .toContain(`HTTP ${status}`);
      await localRequest(config, "tasks.create", {
        taskId: "local",
        input: {
          name: "Local",
          command: "printf done",
          cwd: root,
          schedule: { kind: "cron", expression: "0 9 * * *" },
          timezone: "UTC",
        },
      });
      await localRequest(config, "tasks.run", { taskId: "local", runId: "local-run" });
      await expect
        .poll(
          async () =>
            (await localRequest<TaskRun>(config, "runs.get", { runId: "local-run" })).state,
        )
        .toBe("succeeded");
      if (status === 401) {
        await new Promise((resolve) => setTimeout(resolve, 1600));
        expect(attempts).toBe(1);
      } else await expect.poll(() => attempts, { timeout: 4000 }).toBeGreaterThan(1);
      const report = await localRequest<DoctorReport>(config, "doctor");
      expect(report.items.find((item) => item.name === "server")?.detail).toContain(
        `HTTP ${status}`,
      );
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("control reconnects after handshake rejection, retains valid watches and scopes remote session end", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-agent-control-");
  let agent: Agent | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  let sockets: WebSocketServer | undefined;
  try {
    server = createHttpServer();
    sockets = new WebSocketServer({ noServer: true });
    const refusals = [426];
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
    agent = new Agent(testConfig(root, { shell: "/bin/bash" }), {
      deviceId: "test",
      deviceToken: "test",
      server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    for (const name of ["removed", "active"]) await mkdir(join(root, name));
    const removed = await agent.metadata.add(join(root, "removed"));
    const active = await agent.metadata.add(join(root, "active"));
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    await expect.poll(() => peer, { timeout: 8000 }).toBeDefined();
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
    const session = await agent.sessions.create({ workspaceId: active.id }, signal);
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
    const local = await agent.sessions.create({ workspaceId: active.id }, signal);
    rejectVersion = true;
    socket.close();
    await expect
      .poll(
        async () => {
          const report = await localRequest<DoctorReport>(agent!.config, "doctor");
          return report.items.find((item) => item.name === "server")?.detail;
        },
        { timeout: 5000 },
      )
      .toContain("last server version=0.3.0-test");
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
    });
    expect(report.items.find((item) => item.name === "server")?.detail).toContain(
      "last server version=0.3.0-test",
    );
    const retained = await localRequest<{ sessions: Session[] }>(agent.config, "sessions.list");
    expect(retained.sessions).toMatchObject([{ id: local.id, state: "running" }]);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect
      .poll(
        async () => {
          const report = await localRequest<DoctorReport>(agent!.config, "doctor");
          return report.items.find((item) => item.name === "server")?.detail;
        },
        { timeout: 8000 },
      )
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
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("unknown channel kinds close control without opening a data connection and reconnect", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-unknown-channel-");
  const server = createHttpServer();
  const sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const paths: string[] = [];
  sockets.on("connection", (_peer, request) => {
    paths.push(new URL(request.url!, "http://localhost").pathname);
  });
  const agent = new Agent(testConfig(root), {
    deviceId: "test",
    deviceToken: "test",
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  try {
    const connected = once(sockets, "connection");
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    const [peer] = (await connected) as [WebSocket];
    peer.send(JSON.stringify({ type: "welcome", connectionId: "test", serverVersion: appVersion }));
    const closed = once(peer, "close");
    peer.send(
      JSON.stringify({
        type: "channel.open",
        channelId: "unknown-channel",
        connectionId: "test",
        kind: "unknown",
        params: {},
      }),
    );
    const [code, reason] = await closed;
    expect(code).toBe(1008);
    expect(reason.toString()).toBe("invalid_control_message");
    await expect.poll(() => paths.length, { timeout: 4000 }).toBe(2);
    expect(paths).toEqual(["/api/agent/control", "/api/agent/control"]);
  } finally {
    await agent.close();
    for (const peer of sockets.clients) peer.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("copy, move and delete outlive the RPC timeout and still cancel while publication is blocked", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-bulk-control-");
  const server = createHttpServer();
  const sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const agent = new Agent(testConfig(root, { limits: { rpcTimeout: 50 } }), {
    deviceId: "test",
    deviceToken: "test",
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const hold = async () => {
    let started = false;
    held = withPublicationLock(
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
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
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
    const operations = [
      {
        method: "files.copy",
        params: { items: [{ path: "source", targetPath: "waited-copy", collision: "error" }] },
        path: "waited-copy",
      },
      {
        method: "files.move",
        params: { items: [{ path: "waited-copy", targetPath: "waited-move", collision: "error" }] },
        path: "waited-move",
      },
      { method: "files.delete", params: { paths: ["waited-move"] }, path: "waited-move" },
    ];
    for (const operation of operations) {
      const id = operation.method;
      await hold();
      peer.send(
        JSON.stringify({
          type: "rpc.request",
          id,
          method: operation.method,
          params: { workspaceId: workspace.id, ...operation.params },
        }),
      );
      await expect.poll(() => agent.requests.has(id)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(replies.some((reply) => reply.id === id)).toBe(false);
      expect(agent.requests.get(id)!.signal.aborted).toBe(false);
      release!();
      await held;
      await expect
        .poll(() => replies.find((reply) => reply.id === id))
        .toMatchObject({ outcome: "succeeded" });
      const result = readFile(join(root, "workspace", operation.path), "utf8");
      if (operation.method === "files.delete")
        await expect(result).rejects.toMatchObject({ code: "ENOENT" });
      else await expect(result).resolves.toBe("actual copy");
      if (operation.method === "files.move")
        await expect(readFile(join(root, "workspace/waited-copy"))).rejects.toMatchObject({
          code: "ENOENT",
        });
    }

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

test("control selects the ordinary and search deadlines independently", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-control-deadlines-");
  const server = createHttpServer();
  const sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const agent = new Agent(
    testConfig(root, {
      limits: { rpcTimeout: 50, searchTimeout: 600, gitWriteTimeout: 8000 },
    }),
    {
      deviceId: "test",
      deviceToken: "test",
      server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
  );
  const signals = new Map<string, AbortSignal>();
  // Observe the control timer without depending on the duration of a domain operation.
  const dispatch = vi.spyOn(agent, "dispatch").mockImplementation((method, _params, signal) => {
    signals.set(method, signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  try {
    const connected = once(sockets, "connection");
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    const [peer] = (await connected) as [WebSocket];
    const replies = new Map<string, Reply>();
    peer.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "rpc.result") replies.set(message.reply.id, message.reply);
    });
    peer.send(JSON.stringify({ type: "welcome", connectionId: "test", serverVersion: appVersion }));
    for (const method of ["sessions.list", "files.search"])
      peer.send(JSON.stringify({ type: "rpc.request", id: method, method, params: {} }));
    await expect
      .poll(() => replies.get("sessions.list"))
      .toMatchObject({
        outcome: "failed",
        error: { code: "timeout" },
      });
    expect(signals.get("files.search")?.aborted).toBe(false);
    expect(replies.has("files.search")).toBe(false);
    await expect
      .poll(() => replies.get("files.search"), { timeout: 2000 })
      .toMatchObject({
        outcome: "failed",
        error: { code: "timeout" },
      });
    expect(signals.get("sessions.list")?.aborted).toBe(true);
    expect(signals.get("files.search")?.aborted).toBe(true);
  } finally {
    dispatch.mockRestore();
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
  const agent = new Agent(testConfig(root, { shell: "/bin/bash" }), {
    deviceId: "test",
    deviceToken: "test",
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  try {
    const connection = once(sockets, "connection");
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    const [peer] = (await connection) as [WebSocket];
    const replies: Record<string, unknown>[] = [];
    peer.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "rpc.result") replies.push(message.reply);
    });
    // Exercise the wire limit independently of how each tool produces its result.
    const dispatch = vi.spyOn(agent, "dispatch");
    const smallResult = { toJSON: vi.fn(() => ({ encoding: "first" })) };
    dispatch.mockResolvedValueOnce(smallResult);
    peer.send(
      JSON.stringify({
        type: "rpc.request",
        id: "encoded-once",
        method: "sessions.list",
        params: {},
      }),
    );
    await expect
      .poll(() => replies.find((reply) => reply.id === "encoded-once"))
      .toEqual({
        id: "encoded-once",
        outcome: "succeeded",
        result: { encoding: "first" },
      });
    expect(smallResult.toJSON).toHaveBeenCalledTimes(1);
    for (const outcome of ["failed", "partial", "unknown", "succeeded"] as const) {
      const large = "x".repeat(limits.controlMessageBytes);
      const largeResult = { toJSON: vi.fn(() => large) };
      if (outcome === "succeeded") dispatch.mockResolvedValueOnce(largeResult);
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
      if (outcome === "succeeded") expect(largeResult.toJSON).toHaveBeenCalledTimes(1);
    }
    for (const method of ["sessions.snapshot", "sessions.wait"]) {
      const ipc = {
        type: "reply",
        reply: { id: "i".repeat(36), outcome: "succeeded", result: "" },
      };
      // Fits the recorder's full envelope, but the public request ID makes RPC larger.
      ipc.reply.result = "x".repeat(
        limits.controlMessageBytes - Buffer.byteLength(JSON.stringify(ipc)) - 1,
      );
      expect(Buffer.byteLength(JSON.stringify(ipc) + "\n")).toBe(limits.controlMessageBytes);
      dispatch.mockResolvedValueOnce(ipc.reply.result);
      const id = method.padEnd(128, "x");
      peer.send(JSON.stringify({ type: "rpc.request", id, method, params: {} }));
      await expect
        .poll(() => replies.find((r) => r.id === id))
        .toMatchObject({ outcome: "failed", error: { code: "limit_exceeded" } });
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
