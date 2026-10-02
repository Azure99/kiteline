import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { appVersion } from "@kiteline/shared/protocol";
import {
  installationCommands,
  serveAgentInstallation,
  upgradeCommand,
} from "../src/agent-installation.js";

const execute = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test.runIf(process.platform === "linux")(
  "POSIX entry scripts explain unsupported macOS architecture before downloading archives",
  async () => {
    const root = await mkdtemp("/var/tmp/kiteline-target-script-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      `${root}/uname`,
      '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo ppc64 ;; esac\n',
      { mode: 0o755 },
    );
    await writeFile(`${root}/curl`, `#!/bin/sh\nprintf called > '${root}/download'\nexit 1\n`, {
      mode: 0o755,
    });
    const server = createServer((request, response) => {
      void serveAgentInstallation(request.url!, root, "http://127.0.0.1", request, response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const upgrade = await (await fetch(origin + "/upgrade.sh")).text();
    const install = await readFile(
      new URL("../../deploy/install-agent.sh", import.meta.url),
      "utf8",
    );
    for (const [name, script, args] of [
      [
        "install",
        install,
        `--server ${origin} --version ${appVersion} --platform macos --code normal-test`,
      ],
      ["upgrade", upgrade, `--version ${appVersion} --platform macos`],
    ]) {
      const file = `${root}/${name}.sh`;
      await writeFile(file, script!);
      await expect(
        execute("script", ["-qefc", `sh '${file}' ${args}`, "/dev/null"], {
          env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
          timeout: 5000,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("No agent archive is available for this architecture"),
      });
      await expect(readFile(`${root}/download`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

test.each(["linux", "macos"] as const)(
  "the %s upgrade command executes only a fully downloaded script and preserves its arguments",
  async (platform) => {
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
    const command = upgradeCommand(origin).commands[platform];
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
    expect(await readFile(output, "utf8")).toBe(
      `--version\n${appVersion}\n--platform\n${platform}\n`,
    );
  },
);

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
      execute("sh", ["-c", script, "--", "--version", version!, "--platform", "macos"], {
        timeout: 5000,
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message!) });
  }
  expect(requests).toEqual(["/upgrade.sh"]);
});

test.each(["linux", "macos"] as const)(
  "the %s connection command preserves the code and refuses an incomplete installer",
  async (platform) => {
    const root = await mkdtemp("/var/tmp/kiteline-connect-download-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const output = root + "/executed";
    const script = `printf '%s\\n' "$@" > '${output}'\n`;
    let origin = "";
    let complete = false;
    const server = createServer((request, response) => {
      if (request.url === "/install.sh") {
        response.writeHead(200, {
          connection: "close",
          "content-length": Buffer.byteLength(script) + (complete ? 0 : 100),
        });
        response.end(script);
      } else void serveAgentInstallation(request.url!, root, origin, request, response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const code = "binding'code";
    const command = installationCommands(origin, code)[platform].install;
    await expect(execute("sh", ["-c", command], { timeout: 5000 })).rejects.toMatchObject({
      code: 18,
    });
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    complete = true;
    await execute("sh", ["-c", command], { timeout: 5000 });
    expect(await readFile(output, "utf8")).toBe(
      `--server\n${origin}\n--version\n${appVersion}\n--platform\n${platform}\n--code\n${code}\n`,
    );
  },
);
