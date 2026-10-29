import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  lstat,
  rm,
  symlink,
  chmod,
  stat,
  link,
  readdir,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { AppError, OperationError, limits } from "@kiteline/shared/protocol";
import { withPublicationLock } from "../src/files/publish.js";
import { FileOperations } from "../src/files/operations.js";
import { TemporaryFiles, type StagedFile } from "../src/files/temporary.js";
import { Files } from "../src/files/index.js";
import { MetadataStore } from "../src/metadata.js";
import { Directories } from "../src/files/directories.js";
import { testConfig } from "./support/config.js";
import { BinaryFiles } from "../src/files/upload.js";
import { TextFiles } from "../src/files/save.js";
import { FileChannels } from "../src/files/channels.js";
import * as renameFiles from "../src/files/rename.js";
import * as fileReads from "../src/files/read.js";
import { stateFiles } from "../src/config.js";
import { CursorBudget } from "../src/cursor-budget.js";

const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(changed: (workspaceId: string) => void = vi.fn()) {
  const data = await mkdtemp("/var/tmp/kiteline-file-operations-");
  cleanups.push(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "workspace");
  await mkdir(root);
  const config = testConfig(data);
  const metadata = new MetadataStore(config, () => {});
  const workspace = await metadata.add(root);
  const temporary = new TemporaryFiles(data);
  cleanups.push(() => temporary.close());
  const directories = new Directories(new CursorBudget());
  cleanups.push(() => directories.close());
  const operations = new FileOperations(metadata, temporary, changed);
  cleanups.push(() => operations.close());
  return {
    config,
    metadata,
    root,
    data,
    temporary,
    files: new Files(metadata, directories, changed),
    binary: new BinaryFiles(config, metadata, temporary),
    text: new TextFiles(config, metadata, temporary),
    operations,
    id: workspace.id,
    run: (
      kind: "copy" | "move" | "delete",
      inputs: unknown,
      signal = new AbortController().signal,
    ) => operations.run(kind, workspace.id, inputs, signal),
  };
}
const copy = (path: string, targetPath: string) => [{ path, targetPath, collision: "error" }];

function observeNextFile(temporary: TemporaryFiles, observe: (file: StagedFile) => void) {
  const create = temporary.create.bind(temporary);
  vi.spyOn(temporary, "create").mockImplementationOnce(async (...args) => {
    const file = await create(...args);
    observe(file);
    return file;
  });
}

async function channelServer(
  f: Awaited<ReturnType<typeof setup>>,
  notifyWritten: (workspaceId: string) => void = vi.fn(),
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const channels = new FileChannels(
    f.text,
    f.binary,
    f.metadata,
    f.config,
    {
      deviceId: "test",
      deviceToken: "test",
      server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
    notifyWritten,
  );
  cleanups.push(async () => {
    await channels.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function connect(id: string, kind: string, params: Record<string, unknown>) {
    const incoming = once(server, "connection");
    channels.open(id, "test", kind, { workspaceId: f.id, ...params });
    const [socket] = (await incoming) as [WebSocket];
    const controls: Record<string, unknown>[] = [];
    const body: Buffer[] = [];
    const order: string[] = [];
    socket.on("message", (data, binary) => {
      if (binary) {
        body.push(data as Buffer);
        order.push("body");
      } else {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        controls.push(frame);
        order.push(String(frame.type));
      }
    });
    socket.on("close", () => order.push("close"));
    return { socket, controls, body, order, closed: once(socket, "close") };
  }
  return { channels, connect };
}

test("file channel sizes use the write owner's byte limit before creating temporary files", async () => {
  const f = await setup();
  f.config.limits.editorBytes = 4;
  f.config.limits.transferBytes = 8;
  const notifyWritten = vi.fn();
  const { channels, connect } = await channelServer(f, notifyWritten);
  for (const purpose of ["save", "upload"]) {
    const limit = purpose === "save" ? 4 : 8;
    for (const size of [limit, limit + 1, -1]) {
      const { socket } = await connect(`${purpose}-${size}`, "file.write", {
        workspaceId: f.id,
        path: "new-file",
        purpose,
        size,
        createOnly: true,
      });
      const [raw] = await once(socket, "message");
      const message = JSON.parse(raw.toString());
      if (size === limit) {
        expect(message.type).toBe("ready");
        expect(await readdir(f.root)).toHaveLength(1);
      } else {
        expect(message).toMatchObject({
          type: "error",
          code: size < 0 ? "invalid_argument" : "limit_exceeded",
        });
        expect(await readdir(f.root)).toEqual([]);
      }
      socket.close(1000);
      await expect.poll(() => channels.count).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
      expect(notifyWritten).not.toHaveBeenCalled();
    }
  }
});

test.each(["save", "upload"])(
  "%s channels notify only after published or uncertain writes and before results",
  async (purpose) => {
    const f = await setup();
    const events: string[] = [];
    let target = "";
    const { channels, connect } = await channelServer(f, (workspaceId) => {
      expect(workspaceId).toBe(f.id);
      expect(readFileSync(join(f.root, target), "utf8")).toBe("data");
      events.push("changed");
    });
    for (const outcome of ["incomplete", "succeeded", "unknown"]) {
      events.length = 0;
      target = `${purpose}-${outcome}`;
      const { socket } = await connect(target, "file.write", {
        workspaceId: f.id,
        path: target,
        purpose,
        size: 4,
        createOnly: true,
      });
      const [ready] = await once(socket, "message");
      expect(JSON.parse(ready.toString()).type).toBe("ready");
      expect(events).toEqual([]);
      if (outcome === "unknown") {
        const renameEntry = renameFiles.renameEntry;
        vi.spyOn(renameFiles, "renameEntry").mockImplementationOnce(async (...args) => {
          await renameEntry(...args);
          throw new OperationError("io_error", "Publication completion is unconfirmed", "unknown");
        });
      }
      const result = once(socket, "message");
      socket.send(JSON.stringify({ type: "start" }));
      if (outcome !== "incomplete") socket.send(Buffer.from("data"));
      socket.send(JSON.stringify({ type: "end" }));
      const [raw] = await result;
      events.push("result");
      expect(JSON.parse(raw.toString())).toMatchObject({
        type: "result",
        reply: { outcome: outcome === "incomplete" ? "failed" : outcome },
      });
      expect(events).toEqual(outcome === "incomplete" ? ["result"] : ["changed", "result"]);
      await expect.poll(() => channels.count).toBe(0);
      expect((await readdir(f.root)).some((name) => name.startsWith(".kiteline-"))).toBe(false);
      if (outcome === "incomplete")
        await expect(lstat(join(f.root, target))).rejects.toMatchObject({ code: "ENOENT" });
      vi.restoreAllMocks();
    }
  },
);

function gate() {
  let resume!: () => void;
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return { wait, resume };
}

test.each(["cancel", "early start"])(
  "%s during file preparation retains capacity and cleans the late resource",
  async (ending) => {
    const f = await setup();
    f.config.limits.transfersPerDevice = 1;
    const { channels, connect } = await channelServer(f);
    const preparation = gate();
    const prepare = f.binary.prepare.bind(f.binary);
    let prepared = false;
    vi.spyOn(f.binary, "prepare").mockImplementationOnce(async (...args) => {
      const item = await prepare(...args);
      prepared = true;
      await preparation.wait;
      return item;
    });
    try {
      const pending = await connect("late", "file.write", {
        path: "late",
        purpose: "upload",
        size: 4,
        createOnly: true,
      });
      await expect.poll(() => prepared).toBe(true);
      expect(await readdir(f.root)).toHaveLength(1);
      if (ending === "cancel") channels.cancel("late");
      else pending.socket.send(JSON.stringify({ type: "start" }));
      const [code] = await pending.closed;
      if (ending === "early start") {
        expect(pending.controls).toMatchObject([{ type: "error", code: "invalid_argument" }]);
        expect(pending.order).toEqual(["error", "close"]);
        expect(code).toBe(1000);
      } else expect(pending.controls).toEqual([]);
      expect(channels.count).toBe(1);
      // Admission wins over malformed parameters while the late resource is still owned.
      const busy = await connect("busy", "file.write", {});
      expect((await busy.closed)[0]).toBe(1000);
      expect(busy.controls).toMatchObject([{ type: "error", code: "busy" }]);
      expect(await readdir(f.root)).toHaveLength(1);
      preparation.resume();
      await expect.poll(() => channels.count).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
      expect(JSON.parse(await readFile(join(f.data, stateFiles.temporaryFiles), "utf8"))).toEqual(
        [],
      );
      const next = await connect("next", "file.write", {
        path: "next",
        purpose: "upload",
        size: 0,
        createOnly: true,
      });
      await expect.poll(() => next.controls).toMatchObject([{ type: "ready" }]);
    } finally {
      preparation.resume();
      await channels.close();
    }
  },
);

test("file channel cleanup waits for the writing frame and staged disposal before releasing capacity", async () => {
  const f = await setup();
  f.config.limits.transfersPerDevice = 1;
  const { channels, connect } = await channelServer(f);
  const writing = gate();
  const disposing = gate();
  let written = false;
  let disposalStarted = false;
  observeNextFile(f.temporary, (file) => {
    const write = file.write.bind(file);
    vi.spyOn(file, "write").mockImplementationOnce(async (...args) => {
      await write(...args);
      written = true;
      await writing.wait;
    });
    const dispose = file.dispose.bind(file);
    vi.spyOn(file, "dispose").mockImplementationOnce(async () => {
      disposalStarted = true;
      await disposing.wait;
      await dispose();
    });
  });
  try {
    const pending = await connect("writing", "file.write", {
      path: "target",
      purpose: "upload",
      size: 4,
      createOnly: true,
    });
    await expect.poll(() => pending.controls).toMatchObject([{ type: "ready" }]);
    pending.socket.send(JSON.stringify({ type: "start" }));
    pending.socket.send(Buffer.from("data"));
    await expect.poll(() => written).toBe(true);
    channels.cancel("writing");
    await pending.closed;
    let closed = false;
    const closing = channels.close().then(() => {
      closed = true;
    });
    const busyWriting = await connect("busy-writing", "file.write", {});
    await busyWriting.closed;
    expect(busyWriting.controls).toMatchObject([{ type: "error", code: "busy" }]);
    expect(disposalStarted).toBe(false);
    expect(closed).toBe(false);
    expect(channels.count).toBe(1);
    writing.resume();
    await expect.poll(() => disposalStarted).toBe(true);
    const busyDisposing = await connect("busy-disposing", "file.write", {});
    await busyDisposing.closed;
    expect(busyDisposing.controls).toMatchObject([{ type: "error", code: "busy" }]);
    expect(closed).toBe(false);
    expect(channels.count).toBe(1);
    const [temporary] = await readdir(f.root);
    expect(await readFile(join(f.root, temporary!), "utf8")).toBe("data");
    disposing.resume();
    await closing;
    expect(channels.count).toBe(0);
    expect(await readdir(f.root)).toEqual([]);
    expect(JSON.parse(await readFile(join(f.data, stateFiles.temporaryFiles), "utf8"))).toEqual([]);
    const next = await connect("next", "file.write", {
      path: "next",
      purpose: "upload",
      size: 0,
      createOnly: true,
    });
    await expect.poll(() => next.controls).toMatchObject([{ type: "ready" }]);
  } finally {
    writing.resume();
    disposing.resume();
    await channels.close();
  }
});

test.each(["excess body", "repeated start"])(
  "file channels send an error before graceful close for %s",
  async (violation) => {
    const f = await setup();
    const { channels, connect } = await channelServer(f);
    const peer = await connect("invalid", "file.write", {
      path: "target",
      purpose: "upload",
      size: 4,
      createOnly: true,
    });
    await expect.poll(() => peer.controls).toMatchObject([{ type: "ready" }]);
    peer.socket.send(JSON.stringify({ type: "start" }));
    peer.socket.send(
      violation === "excess body" ? Buffer.from("extra") : JSON.stringify({ type: "start" }),
    );
    expect((await peer.closed)[0]).toBe(1000);
    expect(peer.controls).toMatchObject([
      { type: "ready" },
      { type: "error", code: "invalid_argument" },
    ]);
    expect(peer.order).toEqual(["ready", "error", "close"]);
    await expect.poll(() => channels.count).toBe(0);
    expect(await readdir(f.root)).toEqual([]);
  },
);

test("file reads finish before their last body block is sent", async () => {
  const f = await setup();
  const body = Buffer.alloc(limits.dataChunkBytes * 2 + 3, 0x61);
  await writeFile(join(f.root, "source"), body);
  const { channels, connect } = await channelServer(f);
  const finishing = gate();
  let finished = false;
  const read = fileReads.readWorkspaceFile;
  vi.spyOn(fileReads, "readWorkspaceFile").mockImplementationOnce(async (...args) => {
    const resource = await read(...args);
    const finish = resource.finish.bind(resource);
    resource.finish = async () => {
      await finish();
      finished = true;
      await finishing.wait;
    };
    return resource;
  });
  try {
    const peer = await connect("read", "file.read", { path: "source", purpose: "download" });
    await expect.poll(() => peer.controls).toMatchObject([{ type: "ready" }]);
    peer.socket.send(JSON.stringify({ type: "start" }));
    await expect.poll(() => finished).toBe(true);
    await expect.poll(() => Buffer.concat(peer.body).length).toBeGreaterThan(0);
    expect(Buffer.concat(peer.body).length).toBeLessThan(body.length);
    finishing.resume();
    expect((await peer.closed)[0]).toBe(1000);
    expect(Buffer.concat(peer.body)).toEqual(body);
    await expect.poll(() => channels.count).toBe(0);
  } finally {
    finishing.resume();
    await channels.close();
  }
});

test("empty downloads close their actual handle before ready is sent", async () => {
  const f = await setup();
  const path = join(f.root, "empty");
  await writeFile(path, "");
  const { channels, connect } = await channelServer(f);
  const closing = gate();
  let closeStarted = false;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === path) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        closeStarted = true;
        await closing.wait;
        await close();
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const peer = await connect("empty", "file.read", { path: "empty", purpose: "download" });
    await expect.poll(() => closeStarted).toBe(true);
    expect(peer.controls).toEqual([]);
    closing.resume();
    await expect.poll(() => peer.controls).toMatchObject([{ type: "ready", meta: { size: 0 } }]);
    peer.socket.send(JSON.stringify({ type: "start" }));
    expect((await peer.closed)[0]).toBe(1000);
    expect(peer.body).toEqual([]);
    await expect.poll(() => channels.count).toBe(0);
  } finally {
    closing.resume();
    await channels.close();
  }
});

test("cancel settles while cleanup waits for a real publication owner and later removes temporary files", async () => {
  const changed = vi.fn();
  const { root, id, operations, temporary } = await setup(changed);
  await writeFile(join(root, "source"), Buffer.alloc(150000, 97));
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let owner: Promise<void> | undefined;
  observeNextFile(temporary, (file) => {
    const write = file.write.bind(file);
    vi.spyOn(file, "write").mockImplementationOnce(async (...args) => {
      await write(...args);
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      owner = withPublicationLock(async () => {
        entered();
        await gate;
      });
      await ready;
      controller.abort(new AppError("cancelled", "Cancel copying"));
    });
  });
  try {
    await expect(
      operations.run("copy", id, copy("source", "target"), controller.signal),
    ).rejects.toMatchObject({ outcome: "failed", code: "cancelled" });
    const pending = (await readdir(root)).filter((name) => name.startsWith(".kiteline-"));
    expect(pending).toHaveLength(1);
    expect((await stat(join(root, pending[0]!))).size).toBeGreaterThan(0);
    await expect(lstat(join(root, "target"))).rejects.toMatchObject({ code: "ENOENT" });
    let closed = false;
    void operations.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    release();
    await owner;
    await operations.close();
  }
  expect(await readdir(root)).toEqual(["source"]);
  expect(changed).toHaveBeenCalledExactlyOnceWith(id);
});

test.each([1, 2])(
  "cancellation after confirmed publication uses business facts for %i selected items",
  async (count) => {
    const { root, id, operations, temporary } = await setup();
    await writeFile(join(root, "source"), "confirmed");
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    observeNextFile(temporary, (file) => {
      const dispose = file.dispose.bind(file);
      vi.spyOn(file, "dispose").mockImplementationOnce(async () => {
        controller.abort(new AppError("cancelled", "Late cancellation"));
        await gate;
        await dispose();
      });
    });
    let snapshot: unknown;
    let captured: unknown;
    try {
      const result = operations.run(
        "copy",
        id,
        Array.from({ length: count }, (_, i) => ({
          path: "source",
          targetPath: `target${i}`,
          collision: "error",
        })),
        controller.signal,
      );
      snapshot = await result.catch((error: OperationError) => error.result);
      captured = structuredClone(snapshot);
      if (count === 1)
        await expect(result).resolves.toMatchObject({ items: [{ outcome: "succeeded" }] });
      else
        await expect(result).rejects.toMatchObject({
          outcome: "partial",
          result: {
            items: [{ outcome: "succeeded" }, { outcome: "failed", error: { code: "cancelled" } }],
          },
        });
      expect(await readFile(join(root, "target0"), "utf8")).toBe("confirmed");
    } finally {
      release();
      await operations.close();
    }
    expect(snapshot).toEqual(captured);
  },
);

test("upload can lose its access route without writing to a different target", async () => {
  const { root, id, files, binary } = await setup();
  const signal = new AbortController().signal;
  await mkdir(join(root, "physical"));
  await symlink("physical", join(root, "route"));
  const upload = await binary.prepare(id, "route/result", 4, true, undefined, signal);
  try {
    await upload.temporary.write(Buffer.from("data"), signal);
    await files.rename(id, "route", "moved", signal);
    await expect(binary.save(upload, signal)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(root, "route"));
    await expect(binary.save(upload, signal)).rejects.toMatchObject({ code: "conflict" });
    expect(await readdir(join(root, "route"))).toEqual([]);
  } finally {
    await upload.temporary.dispose();
  }
  expect(await readdir(join(root, "physical"))).toEqual([]);
});

test("copy preserves regular permissions and links; explicit replacement changes the link entry only", async () => {
  const { root, files, id, run } = await setup();
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source/a"), Buffer.from([0, 1, 255, 10]));
  await chmod(join(root, "source/a"), 0o640);
  await symlink("a", join(root, "source/link"));
  await symlink(Buffer.from([255]), join(root, "source/raw-link"));
  await chmod(join(root, "source"), 0o750);
  await expect(run("copy", copy("source", "target"))).resolves.toMatchObject({
    items: [{ outcome: "succeeded", completedItems: 4 }],
  });
  expect((await stat(join(root, "target"))).mode & 0o777).toBe(0o750);
  expect(await readFile(join(root, "target/a"))).toEqual(Buffer.from([0, 1, 255, 10]));
  expect((await stat(join(root, "target/a"))).mode & 0o777).toBe(0o640);
  expect(await readlink(join(root, "target/link"))).toBe("a");
  expect(await readlink(join(root, "target/raw-link"), { encoding: "buffer" })).toEqual(
    Buffer.from([255]),
  );
  await writeFile(join(root, "shared"), "keep");
  await symlink("shared", join(root, "config"));
  const inspection = await files.inspect(id, "config");
  await run("copy", [
    {
      path: "source/a",
      targetPath: "config",
      collision: "replace",
      expectedTargetVersion: inspection.targetVersion,
    },
  ]);
  expect((await lstat(join(root, "config"))).isFile()).toBe(true);
  expect(await readFile(join(root, "shared"), "utf8")).toBe("keep");
  await expect(run("copy", copy("source", "target"))).rejects.toMatchObject({
    outcome: "failed",
    code: "conflict",
  });
  await expect(run("copy", copy("source", "source/nested"))).rejects.toMatchObject({
    outcome: "failed",
    code: "invalid_argument",
  });
  await link(join(root, "shared"), join(root, "hard-link"));
  await expect(
    run("move", [
      {
        path: "shared",
        targetPath: "hard-link",
        collision: "replace",
        expectedTargetVersion: (await files.inspect(id, "hard-link")).targetVersion,
      },
    ]),
  ).rejects.toMatchObject({ outcome: "failed", code: "invalid_argument" });
  expect(await readFile(join(root, "shared"), "utf8")).toBe("keep");
});

test.each(["file", "directory"])(
  "same-filesystem %s moves retain the object and count one item",
  async (kind) => {
    const { root, run } = await setup();
    const source = join(root, "source");
    if (kind === "directory") {
      await mkdir(source);
      await writeFile(join(source, "child"), "contents");
    } else await writeFile(source, "contents");
    const before = await lstat(source);
    await expect(run("move", copy("source", "target"))).resolves.toMatchObject({
      items: [{ outcome: "succeeded", completedItems: 1 }],
    });
    await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(root, "target"))).ino).toBe(before.ino);
    expect(
      await readFile(join(root, kind === "directory" ? "target/child" : "target"), "utf8"),
    ).toBe("contents");
  },
);

test.each(["write", "close"] as const)(
  "temporary %s failure cleans up before copying returns",
  async (method) => {
    const { root, temporary, run } = await setup();
    await writeFile(join(root, "source"), "contents");
    observeNextFile(temporary, (file) => {
      if (method === "write") {
        const write = file.write.bind(file);
        vi.spyOn(file, "write").mockImplementationOnce(async (...args) => {
          await write(...args);
          throw new AppError("io_error", "Write completion failed");
        });
      } else {
        const close = file.handle.close.bind(file.handle);
        vi.spyOn(file.handle, "close").mockImplementationOnce(async () => {
          await close();
          throw new AppError("io_error", "Close completion failed");
        });
      }
    });
    await expect(run("copy", copy("source", "target"))).rejects.toMatchObject({
      outcome: "failed",
      code: "io_error",
      result: { items: [{ completedItems: 0 }] },
    });
    expect(await readdir(root)).toEqual(["source"]);
  },
);

test("copy rechecks a competing target after reading and retains it", async () => {
  const { root, temporary, run } = await setup();
  await writeFile(join(root, "source"), "copied");
  observeNextFile(temporary, (file) => {
    const close = file.handle.close.bind(file.handle);
    vi.spyOn(file.handle, "close").mockImplementationOnce(async () => {
      await close();
      await writeFile(join(root, "target"), "competitor", { flag: "wx" });
    });
  });
  await expect(run("copy", copy("source", "target"))).rejects.toMatchObject({
    outcome: "failed",
    code: "conflict",
  });
  expect(await readFile(join(root, "target"), "utf8")).toBe("competitor");
  expect((await readdir(root)).sort()).toEqual(["source", "target"]);
});

test("recursive failures retain successful siblings and deletion never follows a final symlink", async () => {
  const { root, data, run } = await setup();
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source/a"), "A");
  await exec("mkfifo", [join(root, "source/pipe")]);
  await expect(run("copy", copy("source", "target"))).rejects.toMatchObject({
    outcome: "partial",
    result: { items: [{ outcome: "partial" }] },
  });
  expect(await readFile(join(root, "target/a"), "utf8")).toBe("A");
  await writeFile(join(data, "outside"), "keep");
  await symlink(join(data, "outside"), join(root, "source/link"));
  await expect(run("delete", ["source"])).rejects.toMatchObject({ outcome: "partial" });
  expect(await readFile(join(data, "outside"), "utf8")).toBe("keep");
  await expect(lstat(join(root, "source/a"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(join(root, "source/pipe"))).isFIFO()).toBe(true);
  await expect(run("delete", ["."])).rejects.toMatchObject({
    outcome: "failed",
    code: "invalid_argument",
  });
});

test("cancellation preserves published directory and stops scheduling its children", async () => {
  const { root, operations, id } = await setup();
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source/a"), "A");
  const controller = new AbortController();
  await expect(
    operations.run("copy", id, copy("source", "target"), controller.signal, (progress) => {
      if (progress.completedItems) controller.abort(new Error("cancel"));
    }),
  ).rejects.toMatchObject({ outcome: "partial" });
  expect((await lstat(join(root, "target"))).isDirectory()).toBe(true);
  await expect(lstat(join(root, "target/a"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("cross-filesystem move publishes before deleting only its copied source; bind deletion enters visible data", async (context) => {
  const changed = vi.fn();
  const { root, data, run, temporary, operations, id } = await setup(changed);
  const disk = join(root, "disk");
  await mkdir(disk);
  try {
    await exec("mount", ["-t", "tmpfs", "-o", "size=1m", "tmpfs", disk]);
  } catch (error) {
    if (
      /permission denied|Operation not permitted|must be superuser to use mount/.test(String(error))
    ) {
      context.skip();
    }
    throw error;
  }
  cleanups.push(async () => {
    await exec("umount", [disk]);
    expect((await stat(disk)).dev).toBe((await stat(root)).dev);
    console.info("EXDEV fixture unmounted:", disk);
  });
  const sourceDevice = (await stat(disk)).dev;
  const targetDevice = (await stat(root)).dev;
  expect(sourceDevice).not.toBe(targetDevice);
  console.info("EXDEV fixture:", { disk, root, sourceDevice, targetDevice });
  await writeFile(join(disk, "source"), "cross-device");
  await run("move", copy("disk/source", "moved"));
  expect(await readFile(join(root, "moved"), "utf8")).toBe("cross-device");
  await expect(lstat(join(disk, "source"))).rejects.toMatchObject({ code: "ENOENT" });
  await symlink(Buffer.from([255]), join(disk, "link"));
  await run("move", copy("disk/link", "moved-link"));
  expect(await readlink(join(root, "moved-link"), { encoding: "buffer" })).toEqual(
    Buffer.from([255]),
  );
  await symlink(disk, join(root, "disk-link"));
  await run("move", copy("disk-link", "disk-link/relocated"));
  expect(await readlink(join(disk, "relocated"))).toBe(disk);
  await expect(lstat(join(root, "disk-link"))).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(join(disk, "directory"), { mode: 0o750 });
  await writeFile(join(disk, "directory/child"), "directory contents", { mode: 0o640 });
  const directoryResult = await run("move", copy("disk/directory", "directory"));
  expect(directoryResult).toMatchObject({
    items: [{ outcome: "succeeded", completedItems: 2 }],
  });
  await expect(lstat(join(disk, "directory"))).rejects.toMatchObject({ code: "ENOENT" });
  const directoryContent = await readFile(join(root, "directory/child"), "utf8");
  const directoryMode = (await stat(join(root, "directory"))).mode & 0o777;
  const childMode = (await stat(join(root, "directory/child"))).mode & 0o777;
  expect(directoryContent).toBe("directory contents");
  expect(directoryMode).toBe(0o750);
  expect(childMode).toBe(0o640);
  console.info("EXDEV directory result:", {
    source: join(disk, "directory"),
    target: join(root, "directory"),
    sourceRemoved: true,
    content: directoryContent,
    directoryMode: directoryMode.toString(8),
    childMode: childMode.toString(8),
    completedItems: directoryResult.items[0]!.completedItems,
  });

  await mkdir(join(disk, "partial"));
  await writeFile(join(disk, "partial/child"), "moved sibling");
  await exec("mkfifo", [join(disk, "partial/pipe")]);
  await expect(run("move", copy("disk/partial", "partial"))).rejects.toMatchObject({
    outcome: "partial",
    result: { items: [{ outcome: "partial", completedItems: 2 }] },
  });
  expect(await readFile(join(root, "partial/child"), "utf8")).toBe("moved sibling");
  expect(await readdir(join(disk, "partial"))).toEqual(["pipe"]);
  expect((await lstat(join(disk, "partial/pipe"))).isFIFO()).toBe(true);
  expect(await readdir(join(root, "partial"))).toEqual(["child"]);

  for (const change of ["replace", "rewrite"]) {
    const path = `changed-${change}`;
    await writeFile(join(disk, path), "copied version");
    observeNextFile(temporary, (file) => {
      const close = file.handle.close.bind(file.handle);
      vi.spyOn(file.handle, "close").mockImplementationOnce(async () => {
        await close();
        if (change === "replace") await rename(join(disk, path), join(disk, `${path}-old`));
        await writeFile(join(disk, path), "current source");
      });
    });
    await expect(run("move", copy(`disk/${path}`, path))).rejects.toMatchObject({
      outcome: "partial",
      code: "conflict",
      result: { items: [{ completedItems: 1 }] },
    });
    expect(await readFile(join(root, path), "utf8")).toBe("copied version");
    expect(await readFile(join(disk, path), "utf8")).toBe("current source");
    vi.restoreAllMocks();
  }

  const outside = join(data, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "shared"), "delete");
  const project = join(root, "project");
  await mkdir(project);
  const mounted = join(project, "data");
  await mkdir(mounted);
  await exec("mount", ["--bind", outside, mounted]);
  cleanups.push(() => exec("umount", [mounted]));
  let result: unknown;
  try {
    await run("delete", ["project"]);
  } catch (error) {
    result = error;
  }
  expect(result).toBeInstanceOf(OperationError);
  expect(result).toMatchObject({ outcome: "partial" });
  await expect(lstat(join(outside, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(mounted)).isDirectory()).toBe(true);

  const source = join(disk, "unconfirmed-unlink");
  await writeFile(source, "published before cancellation");
  const unlink = fs.unlink.bind(fs);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let unlinked!: () => void;
  const started = new Promise<void>((resolve) => {
    unlinked = resolve;
  });
  vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
    await unlink(...args);
    if (args[0] === source) {
      unlinked();
      await gate;
    }
  });
  syncBuiltinESMExports();
  const controller = new AbortController();
  const completedBefore = changed.mock.calls.length;
  let snapshot: unknown;
  try {
    const response = operations.run(
      "move",
      id,
      copy("disk/unconfirmed-unlink", "confirmed-target"),
      controller.signal,
    );
    const rejected = response.catch((error: OperationError) => error);
    await started;
    controller.abort(new AppError("cancelled", "Cancel while unlink completion is held"));
    const error = await rejected;
    expect(error).toMatchObject({
      outcome: "unknown",
      result: { items: [{ outcome: "unknown", completedItems: 1 }] },
    });
    expect(error).toBeInstanceOf(OperationError);
    snapshot = structuredClone((error as OperationError).result);
    expect(await readFile(join(root, "confirmed-target"), "utf8")).toBe(
      "published before cancellation",
    );
    await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    let closed = false;
    void operations.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(changed).toHaveBeenCalledTimes(completedBefore);
    resume();
    await operations.close();
    expect(changed).toHaveBeenCalledTimes(completedBefore + 1);
    expect((error as OperationError).result).toEqual(snapshot);
  } finally {
    resume();
    await operations.close();
  }
  console.info(
    "EXDEV verified: file/link/directory moved; FIFO and changed sources retained; held unlink returned unknown and finished once",
  );
});
