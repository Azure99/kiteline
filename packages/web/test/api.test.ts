import { expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { appVersion } from "@kiteline/shared/protocol";
import { createApiClient } from "@kiteline/shared/protocol/client";
import { api, cancelChannel, openChannel, rpc } from "../src/lib/api";
import { cursorRpc } from "../src/lib/cursors";

test("HTTP failure sources keep retryable reads separate from unknown writes", async () => {
  const reply = {
    id: "r",
    outcome: "partial",
    error: { code: "io_error", message: "partially changed", details: { path: "file" } },
    result: { affected: 1 },
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://local").pathname;
    if (path === "/network" || path === "/api/devices/lost/rpc") return request.socket.destroy();
    if (path === "/body-abort") {
      response.writeHead(502, { "content-type": "text/html" });
      response.write("<html>");
      return;
    }
    const status = Number(path.slice(1));
    if ([502, 503, 504].includes(status)) {
      response.writeHead(status, { "content-type": "text/html" }).end("<html>gateway</html>");
    } else if (status === 500 || status === 404) {
      response.writeHead(status, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: { code: status === 500 ? "io_error" : "not_found", message: "failed" },
        }),
      );
    } else if (path === "/malformed") {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end('{"error":{"code":"io_error","message":1}}');
    } else if (path === "/invalid-json") {
      response.writeHead(200, { "content-type": "application/json" }).end("invalid JSON");
    } else {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const nativeFetch = globalThis.fetch;
  let headersReceived!: () => void;
  const headers = new Promise<void>((resolve) => {
    headersReceived = resolve;
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (path, options) => {
    const response = await nativeFetch(origin + String(path), options);
    if (String(path).startsWith("/body-abort")) headersReceived();
    return response;
  });
  try {
    for (const path of ["/network", "/502", "/503", "/504"]) {
      await expect(api(path)).rejects.toMatchObject({ code: "io_error", retryable: true });
      await expect(api(path, { method: "POST" })).rejects.toMatchObject({
        outcome: "unknown",
        retryable: false,
      });
    }
    await expect(
      rpc("lost", "cursors.release", { kind: "directory", id: "cursor" }),
    ).rejects.toMatchObject({
      code: "io_error",
      outcome: undefined,
      retryable: true,
    });
    await expect(
      rpc("lost", "files.delete", { workspaceId: "w", paths: ["file"] }),
    ).rejects.toMatchObject({
      outcome: "unknown",
      retryable: false,
    });
    await expect(api("/500")).rejects.toMatchObject({ code: "io_error", retryable: false });
    await expect(api("/404")).rejects.toMatchObject({ code: "not_found", retryable: false });
    await expect(api("/invalid-json")).rejects.toBeInstanceOf(SyntaxError);
    for (const path of ["/malformed", "/invalid-json"])
      await expect(api(path, { method: "POST" })).rejects.toMatchObject({
        outcome: "unknown",
        retryable: false,
      });
    await expect(
      rpc("d", "files.delete", { workspaceId: "w", paths: ["file"] }),
    ).rejects.toMatchObject({
      outcome: "partial",
      details: reply.error.details,
      result: reply.result,
      retryable: false,
    });
    const abort = new AbortController();
    const pending = expect(api("/body-abort", { signal: abort.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await headers;
    await setImmediate();
    abort.abort();
    await pending;
  } finally {
    fetch.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a partial cursor response retains its diagnostic details and result", async () => {
  const reply = {
    id: "r",
    outcome: "partial",
    error: { code: "io_error", message: "directory changed", details: { path: "folder" } },
    result: { observed: 3 },
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(reply));
  try {
    await expect(
      cursorRpc("d", "files.list", { workspaceId: "w", path: "." }),
    ).rejects.toMatchObject({
      code: "io_error",
      message: "directory changed",
      outcome: "partial",
      details: reply.error.details,
      result: reply.result,
    });
  } finally {
    fetch.mockRestore();
  }
});

test("channel reservations keep read errors while cancellation encodes IDs and keeps write risk", async () => {
  const requests: { method: string | undefined; url: URL; body: unknown }[] = [];
  const channelId = "目录/a ?#%";
  const ready = { channelId, meta: { terminalInputBytes: 4096 } };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url!, "http://local");
      requests.push({ method: request.method, url, body: body ? JSON.parse(body) : undefined });
      if (url.pathname.includes("/lost/")) return response.destroy();
      if (url.pathname.includes("/gateway/"))
        return response.writeHead(502, { "content-type": "text/html" }).end("gateway");
      if (url.pathname.includes("/rejected/"))
        return response
          .writeHead(409, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { code: "conflict", message: "Unavailable" } }));
      if (url.pathname === "/api/channels/lost") return response.destroy();
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(request.method === "DELETE" ? { found: false } : ready));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const nativeFetch = globalThis.fetch;
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((path, options) => nativeFetch(origin + String(path), options));
  try {
    const params = { workspaceId: "workspace", sessionId: "session", history: "screen" } as const;
    for (const deviceId of ["lost", "gateway"])
      await expect(openChannel(deviceId, "terminal.attach", params)).rejects.toMatchObject({
        code: "io_error",
        outcome: undefined,
        retryable: true,
      });
    await expect(openChannel("rejected", "terminal.attach", params)).rejects.toMatchObject({
      code: "conflict",
      outcome: undefined,
      retryable: false,
    });
    const deviceId = "设备/a ?#%";
    await expect(openChannel(deviceId, "terminal.attach", params)).resolves.toEqual(ready);
    const opened = requests.at(-1)!;
    expect(opened.method).toBe("POST");
    expect(opened.url.pathname).toBe(`/api/devices/${encodeURIComponent(deviceId)}/channels`);
    expect(opened.url.searchParams.get("appVersion")).toBe(appVersion);
    expect(opened.body).toEqual({ kind: "terminal.attach", params });

    await expect(cancelChannel(channelId)).resolves.toEqual({ found: false });
    const cancelled = requests.at(-1)!;
    expect(cancelled.method).toBe("DELETE");
    expect(cancelled.url.pathname).toBe(`/api/channels/${encodeURIComponent(channelId)}`);
    expect(cancelled.url.searchParams.get("appVersion")).toBe(appVersion);
    expect(cancelled.body).toBeUndefined();
    await expect(cancelChannel("lost")).rejects.toMatchObject({
      code: "io_error",
      outcome: "unknown",
      retryable: false,
    });
  } finally {
    fetch.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a file reservation cancelled after consumption releases its late channel without waiting", async () => {
  const abort = new AbortController();
  const ready = {
    channelId: "late/目录?%",
    meta: { size: 0, contentType: "text/plain; charset=utf-8", filename: "file" },
  };
  let finishCancellation!: () => void;
  let cancelled!: () => void;
  const cancelling = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  let settled!: () => void;
  const cancellationSettled = new Promise<void>((resolve) => {
    settled = resolve;
  });
  let prepared: unknown;
  const server = createServer((request, response) => {
    if (request.method === "DELETE") {
      expect(new URL(request.url!, "http://local").pathname).toBe(
        `/api/channels/${encodeURIComponent(ready.channelId)}`,
      );
      finishCancellation = () => response.destroy();
      cancelled();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      prepared = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ready));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = createApiClient({
    newId: () => "unused",
    request: async (path, options, consume) => {
      try {
        const result = await consume(await fetch(origin + path, options));
        // The real body is consumed; cancel before fileChannel resumes with its ready result.
        if (options.method === "POST") abort.abort();
        return result;
      } finally {
        if (options.method === "DELETE") settled();
      }
    },
  });
  try {
    await expect(
      client.fileChannel(
        { deviceId: "d", workspaceId: "w", path: "file" },
        "file.read",
        { purpose: "text" },
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(prepared).toEqual({
      kind: "file.read",
      params: { workspaceId: "w", path: "file", purpose: "text" },
    });
    await cancelling;
    finishCancellation();
    await cancellationSettled;
    await setImmediate();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a cancelled cursor read releases a cursor returned after cancellation", async () => {
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    if (options?.method === "DELETE") return Response.json({});
    const request = JSON.parse(options!.body as string);
    if (request.method !== "files.list")
      return Response.json({ id: request.id, outcome: "succeeded", result: {} });
    const signal = options?.signal;
    signal?.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      void response.then(resolve).finally(() => signal?.removeEventListener("abort", abort));
    });
  });
  try {
    const abort = new AbortController();
    const pending = cursorRpc("d", "files.list", { workspaceId: "w", path: "." }, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    finish(
      Response.json({
        id: "r",
        outcome: "succeeded",
        result: { entries: { items: [], nextCursor: "late" } },
      }),
    );
    await rejected;
    expect(fetch.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(true);
    expect(
      fetch.mock.calls.map(([, options]) => options?.body && JSON.parse(options.body as string)),
    ).toContainEqual(
      expect.objectContaining({
        method: "cursors.release",
        params: { kind: "directory", id: "late" },
      }),
    );
  } finally {
    fetch.mockRestore();
  }
});
