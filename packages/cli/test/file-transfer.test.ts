import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory() {
  const root = await mkdtemp("/var/tmp/kiteline-cli-files-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, ".kiteline.json"),
    JSON.stringify({ device: "device-id", workspace: "workspace-id", session: "ignored-session" }),
  );
  return root;
}

interface Request {
  method: string | undefined;
  url: URL;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

async function fixture(
  handler: (request: Request, response: ServerResponse) => void,
  respondOnHeaders = false,
) {
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    const received = {
      method: request.method,
      url: new URL(request.url!, "http://localhost"),
      headers: request.headers,
      body: Buffer.alloc(0),
    };
    requests.push(received);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.body = Buffer.concat(chunks);
      if (!respondOnHeaders) handler(received, response);
    });
    if (respondOnHeaders) handler(received, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function cli(root: string, server: string, args: string[], keepStdinOpen = false) {
  const child = spawn(process.execPath, [resolve("packages/cli/dist/main.js"), ...args], {
    cwd: root,
    env: {
      ...process.env,
      KITELINE_URL: server,
      KITELINE_TOKEN: "file-test-token",
      KITELINE_CLI_HOME: join(root, "credentials"),
      NO_PROXY: "127.0.0.1",
      no_proxy: "127.0.0.1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 3_000,
    killSignal: "SIGKILL",
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  if (!keepStdinOpen) child.stdin.end();
  const closed = once(child, "close");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  return closed.then(([code, signal]) => ({ code, signal, stdout, stderr }));
}

const binary = Buffer.from(Array.from({ length: 150_017 }, (_, index) => index % 256));
const remotePath = "目录/file name.bin";
const uploaded = { path: remotePath, size: binary.length };
const conflict = {
  code: "conflict",
  message: "Target already exists",
  details: { current: { targetVersion: "opaque-version-1", kind: "file", size: 17 } },
};

test("download consumes delayed binary chunks before releasing the connection", async () => {
  const root = await directory();
  const output = join(root, "download.bin");
  const server = await fixture((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": binary.length,
    });
    response.write(binary.subarray(0, 41));
    setTimeout(() => {
      response.write(binary.subarray(41, 70_000));
      setTimeout(() => response.end(binary.subarray(70_000)), 30);
    }, 30);
  });
  const reply = await cli(root, server.url, [
    "files",
    "download",
    remotePath,
    "--output",
    output,
    "--json",
  ]);
  expect(reply.code, reply.stdout + reply.stderr).toBe(0);
  expect(reply.signal).toBeNull();
  expect(reply.stderr).toBe("");
  expect(JSON.parse(reply.stdout)).toEqual({
    outcome: "succeeded",
    result: { path: remotePath, output, size: binary.length },
  });
  expect(await readFile(output)).toEqual(binary);
  const textOutput = join(root, "text-download.bin");
  const human = await cli(root, server.url, [
    "files",
    "download",
    remotePath,
    "--output",
    textOutput,
  ]);
  expect(human.code, human.stderr).toBe(0);
  expect(human.stdout).toBe(
    `Downloaded ${remotePath} to ${textOutput} (${binary.length} bytes).\n`,
  );
  expect(human.stderr).toBe("");
  expect(await readFile(textOutput)).toEqual(binary);
  expect(server.requests).toHaveLength(2);
  const request = server.requests[0]!;
  expect(request.method).toBe("GET");
  expect(request.url.pathname).toBe("/api/devices/device-id/download");
  expect(request.url.searchParams.get("workspaceId")).toBe("workspace-id");
  expect(request.url.searchParams.get("path")).toBe(remotePath);
  expect(request.headers.authorization).toBe("Bearer file-test-token");
  expect(request.headers.origin).toBe(server.url);
});

test("a literal --json file path does not enable structured error output", async () => {
  const root = await directory();
  const server = await fixture((_request, response) => json(response, { error: conflict }, 409));
  const text = await cli(root, server.url, [
    "files",
    "download",
    "--output",
    join(root, "text.bin"),
    "--",
    "--json",
  ]);
  expect(text.code).toBe(1);
  expect(text.signal).toBeNull();
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]!.url.searchParams.get("path")).toBe("--json");
  expect(text.stdout).toBe("");
  expect(text.stderr).toContain("failed [conflict]");

  const structured = await cli(root, server.url, [
    "files",
    "download",
    "--json",
    "--output",
    join(root, "json.bin"),
    "--",
    "--json",
  ]);
  expect(structured.code).toBe(1);
  expect(structured.signal).toBeNull();
  expect(structured.stderr).toBe("");
  expect(JSON.parse(structured.stdout)).toMatchObject({
    outcome: "failed",
    error: { code: "conflict", details: conflict.details },
  });
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1]!.url.searchParams.get("path")).toBe("--json");
});

test("download wx collision preserves the local file and makes no request", async () => {
  const root = await directory();
  const output = join(root, "existing.bin");
  await writeFile(output, binary);
  const server = await fixture((_request, response) => response.end("unexpected"));
  const reply = await cli(root, server.url, [
    "files",
    "download",
    remotePath,
    "--output",
    output,
    "--json",
  ]);
  expect(reply.code).toBe(2);
  expect(JSON.parse(reply.stdout)).toMatchObject({
    outcome: "failed",
    error: { code: "io_error" },
  });
  expect(await readFile(output)).toEqual(binary);
  expect(server.requests).toEqual([]);
});

test("HTTP errors and truncated download bodies report failed with the incomplete local path", async () => {
  const root = await directory();
  let truncate = false;
  const prefix = binary.subarray(0, 41);
  const server = await fixture((_request, response) => {
    if (!truncate) return json(response, { error: conflict }, 409);
    response.writeHead(200, { "content-length": binary.length });
    response.write(prefix);
    setTimeout(() => response.destroy(), 30);
  });
  for (const value of [false, true]) {
    truncate = value;
    const output = join(root, value ? "partial.bin" : "empty.bin");
    const reply = await cli(root, server.url, [
      "files",
      "download",
      remotePath,
      "--output",
      output,
      "--json",
    ]);
    expect(reply.code, reply.stdout + reply.stderr).toBe(1);
    expect(reply.signal).toBeNull();
    const result = JSON.parse(reply.stdout);
    expect(result).toMatchObject({
      outcome: "failed",
      error: { code: value ? "io_error" : "conflict" },
    });
    expect(result.error.message).toContain(output);
    expect(result.error.message).toContain("did not complete");
    if (!value) expect(result.error.details).toEqual(conflict.details);
    expect(await readFile(output)).toEqual(value ? prefix : Buffer.alloc(0));
    expect(reply.stderr).toBe("");
  }
  expect(server.requests).toHaveLength(2);
});

test("upload sends exact binary and empty bodies with create-only preparation", async () => {
  const root = await directory();
  const input = join(root, "local.bin");
  let bytes = binary;
  const server = await fixture((request, response) => {
    json(
      response,
      request.method === "POST"
        ? { channelId: "upload-channel" }
        : { outcome: "succeeded", result: { path: remotePath, size: bytes.length } },
    );
  });
  for (const value of [binary, Buffer.alloc(0)]) {
    bytes = value;
    await writeFile(input, value);
    const reply = await cli(root, server.url, [
      "files",
      "upload",
      remotePath,
      "--file",
      input,
      "--json",
    ]);
    expect(reply.code, reply.stdout + reply.stderr).toBe(0);
    expect(reply.signal).toBeNull();
    expect(reply.stderr).toBe("");
    expect(JSON.parse(reply.stdout)).toEqual({
      outcome: "succeeded",
      result: { path: remotePath, size: value.length },
    });
    const [prepare, put] = server.requests.slice(-2);
    expect(prepare!.url.pathname).toBe("/api/devices/device-id/channels");
    expect(JSON.parse(prepare!.body.toString())).toEqual({
      kind: "file.write",
      params: {
        workspaceId: "workspace-id",
        path: remotePath,
        purpose: "upload",
        size: value.length,
        createOnly: true,
      },
    });
    expect(put!.method).toBe("PUT");
    expect(put!.url.pathname).toBe("/api/channels/upload-channel/content");
    expect(put!.headers["content-type"]).toBe("application/octet-stream");
    expect(put!.headers["content-length"]).toBe(String(value.length));
    expect(put!.body).toEqual(value);
  }
  expect(server.requests).toHaveLength(4);
});

test("prepare conflict keeps the version in text and JSON and never sends a PUT", async () => {
  const root = await directory();
  const input = join(root, "local.bin");
  await writeFile(input, binary);
  const server = await fixture((_request, response) => json(response, { error: conflict }, 409));
  for (const args of [[], ["--json"]]) {
    const reply = await cli(root, server.url, [
      "files",
      "upload",
      remotePath,
      "--file",
      input,
      ...args,
    ]);
    expect(reply.code).toBe(1);
    if (args.length) {
      expect(JSON.parse(reply.stdout)).toEqual({ outcome: "failed", error: conflict });
      expect(reply.stderr).toBe("");
    } else {
      expect(reply.stdout).toBe("");
      expect(reply.stderr).toContain(JSON.stringify(conflict.details));
    }
  }
  expect(server.requests.map((request) => request.method)).toEqual(["POST", "POST"]);
});

test("a lost upload reservation exits as a remote failure without sending content or retrying", async () => {
  const root = await directory();
  const input = join(root, "local.bin");
  await writeFile(input, binary);
  const server = await fixture((_request, response) => response.destroy());
  const reply = await cli(root, server.url, [
    "files",
    "upload",
    remotePath,
    "--file",
    input,
    "--json",
  ]);
  expect(reply.code, reply.stdout + reply.stderr).toBe(1);
  expect(reply.signal).toBeNull();
  expect(reply.stderr).toBe("");
  expect(JSON.parse(reply.stdout)).toMatchObject({
    outcome: "failed",
    error: { code: "io_error" },
  });
  expect(server.requests.map((request) => request.method)).toEqual(["POST"]);
});

test("explicit replacement maps the version and preserves HTTP 200 failed and unknown results", async () => {
  const root = await directory();
  const input = join(root, "local.bin");
  await writeFile(input, binary);
  let outcome = "failed";
  const server = await fixture((request, response) =>
    json(
      response,
      request.method === "POST"
        ? { channelId: "upload-channel" }
        : { outcome, error: conflict, result: uploaded },
    ),
  );
  for (const [value, code] of [
    ["failed", 1],
    ["unknown", 3],
  ] as const) {
    outcome = value;
    const reply = await cli(root, server.url, [
      "files",
      "upload",
      remotePath,
      "--file",
      input,
      "--replace-version",
      "opaque-version-1",
      "--json",
    ]);
    expect(reply.code, reply.stdout + reply.stderr).toBe(code);
    expect(reply.stderr).toBe("");
    expect(JSON.parse(reply.stdout)).toEqual({ outcome: value, error: conflict, result: uploaded });
    expect(JSON.parse(server.requests.at(-2)!.body.toString()).params).toEqual({
      workspaceId: "workspace-id",
      path: remotePath,
      purpose: "upload",
      size: binary.length,
      createOnly: false,
      expectedTargetVersion: "opaque-version-1",
    });
  }
  expect(server.requests.map((request) => request.method)).toEqual(["POST", "PUT", "POST", "PUT"]);
});

test("a lost upload result is unknown and an early HTTP rejection exits without a resend", async () => {
  const root = await directory();
  const input = join(root, "local.bin");
  await writeFile(input, Buffer.alloc(1024 * 1024, 0xab));
  let rejectEarly = false;
  const server = await fixture((request, response) => {
    if (request.method === "POST") return json(response, { channelId: "upload-channel" });
    if (rejectEarly) json(response, { error: conflict }, 409);
    else response.destroy();
  }, true);
  for (const value of [false, true]) {
    rejectEarly = value;
    const reply = await cli(root, server.url, [
      "files",
      "upload",
      remotePath,
      "--file",
      input,
      "--json",
    ]);
    expect(reply.code, reply.stdout + reply.stderr).toBe(value ? 1 : 3);
    expect(reply.signal).toBeNull();
    expect(JSON.parse(reply.stdout)).toMatchObject({
      outcome: value ? "failed" : "unknown",
      error: { code: value ? "conflict" : "io_error" },
    });
    expect(reply.stderr).toBe("");
  }
  expect(server.requests.map((request) => request.method)).toEqual(["POST", "PUT", "POST", "PUT"]);
});

test("missing or directory upload sources fail locally before contacting the server", async () => {
  const root = await directory();
  const server = await fixture((_request, response) => json(response, {}));
  for (const [input, code] of [
    [join(root, "missing.bin"), "io_error"],
    [root, "invalid_argument"],
  ]) {
    const reply = await cli(
      root,
      server.url,
      ["files", "upload", remotePath, "--file", input!, "--json"],
      true,
    );
    expect(reply.code).toBe(2);
    expect(reply.signal).toBeNull();
    expect(JSON.parse(reply.stdout)).toMatchObject({ outcome: "failed", error: { code } });
  }
  expect(server.requests).toEqual([]);
});

test("file argument errors fail locally without reading stdin or making requests", async () => {
  const root = await directory();
  const server = await fixture((_request, response) => json(response, {}));
  for (const args of [
    ["files", "download", "--output", "out"],
    ["files", "download", "one", "two", "--output", "out"],
    ["files", "download", "one"],
    ["files", "upload", "one"],
    ["files", "upload", "one", "--file", "in", "--session", "s"],
    ["files", "download", "one", "--output", "out", "--session", "s"],
    ["files", "upload", "one", "--file", "in", "--replace"],
    ["files", "upload", "../one", "--file", "in"],
    ["web", "url", "--path", "one", "--session", "s"],
  ]) {
    const reply = await cli(root, server.url, [...args, "--json"], true);
    expect(reply.code, reply.stdout + reply.stderr).toBe(2);
    expect(reply.signal).toBeNull();
    expect(JSON.parse(reply.stdout)).toMatchObject({
      outcome: "failed",
      error: { code: "invalid_argument" },
    });
  }
  expect(server.requests).toEqual([]);
});

test("file Web links validate the selected workspace and ignore its default session", async () => {
  const root = await directory();
  const server = await fixture((_request, response) =>
    json(response, {
      outcome: "succeeded",
      result: { sessions: [] },
    }),
  );
  const reply = await cli(root, server.url, [
    "web",
    "url",
    "--path",
    remotePath,
    "--device",
    "other-device",
    "--workspace",
    "other-workspace",
    "--json",
  ]);
  expect(reply.code, reply.stdout + reply.stderr).toBe(0);
  const url = new URL(JSON.parse(reply.stdout).result.url);
  expect(url.origin).toBe(server.url);
  expect(url.pathname).toBe("/devices/other-device/workspaces/other-workspace/files");
  expect(url.searchParams.get("file")).toBe(remotePath);
  expect(url.searchParams.has("session")).toBe(false);
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]!.url.pathname).toBe("/api/devices/other-device/rpc");
  expect(JSON.parse(server.requests[0]!.body.toString())).toMatchObject({
    method: "sessions.list",
    params: { workspaceId: "other-workspace" },
  });
});
