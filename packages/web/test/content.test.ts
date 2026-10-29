import { getEventListeners } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import type { Device, FileMeta, FileReadPurpose, KitelineError } from "@kiteline/shared/protocol";
import { readContent, readText, type DiskText, type FileTarget } from "../src/files/content";
import { DraftStore } from "../src/files/drafts";
import { ApiError } from "../src/lib/api";
import { emit } from "../src/lib/events";

const target: FileTarget = { deviceId: "device", workspaceId: "workspace", path: "a.txt" };
const meta: FileMeta = {
  size: 4,
  contentType: "text/plain",
  filename: "a.txt",
  targetPath: "a.txt",
  revision: "base",
  bom: false,
  lineEnding: "lf",
};
const diagnostic: KitelineError = {
  code: "io_error",
  message: "The source stopped while reading",
  details: { path: "a.txt" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function transport(fileMeta = meta) {
  const browser = new EventTarget();
  vi.stubGlobal("window", browser);
  const reads: {
    id: string;
    purpose: FileReadPurpose;
    signal: AbortSignal;
    httpSignal?: AbortSignal;
    response: ReturnType<typeof deferred<Response>>;
  }[] = [];
  const released: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    const path = new URL(String(input), "http://local").pathname;
    if (options?.method === "POST") {
      const { params } = JSON.parse(options.body as string);
      const read = {
        id: `read-${reads.length}`,
        purpose: params.purpose,
        signal: options.signal as AbortSignal,
        response: deferred<Response>(),
      };
      reads.push(read);
      return Response.json({
        channelId: read.id,
        meta: { ...fileMeta, targetPath: params.path },
      });
    }
    const read = reads.find((item) => path === `/api/channels/${item.id}/content`);
    if (read) {
      read.httpSignal = options!.signal as AbortSignal;
      return read.response.promise;
    }
    expect(options?.method).toBe("DELETE");
    released.push(path.slice("/api/channels/".length));
    return Response.json({ found: true });
  });
  return {
    async read(index = 0) {
      await vi.waitFor(() => expect(reads[index]?.httpSignal).toBeDefined());
      return reads[index]!;
    },
    fail(id: string, error = diagnostic) {
      const read = reads.find((item) => item.id === id)!;
      emit("kiteline:event", {
        type: "channel.failed",
        channelId: id,
        ...target,
        purpose: read.purpose,
        outcome: "failed",
        error,
      });
    },
    expectReleased(id: string) {
      expect(released.filter((value) => value === id)).toHaveLength(1);
      expect(getEventListeners(reads.find((read) => read.id === id)!.signal, "abort")).toEqual([]);
    },
    expectIdle() {
      expect(getEventListeners(browser, "kiteline:event")).toEqual([]);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(["GET", "body"])(
  "a channel failure ends a pending %s with its diagnostic and aborts only that HTTP read",
  async (stage) => {
    const wire = transport();
    const caller = new AbortController();
    const pending = readText(target, caller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      ...diagnostic,
      outcome: "failed",
    });
    const read = await wire.read();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    if (stage === "body") {
      const consumed = deferred<void>();
      read.response.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
              controller.enqueue(new TextEncoder().encode("ba"));
            },
            pull() {
              consumed.resolve();
            },
          }),
        ),
      );
      await consumed.promise;
    }
    wire.fail(read.id);
    await rejected;
    expect(await pending.catch((error: unknown) => error)).toBeInstanceOf(ApiError);
    expect(caller.signal.aborted).toBe(false);
    expect(read.httpSignal!.aborted).toBe(true);
    wire.expectReleased(read.id);
    wire.expectIdle();

    // The transport may reject after the diagnostic has already settled the read.
    if (body) body.error(new DOMException("HTTP aborted", "AbortError"));
    else read.response.reject(new DOMException("HTTP aborted", "AbortError"));
  },
);

test.each(["HTTP", "body"])(
  "%s failure settles without waiting for a later channel diagnostic",
  async (stage) => {
    const wire = transport();
    const caller = new AbortController();
    const pending = readContent(target, caller.signal);
    const read = await wire.read();
    const failure =
      stage === "HTTP"
        ? expect(pending).rejects.toMatchObject({
            code: "offline",
            message: "HTTP arrived first",
            outcome: undefined,
          })
        : expect(pending).rejects.toThrow("Body connection closed");
    if (stage === "HTTP") {
      read.response.resolve(
        Response.json(
          { error: { code: "offline", message: "HTTP arrived first" } },
          { status: 503 },
        ),
      );
    } else {
      read.response.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("Body connection closed"));
            },
          }),
        ),
      );
    }
    await failure;
    wire.expectReleased(read.id);
    wire.expectIdle();
    wire.fail(read.id);
    caller.abort();
    expect(read.httpSignal!.aborted).toBe(false);
  },
);

test("a complete image stays successful and a late event cannot fail the next read", async () => {
  const wire = transport({ ...meta, contentType: "image/png" });
  const caller = new AbortController();
  const pending = readContent(target, caller.signal);
  const first = await wire.read();
  first.response.resolve(new Response(new Uint8Array([1, 2, 3, 4])));
  const image = await pending;
  expect(first.purpose).toBe("open");
  expect(image.kind).toBe("image");
  if (image.kind !== "image") throw new Error("The image read must return a blob");
  expect(image.value.blob.type).toBe("image/png");
  expect(new Uint8Array(await image.value.blob.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3, 4]),
  );
  wire.expectReleased(first.id);
  wire.expectIdle();

  const next = readText(target, new AbortController().signal);
  const second = await wire.read(1);
  wire.fail(first.id);
  caller.abort();
  expect(first.httpSignal!.aborted).toBe(false);
  expect(second.httpSignal!.aborted).toBe(false);
  second.response.resolve(new Response("next"));
  expect(await next).toMatchObject({ text: "next", target, meta: { revision: "base" } });
  expect(second.purpose).toBe("text");
  wire.expectReleased(second.id);
  wire.expectIdle();
});

test("a completed short response still fails the content length check", async () => {
  const wire = transport();
  const pending = readText(target, new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow("File transfer is incomplete");
  const read = await wire.read();
  read.response.resolve(new Response("ba"));
  await rejected;
  wire.expectReleased(read.id);
  wire.expectIdle();
});

test("caller cancellation ends a pending read as AbortError and releases its listeners", async () => {
  const wire = transport();
  const caller = new AbortController();
  const pending = readContent(target, caller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const read = await wire.read();
  caller.abort();
  wire.fail(read.id);
  await rejected;
  expect(read.httpSignal!.aborted).toBe(true);
  wire.expectReleased(read.id);
  wire.expectIdle();
  read.response.reject(new DOMException("HTTP aborted", "AbortError"));
});

test("cancelling an old check isolates its late channel failure from the moved-source read", async () => {
  const wire = transport();
  const store = new DraftStore();
  store.observeDevices([{ id: "device", editorBytes: 1024 } as Device]);
  const disk: DiskText = { target, meta, text: "base", raw: "base" };
  const draft = store.open({ ...target, deviceName: "Device", workspaceName: "Workspace" }, disk);
  const checking = store.check(draft);
  const first = await wire.read();
  const moving = store.rename("a.txt", "b.txt", store.capture("device", "workspace", "a.txt"));
  expect(await checking).toEqual({ kind: "ignored" });
  expect(first.signal.aborted).toBe(true);
  expect(first.httpSignal!.aborted).toBe(true);
  wire.expectReleased(first.id);

  const second = await wire.read(1);
  wire.fail(first.id);
  first.response.reject(new DOMException("Old read cancelled", "AbortError"));
  expect(second.httpSignal!.aborted).toBe(false);
  second.response.resolve(new Response("base"));
  await moving;
  expect(draft.path).toBe("b.txt");
  expect(draft.error).toBeUndefined();
  expect(draft.observationError).toBeUndefined();
  wire.expectReleased(second.id);
  wire.expectIdle();
  store.clear();
});

test.each(["load", "check", "observe", "move"] as const)(
  "the %s consumer receives the channel diagnostic without cancelling its caller",
  async (action) => {
    const wire = transport();
    const store = new DraftStore();
    store.observeDevices([{ id: "device", editorBytes: 1024 } as Device]);
    const disk: DiskText = { target, meta, text: "base", raw: "base" };
    const draft = store.open({ ...target, deviceName: "Device", workspaceName: "Workspace" }, disk);
    let pending: Promise<unknown>;
    if (action === "move") {
      pending = store.rename("a.txt", "b.txt", store.capture("device", "workspace", "a.txt"));
    } else if (action === "observe") {
      pending = store.observe(draft, new AbortController().signal);
    } else {
      pending = store[action](draft);
    }
    const read = await wire.read();
    wire.fail(read.id);
    await pending;
    expect(read.signal.aborted).toBe(false);
    expect(read.httpSignal!.aborted).toBe(true);
    const foreground = action === "load" || action === "check";
    const error = foreground ? draft.error : draft.observationError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ ...diagnostic, outcome: "failed" });
    wire.expectReleased(read.id);
    wire.expectIdle();
    read.response.reject(new DOMException("HTTP aborted", "AbortError"));
    store.clear();
  },
);
