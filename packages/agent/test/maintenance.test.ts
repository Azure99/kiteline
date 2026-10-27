import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const boundary = vi.hoisted(() => ({
  source: "",
  layout: {
    directory: "",
    useFile: "",
    recordFile: "",
    environmentFile: "",
    managementFile: "",
    launcherFile: "",
    managementLockFd: 9,
  },
  lockCount: 0,
  beforeUseLock: (_count: number) => {},
  question: async (_signal: AbortSignal) => "yes",
}));

vi.mock("../src/install/layout.js", () => ({ unixInstallationLayout: boundary.layout }));
vi.mock("@kiteline/shared/node/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kiteline/shared/node/paths")>()),
  get resourceDirectory() {
    return boundary.source;
  },
}));
vi.mock("../src/install/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/install/paths.js")>();
  return {
    ...actual,
    async lockInstallationManagement() {
      // The public shell's inherited fd is outside this action-level fixture.
      const file = await open(boundary.layout.managementFile, "a");
      await actual.lockFileDescriptor(file.fd);
      return file;
    },
    async lockInstallation() {
      boundary.beforeUseLock(++boundary.lockCount);
      return actual.lockInstallation();
    },
  };
});
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    once() {},
    question: (_prompt: string, { signal }: { signal: AbortSignal }) => boundary.question(signal),
    close() {},
  }),
}));

import { installCli } from "../src/install/commands.js";

let root: string;
let originalExitCode: typeof process.exitCode;
const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

beforeEach(async () => {
  root = await mkdtemp("/var/tmp/kiteline-maintenance-test-");
  boundary.source = join(root, "package with spaces");
  Object.assign(boundary.layout, {
    directory: join(root, "program"),
    useFile: join(root, "use.lock"),
    recordFile: join(root, "installation.json"),
    environmentFile: join(root, "environment"),
    managementFile: join(root, "management.lock"),
    launcherFile: join(root, "public"),
  });
  boundary.lockCount = 0;
  boundary.beforeUseLock = () => {};
  boundary.question = async () => "yes";
  originalExitCode = process.exitCode;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
});

afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  if (originalTty) Object.defineProperty(process.stdin, "isTTY", originalTty);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  await rm(root, { recursive: true, force: true });
});

async function packageFixture() {
  for (const directory of ["runtime/bin", "dist/native/bin", "bin"])
    await mkdir(join(boundary.source, directory), { recursive: true });
  await symlink(process.execPath, join(boundary.source, "runtime/bin/node"));
  await writeFile(
    join(boundary.source, "release.json"),
    JSON.stringify({
      kind: "agent",
      platform: "linux",
      architecture: process.arch,
      node: process.versions.node,
      version: "new",
    }),
  );
  await writeFile(join(boundary.source, "dist/native/identity.json"), '{"tmux":"fixture"}');
  // Only version checks use these stand-ins; checksum, archive and filesystem operations are real.
  await writeFile(
    join(boundary.source, "dist/native/bin/tmux"),
    "#!/bin/sh\necho 'tmux fixture'\n",
    { mode: 0o755 },
  );
  await writeFile(join(boundary.source, "bin/kiteline-agent"), "#!/bin/sh\necho new\n", {
    mode: 0o755,
  });
  await writeFile(join(boundary.source, "bin/kiteline-agent-installed"), "new launcher");
  const release = await readFile(join(boundary.source, "release.json"));
  const record = `${createHash("sha256").update(release).digest("hex")}  release.json\n`;
  // Successful checksum output exceeds the former command helper's 128 KiB limit.
  await writeFile(join(boundary.source, "SHA256SUMS"), record.repeat(10_000));
}

async function installedFixture() {
  await mkdir(boundary.layout.directory);
  await writeFile(join(boundary.layout.directory, "old"), "previous program");
  await writeFile(boundary.layout.launcherFile, "old launcher");
  await writeFile(boundary.layout.useFile, "");
  await writeFile(
    boundary.layout.recordFile,
    JSON.stringify({ user: "root", uid: 0, gid: 0, home: root }),
  );
}

async function archiveFixture() {
  await packageFixture();
  await installedFixture();
  const archive = join(root, "upgrade with spaces.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package with spaces"]);
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(archive + ".sha256", digest + "  archive\n");
  return archive;
}

test.runIf(process.platform !== "win32").each([
  ["install", [], "Usage: kiteline-agent install"],
  ["install", ["--yes"], "Unknown option '--yes'"],
  ["upgrade", [], "Usage: kiteline-agent upgrade"],
  ["upgrade", ["--purge"], "Unknown option '--purge'"],
  ["uninstall", ["--archive", "file"], "Unknown option '--archive'"],
] as const)(
  "%s validates its own arguments before acquiring management",
  async (action, args, message) => {
    await expect(installCli(action, [...args])).rejects.toThrow(message);
    await expect(stat(boundary.layout.managementFile)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

const unixActionTest = test.runIf(process.platform === "linux" && process.getuid?.() === 0);

unixActionTest(
  "install discards large checksum output and accepts a package path containing spaces",
  async () => {
    await packageFixture();
    await installCli("install", ["--user", "root"]);
    expect(await readFile(boundary.layout.launcherFile, "utf8")).toBe("new launcher");
    expect(JSON.parse(await readFile(boundary.layout.recordFile, "utf8")).user).toBe("root");
  },
);

unixActionTest(
  "checksum failure stops installation before configuration or publication",
  async () => {
    await packageFixture();
    await writeFile(join(boundary.source, "SHA256SUMS"), "0".repeat(64) + "  release.json\n");
    await expect(installCli("install", ["--user", "root"])).rejects.toThrow(
      "Package checksum verification failed",
    );
    for (const path of [
      boundary.layout.environmentFile,
      boundary.layout.directory,
      boundary.layout.launcherFile,
    ])
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

unixActionTest("checksum executable startup failure is reported before installation", async () => {
  await packageFixture();
  const tools = join(root, "tools");
  await mkdir(tools);
  for (const command of ["sh", "mkdir", "flock", "getent"])
    await symlink(`/usr/bin/${command}`, join(tools, command));
  vi.stubEnv("PATH", tools);
  await expect(installCli("install", ["--user", "root"])).rejects.toThrow("spawn sha256sum ENOENT");
  await expect(stat(boundary.layout.environmentFile)).rejects.toMatchObject({ code: "ENOENT" });
});

unixActionTest("checksum child termination is reported before installation", async () => {
  await packageFixture();
  const tools = join(root, "tools");
  await mkdir(tools);
  await writeFile(join(tools, "sha256sum"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
  vi.stubEnv("PATH", `${tools}:${process.env.PATH}`);
  await expect(installCli("install", ["--user", "root"])).rejects.toThrow(
    "sha256sum terminated by SIGTERM",
  );
  await expect(stat(boundary.layout.environmentFile)).rejects.toMatchObject({ code: "ENOENT" });
});

unixActionTest.each(["waiting", "answered"] as const)(
  "upgrade cancels at the confirmation boundary (%s)",
  async (phase) => {
    const archive = await archiveFixture();
    const before = await stat(boundary.layout.launcherFile);
    boundary.question = async (signal) => {
      process.emit("SIGTERM");
      if (phase === "waiting") signal.throwIfAborted();
      return "yes";
    };
    await expect(installCli("upgrade", ["--archive", archive])).rejects.toThrow(
      "SIGTERM: cancelled",
    );
    expect(process.exitCode).toBe(143);
    expect(await readFile(join(boundary.layout.directory, "old"), "utf8")).toBe("previous program");
    expect((await stat(boundary.layout.launcherFile)).ino).toBe(before.ino);
    expect(await readFile(boundary.layout.launcherFile, "utf8")).toBe("old launcher");
    expect((await readdir(root)).filter((name) => name.startsWith(".kiteline-upgrade-"))).toEqual(
      [],
    );
  },
);

unixActionTest.each(["upgrade", "uninstall"] as const)(
  "%s finishes after an interrupt at transaction lock acquisition",
  async (action) => {
    const archive = action === "upgrade" ? await archiveFixture() : undefined;
    if (!archive) await installedFixture();
    boundary.beforeUseLock = (count) => {
      if (count === 2) process.emit("SIGTERM");
    };
    await installCli(action, archive ? ["--archive", archive, "--yes"] : ["--yes"]);
    expect(process.exitCode).toBe(143);
    if (action === "upgrade") {
      expect(await readFile(boundary.layout.launcherFile, "utf8")).toBe("new launcher");
      expect((await readdir(root)).filter((name) => name.startsWith(".kiteline-upgrade-"))).toEqual(
        [],
      );
    } else {
      await expect(stat(boundary.layout.directory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(boundary.layout.launcherFile)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);
