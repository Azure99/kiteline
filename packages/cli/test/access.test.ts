import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { appVersion, type Device } from "@kiteline/shared/protocol";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory() {
  const root = await mkdtemp("/var/tmp/kiteline-cli-access-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

interface Request {
  method: string | undefined;
  path: string;
  authorization: string | undefined;
  origin: string | undefined;
  body: string;
}

async function fixture(handler: (request: Request, response: ServerResponse) => void) {
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => {
      body += part;
    });
    request.on("end", () => {
      const received = {
        method: request.method,
        path: new URL(request.url!, "http://localhost").pathname,
        authorization: request.headers.authorization,
        origin: request.headers.origin,
        body,
      };
      requests.push(received);
      handler(received, response);
    });
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

function cli(
  root: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    keepStdinOpen?: boolean;
  } = {},
) {
  const env = { ...process.env };
  delete env.KITELINE_URL;
  delete env.KITELINE_TOKEN;
  const child = spawn(process.execPath, [resolve("packages/cli/dist/main.js"), ...args], {
    cwd: options.cwd ?? root,
    env: {
      ...env,
      KITELINE_CLI_HOME: join(root, "credentials"),
      NO_PROXY: "127.0.0.1",
      no_proxy: "127.0.0.1",
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 3_000,
    killSignal: "SIGKILL",
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (part) => {
    stdout += part.toString();
  });
  child.stderr.on("data", (part) => {
    stderr += part.toString();
  });
  if (!options.keepStdinOpen) child.stdin.end(options.input ?? "");
  const closed = once(child, "close");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  return closed.then(([code, signal]) => ({ code, signal, stdout, stderr }));
}

async function save(root: string, server: string, token = "saved-token") {
  await mkdir(join(root, "credentials"));
  const path = join(root, "credentials", "credentials.json");
  await writeFile(path, JSON.stringify({ server, token }) + "\n");
  return path;
}

const access = {
  kind: "cli",
  id: "credential-full-id",
  name: "CI access",
  deviceIds: ["device-full-id"],
  expiresAt: "2030-01-01T00:00:00.000Z",
};
const devices: Device[] = [
  {
    id: "device-full-id",
    name: "Shared name",
    status: "offline",
    lastSeenAt: "2026-10-13T00:00:00.000Z",
    snapshot: {
      schemaVersion: 1,
      revision: 12,
      workspaces: [{ id: "workspace-full-id", name: "Project", path: "/srv/project" }],
      shortcuts: [],
      settings: { historyLines: 100 },
    },
  },
  { id: "other-device-full-id", name: "Shared name", status: "online", lastSeenAt: null },
];

test("attach help is offline and JSON or redirected terminals fail before connecting", async () => {
  const root = await directory();
  const help = await cli(root, ["terminal", "attach", "--help"]);
  expect(help.code, help.stderr).toBe(0);
  expect(help.stdout).toContain("Ctrl+B d");
  const json = await cli(root, ["terminal", "attach", "--json"]);
  expect(json.code).toBe(2);
  expect(JSON.parse(json.stdout)).toMatchObject({
    error: { code: "invalid_argument", message: "terminal attach does not accept --json" },
  });
  const redirected = await cli(root, ["terminal", "attach"]);
  expect(redirected.code).toBe(2);
  expect(redirected.stderr).toContain("requires stdin and stdout TTYs");
});

test("prototype property names are unknown commands and fall back to general help", async () => {
  const root = await directory();
  for (const name of ["toString", "__proto__", "constructor"]) {
    const rejected = await cli(root, [name]);
    expect(rejected.code, rejected.stderr).toBe(2);
    expect(rejected.stderr).toContain(`Unknown command: ${name}`);
    const help = await cli(root, [name, "--help"]);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("Kiteline — remote access to shared workspaces");
    expect(help.stdout).not.toContain("[native code]");
  }
});

test("help and version work offline with no credentials and a corrupt cwd target", async () => {
  const root = await directory();
  await writeFile(join(root, ".kiteline.json"), "{");
  for (const args of [["--help"], ["targets", "--help"], ["--version"]]) {
    const reply = await cli(root, args);
    expect(reply.code, reply.stderr).toBe(0);
    expect(reply.stderr).toBe("");
    expect(reply.stdout).toContain(
      args.includes("--version")
        ? appVersion
        : args[0] === "targets"
          ? "List authorized devices"
          : "auth login",
    );
  }
  expect(existsSync(join(root, "credentials"))).toBe(false);
});

test("non-TTY login without explicit stdin permission exits while its input stays open", async () => {
  const root = await directory();
  const server = await fixture((_request, response) => json(response, access));
  const reply = await cli(root, ["auth", "login", "--server", server.url, "--json"], {
    keepStdinOpen: true,
  });
  expect(reply.signal).toBeNull();
  expect(reply.code).toBe(2);
  expect(JSON.parse(reply.stdout)).toMatchObject({
    outcome: "failed",
    error: { code: "invalid_argument", message: expect.stringContaining("--token-stdin") },
  });
  expect(server.requests).toEqual([]);
  expect(existsSync(join(root, "credentials"))).toBe(false);
});

test("explicit stdin verifies the token before saving private credentials", async () => {
  const root = await directory();
  const path = join(root, "credentials", "credentials.json");
  let savedDuringVerification: boolean | undefined;
  const server = await fixture((_request, response) => {
    savedDuringVerification = existsSync(path);
    json(response, access);
  });
  const reply = await cli(
    root,
    ["auth", "login", "--server", server.url, "--token-stdin", "--json"],
    { input: "  imported-token\n" },
  );
  expect(reply.code, reply.stderr).toBe(0);
  expect(savedDuringVerification).toBe(false);
  expect(server.requests).toMatchObject([
    { method: "GET", path: "/api/session", authorization: "Bearer imported-token" },
  ]);
  expect(JSON.parse(reply.stdout)).toMatchObject({
    outcome: "succeeded",
    result: { ...access, server: server.url, source: "file" },
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    server: server.url,
    token: "imported-token",
  });
  if (process.platform !== "win32") {
    expect((await stat(join(root, "credentials"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
});

test("connection failures explain the cause for API reads and downloads", async () => {
  const root = await directory();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await save(root, `http://localhost:${port}`);
  await writeFile(join(root, ".kiteline.json"), JSON.stringify({ device: "d", workspace: "w" }));
  const status = await cli(root, ["auth", "status", "--json"], {
    env: { NO_PROXY: "localhost", no_proxy: "localhost" },
  });
  expect(status.code).toBe(1);
  expect(status.stderr).toBe("");
  expect(JSON.parse(status.stdout)).toMatchObject({
    outcome: "failed",
    error: { code: "io_error", message: expect.stringContaining("ECONNREFUSED") },
  });

  const output = join(root, "download.bin");
  const download = await cli(root, ["files", "download", "missing", "--output", output, "--json"], {
    env: { KITELINE_URL: `http://127.0.0.1:${port}`, KITELINE_TOKEN: "saved-token" },
  });
  expect(download.code).toBe(1);
  expect(download.stderr).toBe("");
  const reply = JSON.parse(download.stdout);
  expect(reply).toMatchObject({
    outcome: "failed",
    error: { code: "io_error", message: expect.stringContaining("ECONNREFUSED") },
  });
  expect(reply.error.message).toContain(`Download to ${JSON.stringify(output)} did not complete`);
  expect(await readFile(output)).toEqual(Buffer.alloc(0));
});

test("rejected imports preserve the existing saved credential", async () => {
  const root = await directory();
  const server = await fixture((request, response) => {
    if (request.authorization === "Bearer invalid-token")
      json(response, { error: { code: "unauthenticated", message: "Token is invalid" } }, 401);
    else json(response, { kind: "agent", deviceId: "device-full-id" });
  });
  const path = await save(root, server.url);
  const original = await readFile(path, "utf8");
  for (const [token, code] of [
    ["invalid-token", "unauthenticated"],
    ["agent-token", "permission_denied"],
  ]) {
    const reply = await cli(
      root,
      ["auth", "login", "--server", server.url, "--token-stdin", "--json"],
      { input: token },
    );
    expect(reply.code).toBe(1);
    expect(JSON.parse(reply.stdout)).toMatchObject({ outcome: "failed", error: { code } });
    expect(await readFile(path, "utf8")).toBe(original);
  }
});

test("environment credentials are paired, override disk, and logout preserves disk credentials", async () => {
  const root = await directory();
  await writeFile(join(root, ".kiteline.json"), "{");
  const server = await fixture((request, response) => {
    json(response, request.path === "/api/session" ? access : { ok: true });
  });
  const path = await save(root, "http://127.0.0.1:1");
  const original = await readFile(path, "utf8");
  for (const env of [{ KITELINE_URL: server.url }, { KITELINE_TOKEN: "env-token" }]) {
    const reply = await cli(root, ["auth", "status", "--json"], { env });
    expect(reply.code).toBe(2);
    expect(JSON.parse(reply.stdout)).toMatchObject({ error: { code: "invalid_argument" } });
  }
  expect(server.requests).toEqual([]);
  const env = { KITELINE_URL: server.url, KITELINE_TOKEN: "env-token" };
  const status = await cli(root, ["auth", "status", "--json"], { env });
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    result: { ...access, server: server.url, source: "environment" },
  });
  const logout = await cli(root, ["auth", "logout", "--json"], { env });
  expect(logout.code, logout.stderr).toBe(0);
  expect(JSON.parse(logout.stdout)).toMatchObject({
    result: { revoked: true, source: "environment" },
  });
  expect(server.requests).toMatchObject([
    { method: "GET", path: "/api/session", authorization: "Bearer env-token" },
    {
      method: "POST",
      path: "/api/logout",
      authorization: "Bearer env-token",
      origin: server.url,
    },
  ]);
  expect(await readFile(path, "utf8")).toBe(original);
});

test("logout revokes the saved credential and removes its file after success", async () => {
  const root = await directory();
  const server = await fixture((_request, response) => json(response, { ok: true }));
  const path = await save(root, server.url);
  const reply = await cli(root, ["auth", "logout", "--json"]);
  expect(reply.code, reply.stderr).toBe(0);
  expect(server.requests).toMatchObject([
    {
      method: "POST",
      path: "/api/logout",
      authorization: "Bearer saved-token",
      origin: server.url,
    },
  ]);
  expect(existsSync(path)).toBe(false);
});

test("targets preserves full IDs, paths, offline state, and snapshot provenance", async () => {
  const root = await directory();
  await writeFile(join(root, ".kiteline.json"), "{");
  const server = await fixture((_request, response) => json(response, { devices }));
  await save(root, server.url);
  const human = await cli(root, ["targets"]);
  expect(human.code, human.stderr).toBe(0);
  for (const text of [
    "device-full-id",
    "other-device-full-id",
    "workspace-full-id",
    "/srv/project",
    "offline",
    "device snapshot",
  ])
    expect(human.stdout).toContain(text);
  expect(human.stderr).toBe("");
  const structured = await cli(root, ["targets", "--json"]);
  expect(structured.code).toBe(0);
  expect(JSON.parse(structured.stdout)).toMatchObject({
    outcome: "succeeded",
    result: {
      devices: [
        {
          id: "device-full-id",
          status: "offline",
          workspaceSource: "device_snapshot",
          snapshotRevision: 12,
          workspaces: devices[0]!.snapshot!.workspaces,
        },
        { id: "other-device-full-id", status: "online" },
      ],
    },
  });
});

test("cwd target defaults are overridden per field for one call and ignore default session", async () => {
  const root = await directory();
  const path = join(root, ".kiteline.json");
  const original = JSON.stringify({
    device: "device-full-id",
    workspace: "workspace-full-id",
    session: "ignored-session-id",
  });
  await writeFile(path, original);
  const server = await fixture((request, response) => {
    json(
      response,
      request.path === "/api/devices"
        ? { devices }
        : { outcome: "succeeded", result: { sessions: [] } },
    );
  });
  await save(root, server.url);
  for (const args of [
    ["terminal", "list", "--device", "overridden-device"],
    ["terminal", "list", "--workspace", "overridden-workspace"],
    ["terminal", "list"],
    ["inspect"],
  ]) {
    const reply = await cli(root, [...args, "--json"]);
    expect(reply.code, reply.stdout + reply.stderr).toBe(0);
    expect(await readFile(path, "utf8")).toBe(original);
  }
  const calls = server.requests.filter((request) => request.path.endsWith("/rpc"));
  expect(calls.map((request) => request.origin)).toEqual(Array(4).fill(server.url));
  expect(calls.map((request) => [request.path, JSON.parse(request.body).params])).toEqual([
    ["/api/devices/overridden-device/rpc", { workspaceId: "workspace-full-id" }],
    ["/api/devices/device-full-id/rpc", { workspaceId: "overridden-workspace" }],
    ["/api/devices/device-full-id/rpc", { workspaceId: "workspace-full-id" }],
    ["/api/devices/device-full-id/rpc", { workspaceId: "workspace-full-id" }],
  ]);
  expect(calls.map((request) => JSON.parse(request.body).method)).toEqual([
    "sessions.list",
    "sessions.list",
    "sessions.list",
    "sessions.list",
  ]);
  for (const args of [["terminal", "list"], ["inspect"]]) {
    const reply = await cli(root, [...args, "--session", "explicit-session", "--json"]);
    expect(reply.code).toBe(2);
    expect(JSON.parse(reply.stdout)).toMatchObject({ error: { code: "invalid_argument" } });
  }
  expect(server.requests).toHaveLength(5);
});

test("UTF-8 BOM target defaults select the saved device and workspace", async () => {
  const root = await directory();
  const path = join(root, ".kiteline.json");
  const original = Buffer.from(
    "\uFEFF" + JSON.stringify({ device: "device-full-id", workspace: "workspace-full-id" }),
  );
  await writeFile(path, original);
  const server = await fixture((_request, response) =>
    json(response, { outcome: "succeeded", result: { sessions: [] } }),
  );
  await save(root, server.url);

  const reply = await cli(root, ["terminal", "list", "--json"]);

  expect(reply.code, reply.stdout + reply.stderr).toBe(0);
  expect(JSON.parse(reply.stdout)).toEqual({ outcome: "succeeded", result: { sessions: [] } });
  expect(server.requests).toMatchObject([
    { path: "/api/devices/device-full-id/rpc", authorization: "Bearer saved-token" },
  ]);
  expect(JSON.parse(server.requests[0]!.body)).toMatchObject({
    method: "sessions.list",
    params: { workspaceId: "workspace-full-id" },
  });
  expect(await readFile(path)).toEqual(original);
});

test("a child cwd does not inherit its parent target defaults", async () => {
  const root = await directory();
  await writeFile(
    join(root, ".kiteline.json"),
    JSON.stringify({ device: "device-full-id", workspace: "workspace-full-id" }),
  );
  const child = join(root, "child");
  await mkdir(child);
  const server = await fixture((_request, response) => json(response, {}));
  await save(root, server.url);
  const reply = await cli(root, ["terminal", "list", "--json"], { cwd: child });
  expect(reply.code).toBe(2);
  expect(JSON.parse(reply.stdout)).toMatchObject({ error: { code: "invalid_argument" } });
  expect(server.requests).toEqual([]);
});

test("RPC failed, partial, and unknown results preserve their outcome, error, and result", async () => {
  const root = await directory();
  let outcome = "failed";
  const failure = {
    code: "device_offline",
    message: "Device is offline",
    details: { deviceId: "device-full-id" },
  };
  const result = { sessions: [], observed: true };
  const server = await fixture((_request, response) =>
    json(response, { outcome, error: failure, result }),
  );
  await save(root, server.url);
  for (const [value, code] of [
    ["failed", 1],
    ["partial", 1],
    ["unknown", 3],
  ] as const) {
    outcome = value;
    const reply = await cli(root, [
      "terminal",
      "list",
      "--device",
      "device-full-id",
      "--workspace",
      "workspace-full-id",
      "--json",
    ]);
    expect(reply.code, reply.stderr).toBe(code);
    expect(JSON.parse(reply.stdout)).toEqual({ outcome: value, error: failure, result });
    expect(reply.stderr).toBe("");
  }
});

test("malformed and disconnected remote reads exit as remote failures", async () => {
  const root = await directory();
  let disconnect = false;
  const server = await fixture((_request, response) => {
    if (disconnect) response.destroy();
    else response.end("{");
  });
  await save(root, server.url);
  for (const value of [false, true]) {
    disconnect = value;
    const reply = await cli(root, ["targets", "--json"]);
    expect(reply.code, reply.stderr).toBe(1);
    expect(JSON.parse(reply.stdout)).toMatchObject({
      outcome: "failed",
      error: { code: "io_error" },
    });
    expect(reply.stderr).toBe("");
  }
});

test("a disconnected logout reports unknown and retains the saved credential", async () => {
  const root = await directory();
  const server = await fixture((_request, response) => response.destroy());
  const path = await save(root, server.url);
  const original = await readFile(path, "utf8");
  const reply = await cli(root, ["auth", "logout", "--json"]);
  expect(reply.code, reply.stderr).toBe(3);
  expect(JSON.parse(reply.stdout)).toMatchObject({
    outcome: "unknown",
    error: { code: "io_error" },
  });
  expect(server.requests).toMatchObject([{ method: "POST", path: "/api/logout" }]);
  expect(await readFile(path, "utf8")).toBe(original);
});

test("terminal argument errors are local, finite, and do not consume stdin", async () => {
  const root = await directory();
  for (const args of [
    ["send", "--text", "a", "--paste", "b"],
    ["send", "--key", "Enter", "--enter"],
    ["send", "--key", "not-a-key"],
    ["send", "--text", "a", "--timeout-ms", "0"],
    ["wait", "--mode", "change"],
    ["wait", "--after", "epoch:1"],
    ["wait", "--mode", "change", "--after", "epoch:1", "--quiet-ms", "1"],
    ["snapshot", "--if-changed", '{"epoch":"e","seq":1}'],
    ["resize", "--cols", "80"],
  ]) {
    const reply = await cli(root, ["terminal", ...args, "--json"], { keepStdinOpen: true });
    expect(reply.code, reply.stdout + reply.stderr).toBe(2);
    expect(reply.signal).toBeNull();
    expect(JSON.parse(reply.stdout)).toMatchObject({ error: { code: "invalid_argument" } });
  }
});

test("terminal condition epochs use 128 UTF-16 units before any HTTP request", async () => {
  const root = await directory();
  await writeFile(
    join(root, ".kiteline.json"),
    JSON.stringify({ device: "d", workspace: "w", session: "s" }),
  );
  const screen = {
    position: { epoch: "current", seq: 1, tail: null, attrs: false },
    input: { epoch: "current", inputSeq: 0 },
    cols: 80,
    rows: 24,
    active: "normal",
    cursor: { x: 0, y: 0, visible: true },
    historyGap: false,
    synchronizedOutput: false,
    screen: [],
  };
  let rejectRemote = false;
  const server = await fixture((request, response) => {
    const { method } = JSON.parse(request.body);
    if (rejectRemote)
      return json(response, {
        outcome: "failed",
        error: { code: "invalid_argument", message: "Rejected by device" },
      });
    let result: unknown;
    if (method === "sessions.snapshot")
      result = { reason: "unchanged", position: screen.position, input: screen.input };
    else if (method === "sessions.send")
      result = { before: { epoch: "current", seq: 1 }, input: screen.input };
    else if (method === "sessions.resize") result = { cols: 80, rows: 24 };
    else result = { reason: "timeout", snapshot: screen };
    json(response, { outcome: "succeeded", result });
  });
  await save(root, server.url);
  const epoch = "界".repeat(126) + "😀";
  const cases = [
    {
      args: (epoch: string) => [
        "snapshot",
        "--if-changed",
        JSON.stringify({ epoch, seq: 0, tail: null, attrs: false }),
      ],
      method: "sessions.snapshot",
      condition: "ifChanged",
    },
    {
      args: (epoch: string) => ["send", "--text", "Enter", "--if-input", `${epoch}:0002`],
      method: "sessions.send",
      condition: "ifInput",
    },
    {
      args: (epoch: string) => ["wait", "--mode", "change", "--after", `${epoch}:0002`],
      method: "sessions.wait",
      condition: "after",
    },
  ];
  for (const entry of cases) {
    const count = server.requests.length;
    const accepted = await cli(root, ["terminal", ...entry.args(epoch), "--json"]);
    expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
    expect(server.requests).toHaveLength(count + 1);
    const request = JSON.parse(server.requests.at(-1)!.body);
    expect(request.method).toBe(entry.method);
    expect(request.params[entry.condition].epoch).toBe(epoch);
    expect(request.params).not.toHaveProperty("timeoutMs");
    if (entry.method === "sessions.send")
      expect(request.params).toMatchObject({
        input: { type: "text", text: "Enter" },
        ifInput: { inputSeq: 2 },
      });
    if (entry.method === "sessions.wait") {
      expect(request.params.after.seq).toBe(2);
      expect(request.params).not.toHaveProperty("quietMs");
    }
    const rejected = await cli(root, ["terminal", ...entry.args(epoch + "x"), "--json"]);
    expect(rejected.code, rejected.stdout + rejected.stderr).toBe(2);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ error: { code: "invalid_argument" } });
    expect(server.requests).toHaveLength(count + 1);
  }
  const resized = await cli(root, [
    "terminal",
    "resize",
    "--cols",
    "00080",
    "--rows",
    "00024",
    "--timeout-ms",
    "0001",
    "--json",
  ]);
  expect(resized.code, resized.stdout + resized.stderr).toBe(0);
  expect(JSON.parse(server.requests.at(-1)!.body)).toMatchObject({
    method: "sessions.resize",
    params: { cols: 80, rows: 24, timeoutMs: 1 },
  });
  const count = server.requests.length;
  for (const args of [
    ["wait", "--after", "epoch:1"],
    ["snapshot", "--tail", "1e2"],
    ["send", "--text", "x", "--if-input", "epoch:+1"],
    ["wait", "--mode", "change", "--after", "with:colon:1"],
    ["snapshot", "--if-changed", "not-json"],
  ]) {
    const reply = await cli(root, ["terminal", ...args, "--json"]);
    expect(reply.code, reply.stdout + reply.stderr).toBe(2);
    expect(JSON.parse(reply.stdout)).toMatchObject({ error: { code: "invalid_argument" } });
  }
  const dimensions = await cli(root, [
    "terminal",
    "resize",
    "--cols",
    "501",
    "--rows",
    "24",
    "--json",
  ]);
  expect(dimensions.code).toBe(2);
  expect(JSON.parse(dimensions.stdout).error.message).toMatch(/--cols:.*1 to 500/);
  expect(server.requests).toHaveLength(count);

  rejectRemote = true;
  const remote = await cli(root, [
    "terminal",
    "snapshot",
    "--if-changed",
    JSON.stringify({ epoch, seq: 0, tail: null, attrs: false }),
    "--json",
  ]);
  expect(remote.code).toBe(1);
  expect(JSON.parse(remote.stdout)).toMatchObject({
    outcome: "failed",
    error: { code: "invalid_argument", message: "Rejected by device" },
  });
  expect(server.requests).toHaveLength(count + 1);
});

test("terminal text preserves physical lines and keeps attrs outside the body", async () => {
  const root = await directory();
  await writeFile(
    join(root, ".kiteline.json"),
    JSON.stringify({ device: "d", workspace: "w", session: "s" }),
  );
  const value = {
    reason: "full",
    position: { epoch: "e", seq: 1, tail: 4, attrs: true },
    input: { epoch: "e", inputSeq: 2 },
    cols: 20,
    rows: 4,
    active: "alternate",
    cursor: { x: 2, y: 2, visible: false },
    historyGap: false,
    synchronizedOutput: false,
    tail: {
      buffer: "normal",
      omitted: 7,
      lines: [
        { text: "old", wrapped: false, attrs: [] },
        { text: "", wrapped: false, attrs: [] },
      ],
    },
    screen: [
      { text: "  indented", wrapped: false, attrs: [] },
      { text: "", wrapped: false, attrs: [] },
      { text: "select", wrapped: true, attrs: [{ start: 0, end: 6, inverse: true }] },
      { text: "", wrapped: false, attrs: [] },
    ],
  };
  let responseValue: unknown = value;
  const server = await fixture((_request, response) =>
    json(response, { outcome: "succeeded", result: responseValue }),
  );
  await save(root, server.url);
  const human = await cli(root, ["terminal", "snapshot", "--tail", "4", "--attrs"]);
  expect(human.code, human.stderr).toBe(0);
  expect(human.stdout).toBe("old\n\n  indented\n\nselect\n");
  expect(human.stderr).toContain("screen=4 printed=3");
  expect(human.stderr).toContain("tail=2 printed=2 omitted=7");
  expect(human.stderr).toContain("screen.wrapped=[2]");
  expect(human.stderr).toContain('"inverse":true');
  const structured = await cli(root, ["terminal", "snapshot", "--tail", "4", "--attrs", "--json"]);
  expect(structured.stderr).toBe("");
  expect(JSON.parse(structured.stdout)).toEqual({ outcome: "succeeded", result: value });
  responseValue = {
    reason: "unchanged",
    position: value.position,
    input: { epoch: "e", inputSeq: 3 },
  };
  const unchanged = await cli(root, [
    "terminal",
    "snapshot",
    "--tail",
    "4",
    "--attrs",
    "--if-changed",
    JSON.stringify(value.position),
  ]);
  expect(unchanged.stdout).toBe("");
  expect(unchanged.stderr).toContain("input=e:3");
  responseValue = { ...value, tail: undefined, screen: [{ text: "\u00a0", wrapped: false }] };
  const whitespace = await cli(root, ["terminal", "snapshot"]);
  expect(whitespace.stdout).toBe("\u00a0\n");
  expect(server.requests).toHaveLength(4);
  expect(server.requests.map((r) => JSON.parse(r.body).method)).toEqual(
    Array(4).fill("sessions.snapshot"),
  );
});

test("literal text has one send RPC and unknown input is never retried", async () => {
  const root = await directory();
  await writeFile(
    join(root, ".kiteline.json"),
    JSON.stringify({ device: "d", workspace: "w", session: "s" }),
  );
  const server = await fixture((_request, response) => response.destroy());
  await save(root, server.url);
  const reply = await cli(root, [
    "terminal",
    "send",
    "--text",
    "Enter",
    "--enter",
    "--if-input",
    "e:2",
    "--json",
  ]);
  expect(reply.code).toBe(3);
  expect(JSON.parse(reply.stdout)).toMatchObject({
    outcome: "unknown",
    error: { code: "io_error" },
  });
  expect(server.requests).toHaveLength(1);
  expect(JSON.parse(server.requests[0]!.body)).toMatchObject({
    method: "sessions.send",
    params: {
      workspaceId: "w",
      sessionId: "s",
      input: { type: "text", text: "Enter", enter: true },
      ifInput: { epoch: "e", inputSeq: 2 },
    },
  });
});

test("terminal Web URL checks the selected workspace instead of guessing another session", async () => {
  const root = await directory();
  await writeFile(
    join(root, ".kiteline.json"),
    JSON.stringify({ device: "d", workspace: "w", session: "s" }),
  );
  const server = await fixture((_request, response) =>
    json(response, { outcome: "succeeded", result: { sessions: [{ id: "s", workspaceId: "w" }] } }),
  );
  await save(root, server.url);
  const url = await cli(root, ["web", "url"]);
  expect(url.code, url.stderr).toBe(0);
  expect(url.stdout).toBe(`${server.url}/devices/d/workspaces/w/terminal?session=s\n`);
  const wrong = await cli(root, ["web", "url", "--workspace", "other", "--json"]);
  expect(wrong.code).toBe(1);
  expect(JSON.parse(wrong.stdout)).toMatchObject({ error: { code: "not_found" } });
  expect(server.requests).toHaveLength(2);
});
