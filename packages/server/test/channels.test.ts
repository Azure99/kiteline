import { limits } from "@kiteline/shared/protocol";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { ChannelPolicy } from "../src/channels.js";
import { apiFixture, rejectedUpgrade, webPath } from "./fixture.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(policy?: Partial<ChannelPolicy>) {
  const base = await apiFixture(policy);
  cleanups.push(base.close);
  const { device, store, app, origin } = base;
  async function events(cookie: string) {
    const socket = new WebSocket(origin.replace("http:", "ws:") + webPath("/api/events"), {
      headers: { origin, cookie },
    });
    cleanups.push(() => socket.terminate());
    const messages: Record<string, unknown>[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await once(socket, "open");
    await expect
      .poll(() => messages.some((message) => message.type === "devices.changed"))
      .toBe(true);
    return { socket, messages };
  }
  async function fileChannel(
    kind: "file.read" | "file.write",
    size: number,
    targetPath: unknown = "file",
  ) {
    const peer = await device();
    const login = store.createLogin(60_000);
    const connection = app.connections.online(peer.deviceId)!;
    const pending = app.channels.create(peer.deviceId, login, kind, {
      workspaceId: "workspace",
      path: "file",
      purpose: kind === "file.read" ? "text" : "save",
      size,
      createOnly: true,
    });
    const sourceClosed = new Promise<void>((resolve) => {
      app.server.once("upgrade", (_request, socket) => socket.once("close", resolve));
    });
    const socket = await base.dataChannel(peer.deviceToken, pending.id, connection.connectionId);
    socket.send(
      JSON.stringify({
        type: "ready",
        meta: {
          size,
          filename: "file",
          targetPath,
          contentType: "text/plain; charset=utf-8",
        },
      }),
    );
    await pending.ready;
    return {
      socket,
      peer,
      sourceClosed,
      id: pending.id,
      url: origin + webPath(`/api/channels/${pending.id}/content`),
      headers: { origin, cookie: `kiteline_session_http=${login.token}` },
    };
  }
  return { ...base, events, fileChannel };
}

test.each(["file.read", "file.write"] as const)(
  "%s rejects invalid logical targets before browser pairing",
  async (kind) => {
    const f = await fixture();
    for (const target of [null, "/outside", "../other"])
      await expect(f.fileChannel(kind, 0, target)).rejects.toMatchObject({
        code: "invalid_argument",
      });
  },
);

test("channel envelope budget is checked before reserving a channel", async () => {
  const f = await fixture({ channelsPerDevice: 1 });
  const peer = await f.device();
  const login = f.store.createLogin(60_000);
  const cookie = `kiteline_session_http=${login.token}`;
  const body = {
    kind: "terminal.attach",
    params: {
      workspaceId: "work",
      sessionId: "session",
      padding: "",
    },
  };
  body.params.padding = "x".repeat(
    limits.controlMessageBytes - Buffer.byteLength(JSON.stringify(body)) - 10,
  );
  const rejected = await f.call(`/api/devices/${peer.deviceId}/channels`, "POST", body, cookie);
  expect(rejected.status).toBe(413);
  expect(await rejected.json()).toMatchObject({ error: { code: "limit_exceeded" } });
  expect(peer.messages.some((m) => m.type === "channel.open")).toBe(false);
  body.params.padding = "";
  const pending = f.call(`/api/devices/${peer.deviceId}/channels`, "POST", body, cookie);
  await expect.poll(() => peer.messages.some((m) => m.type === "channel.open")).toBe(true);
  const channel = peer.messages.find((m) => m.type === "channel.open")!;
  const cancelled = await f.call(`/api/channels/${channel.channelId}`, "DELETE", undefined, cookie);
  await cancelled.arrayBuffer();
  await (await pending).arrayBuffer();
  expect(f.app.connections.devices()[0]!.status).toBe("online");
});

test("public channel purposes are strings and cannot open internal download or proxy channels", async () => {
  const f = await fixture({ channelsPerDevice: 1 });
  const login = f.store.createLogin(60_000);
  const cookie = `kiteline_session_http=${login.token}`;
  const events = await f.events(cookie);
  const offline = f.store.bind(f.store.newBinding().code, "Offline");
  const params = { workspaceId: "workspace", path: "file", purpose: "text" };
  const open = (deviceId: string, purpose: unknown) =>
    f.call(
      `/api/devices/${deviceId}/channels`,
      "POST",
      {
        kind: "file.read",
        params: { ...params, purpose },
      },
      cookie,
    );
  const unavailable = await open(offline.deviceId, "text");
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({ error: { code: "offline" } });
  await expect
    .poll(() => events.messages.filter((event) => event.type === "channel.failed").length)
    .toBe(1);
  const malformed = await open(offline.deviceId, ["text"]);
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ error: { code: "unsupported" } });

  const peer = await f.device();
  for (const input of [
    { kind: "file.read", params: { ...params, purpose: ["text"] } },
    { kind: "file.read", params: { ...params, purpose: "download" } },
    { kind: "http.proxy", params: { port: 5173 } },
  ]) {
    const rejected = await f.call(`/api/devices/${peer.deviceId}/channels`, "POST", input, cookie);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "unsupported" } });
  }
  expect(peer.messages.some((message) => message.type === "channel.open")).toBe(false);
  const observed = once(events.socket, "pong");
  events.socket.ping();
  await observed;
  expect(events.messages.filter((event) => event.type === "channel.failed")).toHaveLength(1);

  const extra = { agentOnly: { value: [1, "raw"] } };
  const pending = f.call(
    `/api/devices/${peer.deviceId}/channels`,
    "POST",
    {
      kind: "file.read",
      params: { ...params, ...extra },
    },
    cookie,
  );
  await expect
    .poll(() => peer.messages.some((message) => message.type === "channel.open"))
    .toBe(true);
  const opening = peer.messages.find((message) => message.type === "channel.open")!;
  expect(opening.params).toEqual({ ...params, ...extra });
  const invalidWhileBusy = await open(peer.deviceId, ["text"]);
  expect(await invalidWhileBusy.json()).toMatchObject({ error: { code: "unsupported" } });
  const busy = await open(peer.deviceId, "text");
  expect(busy.status).toBe(429);
  expect(await busy.json()).toMatchObject({ error: { code: "busy" } });
  const cancelled = await f.call(`/api/channels/${opening.channelId}`, "DELETE", undefined, cookie);
  expect(await cancelled.json()).toEqual({ found: true });
  await (await pending).arrayBuffer();
});

test.each([
  {
    kind: "file.write",
    purpose: "save",
    size: 0,
    contentType: "text/plain; charset=utf-8",
    error: "invalid_argument",
  },
  {
    kind: "file.read",
    purpose: "image",
    size: 1,
    contentType: "text/plain; charset=utf-8",
    error: "unsupported",
  },
  {
    kind: "file.read",
    purpose: "open",
    size: 1,
    contentType: "text/plain; charset=utf-8",
    error: undefined,
  },
])(
  "ready metadata uses the checked $kind/$purpose request",
  async ({ kind, purpose, size, contentType, error }) => {
    const f = await fixture();
    const peer = await f.device();
    const login = f.store.createLogin(60_000);
    const connection = f.app.connections.online(peer.deviceId)!;
    const pending = f.app.channels.create(peer.deviceId, login, kind, {
      workspaceId: "workspace",
      path: "file",
      purpose,
      size: 1,
    });
    const socket = await f.dataChannel(peer.deviceToken, pending.id, connection.connectionId);
    const result = error
      ? expect(pending.ready).rejects.toMatchObject({ code: error })
      : expect(pending.ready).resolves.toMatchObject({ meta: { size, contentType } });
    socket.send(
      JSON.stringify({
        type: "ready",
        meta: { size, contentType, filename: "file", targetPath: "file" },
      }),
    );
    await result;
  },
);

test.each([
  {
    action: "source close",
    expectedError: { code: "offline", message: "Device data connection closed" },
  },
  {
    action: "error frame",
    expectedError: { code: "invalid_argument", message: "Channel has not been paired" },
  },
])(
  "a ready read lost to $action reports its phase and leaves no content endpoint",
  async ({ action, expectedError }) => {
    const f = await fixture();
    const channel = await f.fileChannel("file.read", 4);
    const events = await f.events(channel.headers.cookie);
    if (action === "source close") channel.socket.close(1000);
    else
      channel.socket.send(
        JSON.stringify({ type: "error", code: "io_error", message: "Agent diagnostic" }),
      );
    await expect
      .poll(() => events.messages.find((event) => event.channelId === channel.id))
      .toEqual({
        type: "channel.failed",
        channelId: channel.id,
        deviceId: channel.peer.deviceId,
        workspaceId: "workspace",
        path: "file",
        purpose: "text",
        outcome: "failed",
        error: expectedError,
      });
    const response = await fetch(channel.url, { headers: channel.headers });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  },
);

test.each([
  { kind: "file", code: "unsupported", status: 400 },
  { kind: "file", code: "permission_denied", status: 403 },
  { kind: "file", code: "timeout", status: 504 },
  { kind: "file", code: "unknown_code", status: 500 },
  { kind: "file", code: "constructor", status: 500 },
  { kind: "file", code: "__proto__", status: 500 },
  { kind: "proxy", code: "unsupported", status: 501 },
  { kind: "proxy", code: "unknown_code", status: 502 },
  { kind: "proxy", code: "constructor", status: 502 },
  { kind: "proxy", code: "__proto__", status: 502 },
])(
  "$kind channel preparation reports $code through HTTP $status and releases the channel",
  async ({ kind, code, status }) => {
    const f = await fixture();
    const peer = await f.device();
    const login = f.store.createLogin(60_000);
    const cookie = `kiteline_session_http=${login.token}`;
    const pending =
      kind === "proxy"
        ? f.call(`/proxy/${peer.deviceId}/5173/`, "GET", undefined, cookie)
        : f.call(
            `/api/devices/${peer.deviceId}/channels`,
            "POST",
            { kind: "file.read", params: { workspaceId: "work", path: "file", purpose: "text" } },
            cookie,
          );
    await expect
      .poll(() => peer.messages.some((message) => message.type === "channel.open"))
      .toBe(true);
    const opening = peer.messages.find((message) => message.type === "channel.open")!;
    const socket = await f.dataChannel(
      peer.deviceToken,
      String(opening.channelId),
      String(opening.connectionId),
    );
    socket.send(JSON.stringify({ type: "error", code, message: "Could not prepare file" }));
    const response = await pending;
    expect(response.status).toBe(status);
    if (kind === "proxy") expect(await response.text()).toContain("Could not prepare file");
    else
      expect(await response.json()).toEqual({ error: { code, message: "Could not prepare file" } });
    await expect
      .poll(() =>
        peer.messages.some(
          (message) => message.type === "channel.cancel" && message.channelId === opening.channelId,
        ),
      )
      .toBe(true);
    const cancelled = await f.call(
      `/api/channels/${String(opening.channelId)}`,
      "DELETE",
      undefined,
      `kiteline_session_http=${login.token}`,
    );
    expect(await cancelled.json()).toEqual({ found: false });
    expect(f.app.connections.devices()[0]!.status).toBe("online");
  },
);

test("channel preparation and transfer preserve empty and long diagnostics without disconnecting the device", async () => {
  const f = await fixture();
  const peer = await f.device();
  const login = f.store.createLogin(60_000);
  const connection = f.app.connections.online(peer.deviceId)!;
  for (const stage of ["prepare", "transfer"]) {
    for (const message of ["", "x".repeat(5000), null]) {
      const pending = f.app.channels.create(peer.deviceId, login, "file.read", {
        workspaceId: "workspace",
        path: "file",
        purpose: "text",
      });
      const ready = pending.ready.then(
        () => undefined,
        (error: unknown) => error,
      );
      const socket = await f.dataChannel(peer.deviceToken, pending.id, connection.connectionId);
      try {
        let request: Promise<Response> | undefined;
        if (stage === "transfer") {
          socket.send(
            JSON.stringify({
              type: "ready",
              meta: {
                size: 1,
                filename: "file",
                targetPath: "file",
                contentType: "text/plain; charset=utf-8",
              },
            }),
          );
          expect(await ready).toBeUndefined();
          const start = once(socket, "message");
          request = f.call(
            `/api/channels/${pending.id}/content`,
            "GET",
            undefined,
            `kiteline_session_http=${login.token}`,
          );
          await start;
        }
        socket.send(JSON.stringify({ type: "error", code: "io_error", message }));
        const error = stage === "prepare" ? await ready : (await (await request!).json()).error;
        expect(error).toMatchObject(
          message === null ? { code: "invalid_argument" } : { code: "io_error", message },
        );
        expect(f.app.connections.devices()[0]!.status).toBe("online");
      } finally {
        socket.terminate();
      }
    }
  }
});

test.each(["bulk", "queued"])(
  "normal source close drains %s read frames through HTTP backpressure",
  async (mode) => {
    const highWaterMark = getDefaultHighWaterMark(false);
    if (mode === "queued") setDefaultHighWaterMark(false, 1);
    let f: Awaited<ReturnType<typeof fixture>>;
    try {
      f = await fixture();
    } finally {
      setDefaultHighWaterMark(false, highWaterMark);
    }
    const bytes = Buffer.alloc(mode === "queued" ? 16 * 1024 : 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const channel = await f.fileChannel("file.read", bytes.length);
    let held: import("node:http").ServerResponse | undefined;
    if (mode === "queued")
      f.app.server.prependOnceListener("request", (_request, response) => {
        held = response;
        response.cork();
      });
    channel.socket.once("message", () => {
      for (let offset = 0; offset < bytes.length; offset += 8192)
        channel.socket.send(bytes.subarray(offset, offset + 8192));
      channel.socket.close(1000);
    });
    const pending = new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = request(channel.url, { headers: channel.headers }, resolve);
      req.once("error", reject);
      req.end();
    });
    void pending.catch(() => {});
    try {
      if (mode === "queued") {
        // Keep HTTP backpressure until the relay's original data socket has closed.
        await channel.sourceClosed;
      }
    } finally {
      held?.uncork();
    }
    const response = await pending;
    expect(response.statusCode).toBe(200);
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    await channel.sourceClosed;
    const cancelled = await f.call(
      `/api/channels/${channel.id}`,
      "DELETE",
      undefined,
      channel.headers.cookie,
    );
    expect(await cancelled.json()).toEqual({ found: false });
    const pong = once(channel.peer.socket, "pong");
    channel.peer.socket.ping();
    await pong;
    expect(
      channel.peer.messages.some(
        (message) => message.type === "channel.cancel" && message.channelId === channel.id,
      ),
    ).toBe(false);
  },
);

test.each([
  { sentBytes: 0, action: "close", expectedStatus: 503, expectedError: "offline" },
  { sentBytes: 2, action: "close", expectedStatus: 200, expectedError: "offline" },
  { sentBytes: 2, action: "error", expectedStatus: 200, expectedError: "io_error" },
])(
  "a read source $action after $sentBytes of 4 bytes does not report success",
  async ({ sentBytes, action, expectedStatus, expectedError }) => {
    const f = await fixture();
    const channel = await f.fileChannel("file.read", 4);
    const events = await f.events(channel.headers.cookie);
    const started = once(channel.socket, "message");
    const pending = new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = request(channel.url, { headers: channel.headers }, resolve);
      req.once("error", reject);
      req.end();
    });
    expect(JSON.parse((await started)[0].toString())).toEqual({ type: "start" });
    if (sentBytes > 0) channel.socket.send(Buffer.from("ab"));
    if (action === "close") channel.socket.close(1000);
    else {
      await pending;
      channel.socket.send(
        JSON.stringify({ type: "error", code: "io_error", message: "Read failed" }),
      );
    }
    const response = await pending;
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("error", () => {});
    await new Promise<void>((resolve) => response.once("close", resolve));
    const bytes = Buffer.concat(chunks);
    expect(response.statusCode).toBe(expectedStatus);
    if (sentBytes === 0) {
      expect(JSON.parse(bytes.toString())).toMatchObject({ error: { code: expectedError } });
      expect(response.complete).toBe(true);
    } else {
      expect(response.headers["content-length"]).toBe("4");
      expect(response.complete).toBe(false);
      expect(bytes.toString()).toBe("ab");
    }
    await expect
      .poll(() => events.messages.find((event) => event.channelId === channel.id))
      .toMatchObject({ type: "channel.failed", error: { code: expectedError } });
    expect(f.app.connections.devices()[0]!.status).toBe("online");
  },
);

test("an empty download automatically starts and releases its channel after the HTTP response", async () => {
  const f = await fixture();
  const peer = await f.device();
  const login = f.store.createLogin(60_000);
  const cookie = `kiteline_session_http=${login.token}`;
  const pending = f.call(
    `/api/devices/${peer.deviceId}/download?workspaceId=workspace&path=empty`,
    "GET",
    undefined,
    cookie,
  );
  await expect
    .poll(() => peer.messages.some((message) => message.type === "channel.open"))
    .toBe(true);
  const opening = peer.messages.find((message) => message.type === "channel.open")!;
  const socket = await f.dataChannel(
    peer.deviceToken,
    String(opening.channelId),
    String(opening.connectionId),
  );
  const started = once(socket, "message");
  const closed = once(socket, "close");
  socket.send(
    JSON.stringify({
      type: "ready",
      meta: {
        size: 0,
        filename: "empty.txt",
        targetPath: "empty",
        contentType: "text/plain; charset=utf-8",
      },
    }),
  );
  expect(JSON.parse((await started)[0].toString())).toEqual({ type: "start" });
  const response = await pending;
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe("0");
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("content-disposition")).toBe(
    "attachment; filename=\"download\"; filename*=UTF-8''empty.txt",
  );
  expect((await response.arrayBuffer()).byteLength).toBe(0);
  expect((await closed)[0]).toBe(1000);
  const cancelled = await f.call(
    `/api/channels/${String(opening.channelId)}`,
    "DELETE",
    undefined,
    cookie,
  );
  expect(await cancelled.json()).toEqual({ found: false });
  const pong = once(peer.socket, "pong");
  peer.socket.ping();
  await pong;
  expect(peer.messages.some((message) => message.type === "channel.cancel")).toBe(false);
});

test.each([
  { action: "source close", afterEnd: false, outcome: "failed", code: "offline" },
  { action: "DELETE", afterEnd: false, outcome: "failed", code: "cancelled" },
  { action: "DELETE", afterEnd: true, outcome: "unknown", code: "cancelled" },
])(
  "write $action afterEnd=$afterEnd preserves $outcome/$code",
  async ({ action, afterEnd, outcome, code }) => {
    const f = await fixture();
    const channel = await f.fileChannel("file.write", 4);
    const controls: string[] = [];
    const chunks: Buffer[] = [];
    const boundary = new Promise<void>((resolve) => {
      channel.socket.on("message", (data, binary) => {
        if (binary) {
          chunks.push(Buffer.from(data as Buffer));
          if (!afterEnd) resolve();
        } else {
          const frame = JSON.parse(data.toString()) as { type: string };
          controls.push(frame.type);
          if (afterEnd && frame.type === "end") resolve();
        }
      });
    });
    const req = request(channel.url, {
      method: "PUT",
      headers: { ...channel.headers, "content-length": "4" },
    });
    const pending = new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      req.once("response", resolve);
      req.once("error", reject);
    });
    try {
      if (afterEnd) req.end("text");
      else req.write("te");
      await boundary;
      expect(Buffer.concat(chunks).toString()).toBe(afterEnd ? "text" : "te");
      if (action === "source close") channel.socket.close(1000);
      else {
        const cancelled = await f.call(
          `/api/channels/${channel.id}`,
          "DELETE",
          undefined,
          channel.headers.cookie,
        );
        expect(await cancelled.json()).toEqual({ found: true });
      }
      const response = await pending;
      const parts: Buffer[] = [];
      for await (const part of response) parts.push(part as Buffer);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(Buffer.concat(parts).toString())).toMatchObject({
        id: channel.id,
        outcome,
        error: { code },
      });
      expect(controls).toEqual(afterEnd ? ["start", "end"] : ["start"]);
    } finally {
      req.destroy();
    }
  },
);

test("write results validate errors, preserve partial details and report lost publication results as unknown", async () => {
  const f = await fixture();
  const partial = {
    outcome: "partial",
    error: { code: "conflict", message: "", details: { changed: ["file"] } },
    result: { completed: 1 },
  };
  const diagnostic = {
    outcome: "unknown",
    error: {
      code: "io_error",
      message: "diagnostic\n".repeat(1000) + "\0",
      details: { pending: true },
    },
    result: { target: "file" },
  };
  const invalid = {
    outcome: "unknown",
    error: expect.objectContaining({ code: "invalid_argument" }),
  };
  const replies = [
    { name: "missing-error", reply: { outcome: "unknown", error: null }, expected: invalid },
    {
      name: "invalid-message",
      reply: { outcome: "partial", error: { code: "io_error", message: null } },
      expected: invalid,
    },
    {
      name: "empty-code",
      reply: { outcome: "failed", error: { code: "", message: "diagnostic" } },
      expected: invalid,
    },
    {
      name: "invalid-outcome",
      reply: { outcome: ["unknown"], error: { code: "io_error", message: "diagnostic" } },
      expected: invalid,
    },
    { name: "partial", reply: partial, expected: partial },
    { name: "diagnostic", reply: diagnostic, expected: diagnostic },
    {
      name: "lost-result",
      reply: undefined,
      expected: { outcome: "unknown", error: expect.objectContaining({ code: "offline" }) },
    },
  ];
  for (const { name, reply, expected } of replies) {
    const channel = await f.fileChannel("file.write", 4);
    const chunks: Buffer[] = [];
    const stored = join(f.config.dataDir, `published-${name}`);
    channel.socket.on("message", (data, binary) => {
      if (binary) chunks.push(Buffer.from(data as Buffer));
      else if (JSON.parse(data.toString()).type === "end") {
        if (reply !== undefined)
          channel.socket.send(
            JSON.stringify({ type: "result", reply: { id: channel.id, ...reply } }),
          );
        else void writeFile(stored, Buffer.concat(chunks)).then(() => channel.socket.close(1000));
      }
    });
    const response = await fetch(channel.url, {
      method: "PUT",
      headers: channel.headers,
      body: "text",
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ id: channel.id, ...expected });
    if (reply === undefined) {
      expect(await readFile(stored, "utf8")).toBe("text");
    }
    expect(Buffer.concat(chunks).toString()).toBe("text");
  }
});

test.each(["preparing", "ready"])(
  "the %s pairing deadline releases the shared channel slot",
  async (stage) => {
    const f = await fixture({ pairingTimeoutMs: 300, channelsPerDevice: 1 });
    const peer = await f.device();
    const login = f.store.createLogin(60_000);
    const cookie = `kiteline_session_http=${login.token}`;
    const events = await f.events(cookie);
    const input = {
      kind: "file.read",
      params: { workspaceId: "work", path: "file", purpose: "text" },
    };
    const pending = f.call(`/api/devices/${peer.deviceId}/channels`, "POST", input, cookie);
    await expect
      .poll(() => peer.messages.some((message) => message.type === "channel.open"))
      .toBe(true);
    const opening = peer.messages.find((message) => message.type === "channel.open")!;
    if (stage === "ready") {
      const socket = await f.dataChannel(
        peer.deviceToken,
        String(opening.channelId),
        String(opening.connectionId),
      );
      socket.send(
        JSON.stringify({
          type: "ready",
          meta: {
            size: 0,
            filename: "file",
            targetPath: "file",
            contentType: "text/plain; charset=utf-8",
          },
        }),
      );
    }
    const response = await pending;
    expect(response.status).toBe(stage === "ready" ? 200 : 504);
    await response.arrayBuffer();
    await expect
      .poll(() => events.messages.find((event) => event.channelId === opening.channelId))
      .toMatchObject({ type: "channel.failed", error: { code: "timeout" } });
    const next = f.call(`/api/devices/${peer.deviceId}/channels`, "POST", input, cookie);
    await expect
      .poll(() => peer.messages.filter((message) => message.type === "channel.open").length)
      .toBe(2);
    const nextOpening = peer.messages.filter((message) => message.type === "channel.open")[1]!;
    const cancelled = await f.call(
      `/api/channels/${nextOpening.channelId}`,
      "DELETE",
      undefined,
      cookie,
    );
    expect(await cancelled.json()).toEqual({ found: true });
    await (await next).arrayBuffer();
  },
);

test.each([
  { type: "ended", exitCode: 17 },
  { type: "error", code: "io_error", message: "Terminal failed" },
])(
  "terminal channel has separate deadlines, stays with its login, and forwards one final $type",
  async (final) => {
    const f = await fixture({ pairingTimeoutMs: 800, channelsPerDevice: 1 });
    const peer = await f.device();
    const otherDevice = await f.device("Other");
    const login = f.store.createLogin(60000);
    const other = f.store.createLogin(60000);
    const cookie = `kiteline_session_http=${login.token}`;
    const pending = f.call(
      `/api/devices/${peer.deviceId}/channels`,
      "POST",
      {
        kind: "terminal.attach",
        params: { workspaceId: "work", sessionId: "session" },
      },
      cookie,
    );
    await expect.poll(() => peer.messages.some((m) => m.type === "channel.open")).toBe(true);
    const opening = peer.messages.find((m) => m.type === "channel.open")!;
    const endpoint = f.origin.replace("http:", "ws:");
    const dataUrl = `${endpoint}/api/agent/channels/${String(opening.channelId)}?connectionId=${String(opening.connectionId)}`;
    const wrongDevice = await rejectedUpgrade(dataUrl, {
      authorization: `Bearer ${otherDevice.deviceToken}`,
    });
    expect(wrongDevice.status).toBe(403);
    const beforeReady = await rejectedUpgrade(
      endpoint + webPath(`/api/channels/${opening.channelId}/terminal`),
      {
        cookie,
        origin: f.origin,
      },
    );
    expect(beforeReady.status).toBe(409);
    const agent = await f.dataChannel(
      peer.deviceToken,
      String(opening.channelId),
      String(opening.connectionId),
    );
    const duplicateAgent = await rejectedUpgrade(dataUrl, {
      authorization: `Bearer ${peer.deviceToken}`,
    });
    expect(duplicateAgent.status).toBe(403);
    await delay(450);
    agent.send(
      JSON.stringify({
        type: "ready",
        meta: {
          terminalInputBytes: 262144,
        },
      }),
    );
    const created = (await (await pending).json()) as { channelId: string };
    expect(
      await (
        await f.call(
          `/api/channels/${created.channelId}`,
          "DELETE",
          undefined,
          `kiteline_session_http=${other.token}`,
        )
      ).json(),
    ).toEqual({ found: false });
    const rejected = await rejectedUpgrade(
      endpoint + webPath(`/api/channels/${created.channelId}/terminal`),
      { cookie: `kiteline_session_http=${other.token}`, origin: f.origin },
    );
    expect(rejected.status).toBe(404);
    await delay(420);
    const browser = new WebSocket(
      endpoint + webPath(`/api/channels/${created.channelId}/terminal`),
      {
        headers: { cookie, origin: f.origin },
      },
    );
    const frames: unknown[] = [];
    browser.on("message", (data, binary) => {
      if (!binary) frames.push(JSON.parse(data.toString()) as unknown);
    });
    const started = once(agent, "message");
    await once(browser, "open");
    expect(JSON.parse((await started)[0].toString())).toEqual({ type: "start" });
    const duplicate = await rejectedUpgrade(
      endpoint + webPath(`/api/channels/${created.channelId}/terminal`),
      { cookie, origin: f.origin },
    );
    expect(duplicate.status).toBe(409);
    const input = once(agent, "message");
    browser.send(JSON.stringify({ type: "input", data: "typed" }));
    expect(JSON.parse((await input)[0].toString())).toEqual({ type: "input", data: "typed" });
    const output = once(browser, "message");
    agent.send(Buffer.from("screen"));
    const [bytes, binary] = await output;
    expect(binary).toBe(true);
    expect(bytes).toEqual(Buffer.from("screen"));
    agent.send(JSON.stringify(final));
    agent.close(1000);
    await once(browser, "close");
    expect(frames).toEqual([final]);
  },
);
