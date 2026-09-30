import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { appVersion } from "@kiteline/shared/protocol";
import { serveAgentInstallation, upgradeCommand } from "../src/agent-installation.js";

const execute = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("the one-line command executes only a fully downloaded script and preserves its arguments", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-upgrade-download-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const output = root + "/executed";
  const script = `printf '%s\\n' "$@" > '${output}'\n`;
  let mode: "complete" | "truncated" | "failed" = "truncated";
  const server = createServer((_request, response) => {
    response.writeHead(mode === "failed" ? 503 : 200, {
      connection: "close",
      "content-length": Buffer.byteLength(script) + (mode === "truncated" ? 100 : 0),
    });
    response.end(script);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const command = upgradeCommand(origin).commands.linux;
  expect(command.split("\n")).toHaveLength(1);
  for (const failure of ["truncated", "failed"] as const) {
    mode = failure;
    await expect(execute("sh", ["-c", command], { timeout: 5000 })).rejects.toMatchObject({
      code: failure === "truncated" ? 18 : 22,
    });
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  }
  mode = "complete";
  await execute("sh", ["-c", command], { timeout: 5000 });
  expect(await readFile(output, "utf8")).toBe(`--version\n${appVersion}\n`);
});

test("the real upgrade script refuses stale commands and noninteractive execution before downloads", async () => {
  let origin = "";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    void serveAgentInstallation(request.url!, "/unused", origin, request, response).catch(() =>
      response.writeHead(500).end(),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(origin + "/upgrade.sh");
  const script = await response.text();
  for (const [version, message] of [
    ["stale-version", "server release changed"],
    [appVersion, "interactive terminal"],
  ]) {
    await expect(
      execute("sh", ["-c", script, "--", "--version", version!], { timeout: 5000 }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message!) });
  }
  expect(requests).toEqual(["/upgrade.sh"]);
});
