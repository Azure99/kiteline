import { limits } from "@kiteline/shared/protocol";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { serverLimits } from "../src/limits.js";
import { apiFixture, restoreServerLimits, webPath } from "./fixture.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    restoreServerLimits();
  }
});
async function fixture() {
  const base = await apiFixture();
  cleanups.push(base.close);
  const { device, store, app, origin } = base;
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
    const socket = new WebSocket(
      origin.replace("http:", "ws:") +
        `/api/agent/channels/${pending.id}?connectionId=${connection.connectionId}`,
      { headers: { authorization: `Bearer ${peer.deviceToken}` } },
    );
    cleanups.push(() => socket.terminate());
    await once(socket, "open");
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
      id: pending.id,
      url: origin + webPath(`/api/channels/${pending.id}/content`),
      headers: { origin, cookie: `kiteline_session_http=${login.token}` },
    };
  }
  return { ...base, fileChannel };
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
  const f = await fixture();
  Object.assign(serverLimits, { channelsPerDevice: 1 });
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

test.each([
  { code: "unsupported", status: 400 },
  { code: "permission_denied", status: 403 },
  { code: "timeout", status: 504 },
])(
  "channel preparation reports $code through HTTP $status and releases the channel",
  async ({ code, status }) => {
    const f = await fixture();
    const peer = await f.device();
    const login = f.store.createLogin(60_000);
    const pending = f.call(
      `/api/devices/${peer.deviceId}/channels`,
      "POST",
      { kind: "file.read", params: { workspaceId: "work", path: "file", purpose: "text" } },
      `kiteline_session_http=${login.token}`,
    );
    await expect
      .poll(() => peer.messages.some((message) => message.type === "channel.open"))
      .toBe(true);
    const opening = peer.messages.find((message) => message.type === "channel.open")!;
    const socket = new WebSocket(
      f.origin.replace("http:", "ws:") +
        `/api/agent/channels/${String(opening.channelId)}?connectionId=${String(opening.connectionId)}`,
      { headers: { authorization: `Bearer ${peer.deviceToken}` } },
    );
    cleanups.push(() => socket.terminate());
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "error", code, message: "Could not prepare file" }));
    const response = await pending;
    expect(response.status).toBe(status);
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
      const socket = new WebSocket(
        f.origin.replace("http:", "ws:") +
          `/api/agent/channels/${pending.id}?connectionId=${connection.connectionId}`,
        { headers: { authorization: `Bearer ${peer.deviceToken}` } },
      );
      socket.on("error", () => {});
      try {
        await once(socket, "open");
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
    const closed = once(channel.socket, "close");
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
        expect((await closed)[0]).toBe(1000);
        // Keep HTTP backpressure until the source close has reached the relay.
        await delay(20);
      }
    } finally {
      held?.uncork();
    }
    const response = await pending;
    expect(response.statusCode).toBe(200);
    response.pause();
    await delay(50);
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  },
);

test("write results validate errors, preserve partial details and report lost publication results as unknown", async () => {
  const f = await fixture();
  const replies = [
    { outcome: "unknown", error: null },
    { outcome: "partial", error: { code: "io_error", message: null } },
    { outcome: "failed", error: { code: "", message: "diagnostic" } },
    { outcome: ["unknown"], error: { code: "io_error", message: "diagnostic" } },
    {
      outcome: "partial",
      error: { code: "conflict", message: "", details: { changed: ["file"] } },
      result: { completed: 1 },
    },
    {
      outcome: "unknown",
      error: {
        code: "io_error",
        message: "diagnostic\n".repeat(1000) + "\0",
        details: { pending: true },
      },
      result: { target: "file" },
    },
    undefined,
  ];
  for (const [index, reply] of replies.entries()) {
    const channel = await f.fileChannel("file.write", 4);
    const chunks: Buffer[] = [];
    const stored = join(f.config.dataDir, `published-${index}`);
    channel.socket.on("message", (data, binary) => {
      if (binary) chunks.push(Buffer.from(data as Buffer));
      else if (JSON.parse(data.toString()).type === "end") {
        if (reply)
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
    if (index < 4)
      expect(result).toMatchObject({
        id: channel.id,
        outcome: "unknown",
        error: { code: "invalid_argument" },
      });
    else if (reply) expect(result).toEqual({ id: channel.id, ...reply });
    else {
      expect(result).toMatchObject({
        id: channel.id,
        outcome: "unknown",
        error: { code: "offline" },
      });
      expect(await readFile(stored, "utf8")).toBe("text");
    }
    expect(Buffer.concat(chunks).toString()).toBe("text");
  }
});

test("terminal channel has separate pairing deadlines, stays with its login, and forwards one final outcome", async () => {
  const f = await fixture();
  Object.assign(limits, { interactionTimeout: 800 });
  Object.assign(serverLimits, { channelsPerDevice: 1 });
  const peer = await f.device();
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
  const agent = new WebSocket(
    `${endpoint}/api/agent/channels/${String(opening.channelId)}?connectionId=${String(opening.connectionId)}`,
    { headers: { authorization: `Bearer ${peer.deviceToken}` } },
  );
  agent.on("error", () => {});
  await once(agent, "open");
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
  const refused = new WebSocket(endpoint + webPath(`/api/channels/${created.channelId}/terminal`), {
    headers: { cookie: `kiteline_session_http=${other.token}`, origin: f.origin },
  });
  const rejected = await new Promise<number>((resolve, reject) => {
    refused.on("error", reject);
    refused.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode!);
      refused.terminate();
    });
  });
  expect(rejected).toBe(404);
  await delay(420);
  const browser = new WebSocket(endpoint + webPath(`/api/channels/${created.channelId}/terminal`), {
    headers: { cookie, origin: f.origin },
  });
  const frames: unknown[] = [];
  browser.on("message", (data) => frames.push(JSON.parse(data.toString()) as unknown));
  await once(browser, "open");
  agent.send(JSON.stringify({ type: "ended", exitCode: 17 }));
  agent.close(1000);
  await once(browser, "close");
  expect(frames).toEqual([{ type: "ended", exitCode: 17 }]);
});
