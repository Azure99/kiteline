import { expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { Agent } from "../src/agent.js";
import { privateDirectory } from "../src/config.js";
import { testConfig } from "./support/config.js";
import { ScheduledTasks } from "../src/tasks/index.js";
import { TemporaryFiles } from "../src/files/temporary.js";
import { Directories } from "../src/files/directories.js";
import { Repositories } from "../src/git/repos.js";
import { TerminalChannels } from "../src/terminal/channels.js";
import { FileChannels } from "../src/files/channels.js";
import { HttpChannels } from "../src/http/channels.js";
import {
  AppError,
  appVersion,
  type AgentControlMessage,
  type OperationError,
} from "@kiteline/shared/protocol";
import { localRequest } from "../src/local.js";

test("task changes wait for welcome and then publish the current snapshot", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-task-events-");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const messages: AgentControlMessage[] = [];
  const connected = new Promise<WebSocket>((resolve) => {
    server.once("connection", (socket) => {
      socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
      resolve(socket);
    });
  });
  const agent = new Agent(testConfig(root), {
    deviceId: "task-events",
    deviceToken: "task-events",
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  const snapshots = () => messages.filter((message) => message.type === "tasks.snapshot");
  try {
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    const socket = await connected;
    await expect.poll(() => messages.some((message) => message.type === "hello")).toBe(true);
    await localRequest(agent.config, "tasks.create", {
      taskId: "before-welcome",
      input: {
        name: "Before welcome",
        command: "true",
        cwd: root,
        timezone: "UTC",
        schedule: { kind: "cron", expression: "0 0 1 1 *" },
      },
    });
    const pong = once(socket, "pong");
    socket.ping();
    await pong;
    expect(snapshots()).toEqual([]);

    socket.send(
      JSON.stringify({ type: "welcome", connectionId: "task-events", serverVersion: appVersion }),
    );
    await expect
      .poll(() => snapshots())
      .toMatchObject([{ revision: 1, items: [{ id: "before-welcome", name: "Before welcome" }] }]);
    await localRequest(agent.config, "tasks.update", {
      taskId: "before-welcome",
      expectedRevision: 1,
      changes: { name: "After welcome" },
    });
    await expect
      .poll(() => snapshots().at(-1))
      .toMatchObject({
        revision: 2,
        items: [{ id: "before-welcome", name: "After welcome" }],
      });
  } finally {
    await agent.close();
    const closed = once(server, "close");
    server.close();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});

test("agent shutdown waits for an accepted workspace publication", async () => {
  const dataDir = await mkdtemp("/var/tmp/kiteline-workspace-publication-");
  const agent = new Agent(testConfig(dataDir), {
    deviceId: "test",
    deviceToken: "test",
    server: "https://localhost",
  });
  try {
    const operation = agent.dispatch(
      "workspaces.add",
      { absolutePath: dataDir },
      new AbortController().signal,
    );
    await agent.close();
    await expect(operation).resolves.toMatchObject({ path: dataDir });
    const value = JSON.parse(await readFile(join(dataDir, "agent.json"), "utf8")) as {
      workspaces: { path: string }[];
    };
    expect(value.workspaces[0]?.path).toBe(dataDir);
    await expect(
      agent.dispatch("workspaces.add", { absolutePath: dataDir }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  } finally {
    await agent.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("agent shutdown waits for cancelled bulk cleanup and its completion notification", async () => {
  const dataDir = await mkdtemp("/var/tmp/kiteline-bulk-shutdown-");
  const root = join(dataDir, "workspace");
  await mkdir(root);
  await writeFile(join(root, "source"), "published");
  const agent = new Agent(testConfig(dataDir), {
    deviceId: "test",
    deviceToken: "test",
    server: "https://localhost",
  });
  const changed = vi.spyOn(agent.watches, "notifyWritten").mockImplementation(() => {});
  const temporaryClose = vi.spyOn(TemporaryFiles.prototype, "close");
  const cacheClose = [
    vi.spyOn(Directories.prototype, "close"),
    vi.spyOn(Repositories.prototype, "close"),
    vi.spyOn(agent.watches, "close"),
  ];
  const controller = new AbortController();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const create = TemporaryFiles.prototype.create;
  const held = vi.spyOn(TemporaryFiles.prototype, "create").mockImplementationOnce(async function (
    this: TemporaryFiles,
    ...args
  ) {
    const file = await create.apply(this, args);
    const dispose = file.dispose.bind(file);
    file.dispose = async () => {
      controller.abort(new AppError("cancelled", "Cancelled after publication"));
      await gate;
      await dispose();
    };
    return file;
  });
  try {
    const workspace = await agent.metadata.add(root);
    const response = agent.dispatch(
      "files.copy",
      {
        workspaceId: workspace.id,
        items: [
          { path: "source", targetPath: "published", collision: "error" },
          { path: "source", targetPath: "pending", collision: "error" },
        ],
      },
      controller.signal,
    );
    const error = await response.catch((error: OperationError) => error);
    expect(error).toMatchObject({
      outcome: "partial",
      result: {
        items: [{ outcome: "succeeded" }, { outcome: "failed", error: { code: "cancelled" } }],
      },
    });
    const snapshot = structuredClone((error as OperationError).result);
    expect(await readFile(join(root, "published"), "utf8")).toBe("published");
    expect(changed).not.toHaveBeenCalled();
    let closed = false;
    const closing = agent.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(temporaryClose).not.toHaveBeenCalled();
    for (const close of cacheClose) expect(close).not.toHaveBeenCalled();
    resume();
    await closing;
    expect(temporaryClose).toHaveBeenCalledOnce();
    for (const close of cacheClose) expect(close).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledExactlyOnceWith(workspace.id);
    expect((error as OperationError).result).toEqual(snapshot);
    await expect(access(join(root, "pending"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    resume();
    await agent.close();
    held.mockRestore();
    changed.mockRestore();
    temporaryClose.mockRestore();
    for (const close of cacheClose) close.mockRestore();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("shutdown settles every cleanup phase and owns cleanup after socket termination", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-cleanup-phases-");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const agent = new Agent(testConfig(root), {
    deviceId: "cleanup-phases",
    deviceToken: "cleanup-phases",
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  let releaseChannels!: () => void;
  const channelsHeld = new Promise<void>((resolve) => {
    releaseChannels = resolve;
  });
  let releaseCaches!: () => void;
  const cachesHeld = new Promise<void>((resolve) => {
    releaseCaches = resolve;
  });
  const terminalFailure = new Error("Terminal cleanup fixture failure");
  const httpFailure = new Error("HTTP cleanup fixture failure");
  const directoryFailure = new Error("Directory cleanup fixture failure");
  const terminalClose = TerminalChannels.prototype.close;
  const terminal = vi.spyOn(TerminalChannels.prototype, "close").mockImplementation(async function (
    this: TerminalChannels,
  ) {
    await terminalClose.call(this);
    throw terminalFailure;
  });
  const httpClose = HttpChannels.prototype.close;
  const http = vi.spyOn(HttpChannels.prototype, "close").mockImplementation(function (
    this: HttpChannels,
  ) {
    httpClose.call(this);
    throw httpFailure;
  });
  const fileClose = FileChannels.prototype.close;
  const files = vi.spyOn(FileChannels.prototype, "close").mockImplementation(async function (
    this: FileChannels,
  ) {
    await channelsHeld;
    await fileClose.call(this);
  });
  const directoryClose = Directories.prototype.close;
  const directories = vi.spyOn(Directories.prototype, "close").mockImplementation(async function (
    this: Directories,
  ) {
    await directoryClose.call(this);
    throw directoryFailure;
  });
  const repoClose = Repositories.prototype.close;
  const repos = vi.spyOn(Repositories.prototype, "close").mockImplementation(async function (
    this: Repositories,
  ) {
    await cachesHeld;
    await repoClose.call(this);
  });
  const watches = vi.spyOn(agent.watches, "close");
  const temporary = vi.spyOn(TemporaryFiles.prototype, "close");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const connected = once(server, "connection");
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    const [peer] = (await connected) as [WebSocket];
    await once(peer, "message");
    const socketClosed = once(peer, "close");
    let finished = false;
    const closing = agent.close().catch((error: unknown) => {
      finished = true;
      return error;
    });
    await socketClosed;
    await expect.poll(() => files.mock.calls.length).toBe(1);
    expect(terminal).toHaveBeenCalledOnce();
    expect(http).toHaveBeenCalledOnce();
    expect(temporary).not.toHaveBeenCalled();
    expect(directories).not.toHaveBeenCalled();
    expect(repos).not.toHaveBeenCalled();
    expect(watches).not.toHaveBeenCalled();
    expect(finished).toBe(false);

    releaseChannels();
    await expect.poll(() => repos.mock.calls.length).toBe(1);
    expect(temporary).toHaveBeenCalledOnce();
    expect(directories).toHaveBeenCalledOnce();
    expect(watches).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    releaseCaches();
    const failure = await closing;
    expect(failure).toBeInstanceOf(AggregateError);
    const causes = (error: unknown): unknown[] =>
      error instanceof AggregateError ? error.errors.flatMap(causes) : [error];
    const errors = causes(failure);
    expect(errors).toHaveLength(3);
    expect(errors).toEqual(
      expect.arrayContaining([terminalFailure, httpFailure, directoryFailure]),
    );
    for (const close of [terminal, http, files, temporary, directories, repos, watches])
      expect(close).toHaveBeenCalledOnce();
    expect(logged).not.toHaveBeenCalled();
  } finally {
    releaseChannels();
    releaseCaches();
    await agent.close().catch(() => {});
    for (const spy of [terminal, http, files, temporary, directories, repos, watches, logged])
      spy.mockRestore();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("control disconnect reports cleanup failures without stopping local owners", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-disconnect-cleanup-");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const agent = new Agent(testConfig(root), {
    deviceId: "disconnect-cleanup",
    deviceToken: "disconnect-cleanup",
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  const failure = new Error("Disconnected HTTP cleanup fixture failure");
  const httpClose = HttpChannels.prototype.close;
  const http = vi.spyOn(HttpChannels.prototype, "close").mockImplementationOnce(function (
    this: HttpChannels,
  ) {
    httpClose.call(this);
    throw failure;
  });
  const files = vi.spyOn(FileChannels.prototype, "close");
  const cacheFailure = new Error("Disconnected directory cleanup fixture failure");
  const directoryClose = Directories.prototype.close;
  const directories = vi
    .spyOn(Directories.prototype, "close")
    .mockImplementationOnce(async function (this: Directories) {
      await directoryClose.call(this);
      throw cacheFailure;
    });
  const sessionClose = vi.spyOn(agent.sessions, "close");
  const taskClose = vi.spyOn(agent.schedules, "close");
  const temporary = vi.spyOn(TemporaryFiles.prototype, "close");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const add = agent.metadata.add.bind(agent.metadata);
  const observed = vi.spyOn(agent.metadata, "add").mockImplementationOnce(async (...args) => {
    await held;
    return add(...args);
  });
  try {
    const connected = once(server, "connection");
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    await agent.start();
    const [peer] = (await connected) as [WebSocket];
    const operation = agent.dispatch(
      "workspaces.add",
      { absolutePath: root },
      new AbortController().signal,
    );
    const reconnected = once(server, "connection");
    peer.close();
    await expect.poll(() => files.mock.calls.length).toBe(1);
    await expect.poll(() => directories.mock.calls.length).toBe(1);
    await expect
      .poll(() =>
        logged.mock.calls.some(
          ([error]) => error instanceof AggregateError && error.errors.includes(failure),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        logged.mock.calls.some(
          ([error]) => error instanceof AggregateError && error.errors.includes(cacheFailure),
        ),
      )
      .toBe(true);
    expect(sessionClose).not.toHaveBeenCalled();
    expect(taskClose).not.toHaveBeenCalled();
    expect(temporary).not.toHaveBeenCalled();
    expect(await localRequest(agent.config, "sessions.list")).toEqual({ sessions: [] });
    await localRequest(agent.config, "tasks.create", {
      taskId: "after-disconnect",
      input: {
        name: "After disconnect",
        command: "true",
        cwd: root,
        timezone: "UTC",
        schedule: { kind: "cron", expression: "0 0 1 1 *" },
      },
    });
    await reconnected;
    release();
    await expect(operation).resolves.toMatchObject({ path: root });
  } finally {
    release();
    await agent.close();
    for (const spy of [
      http,
      files,
      directories,
      sessionClose,
      taskClose,
      temporary,
      logged,
      observed,
    ])
      spy.mockRestore();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test.runIf(process.platform !== "win32")(
  "real main owns its runtime directory until normal cleanup completes",
  async () => {
    const root = await mkdtemp("/var/tmp/kiteline-runtime-owner-");
    const other = join(root, "other");
    const config = testConfig(root, { runDir: root });
    const children: { child: ReturnType<typeof spawn>; ended: ReturnType<typeof once> }[] = [];
    function start(dataDir: string) {
      const child = spawn(process.execPath, [resolve("packages/agent/dist/main.js"), "run"], {
        env: { ...process.env, KITELINE_AGENT_HOME: dataDir, KITELINE_AGENT_RUN_DIR: root },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (part) => {
        output += part.toString();
      });
      child.stderr.on("data", (part) => {
        output += part.toString();
      });
      const running = { child, ended: once(child, "close"), output: () => output };
      children.push(running);
      return running;
    }
    try {
      const unbound = start(root);
      expect((await unbound.ended)[0], unbound.output()).toBe(1);
      expect(unbound.output()).toContain("Device is not bound");
      await mkdir(other);
      const identity = JSON.stringify({
        deviceId: "runtime-test",
        deviceToken: "runtime-test",
        server: "http://127.0.0.1:1",
      });
      for (const dataDir of [root, other])
        await writeFile(join(dataDir, "connection.json"), identity);
      const first = start(root);
      await expect.poll(() => localRequest(config, "workspaces.list")).toEqual({ workspaces: [] });
      const blocked = start(other);
      expect((await blocked.ended)[0], blocked.output()).toBe(1);
      expect(blocked.output()).toContain("ELOCKED");
      expect(await localRequest(config, "workspaces.list")).toEqual({ workspaces: [] });
      first.child.kill("SIGTERM");
      expect((await first.ended)[0], first.output()).toBe(0);
      const next = start(other);
      await expect.poll(() => localRequest(config, "workspaces.list")).toEqual({ workspaces: [] });
      next.child.kill("SIGTERM");
      expect((await next.ended)[0], next.output()).toBe(0);
    } finally {
      for (const running of children) {
        if (running.child.exitCode === null && running.child.signalCode === null)
          running.child.kill("SIGTERM");
        await running.ended;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("stopping during schedule load prevents late timers and local admission, and waits once", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-startup-test-");
  const config = testConfig(root);
  const saved = new ScheduledTasks(config, () => {});
  const agent = new Agent(config, {
    deviceId: "test",
    deviceToken: "test",
    server: "http://127.0.0.1:1",
  });
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const load = agent.schedules.load.bind(agent.schedules);
  const paused = vi.spyOn(agent.schedules, "load").mockImplementation(async () => {
    await held;
    await load();
  });
  try {
    await saved.load();
    await saved.create(
      "once",
      {
        name: "once",
        command: "printf no > should-not-run",
        cwd: root,
        timezone: "UTC",
        schedule: { kind: "once", at: new Date(Date.now() + 500).toISOString() },
      },
      new AbortController().signal,
    );
    await saved.close();
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    const starting = agent.start();
    await expect.poll(() => paused.mock.calls.length).toBe(1);
    let closed = false;
    const closing = agent.close();
    void closing.then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    resume();
    await Promise.all([starting, closing]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(access(join(root, "should-not-run"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(config.runDir, "agent.sock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      agent.dispatch("sessions.list", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  } finally {
    resume();
    paused.mockRestore();
    await agent.close();
    await saved.close();
    await rm(root, { recursive: true, force: true });
  }
});
