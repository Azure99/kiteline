import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run } from "./release-inputs.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "kiteline-release-inputs-"));
  directories.push(directory);
  return directory;
}

test("run preserves cwd, stdout bytes and the caller's capture options", () => {
  const cwd = temporaryDirectory();
  const output = run(
    process.execPath,
    ["-e", 'process.stdout.write(process.cwd() + "\\ntext\\n")'],
    {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
      maxBuffer: 4096,
    },
  );
  expect(output).toBe(`${cwd}\ntext\n`);
  const bytes = run(process.execPath, ["-e", "process.stdout.write(Buffer.from([0, 128, 255]))"], {
    stdio: "pipe",
  });
  expect(bytes).toEqual(Buffer.from([0, 128, 255]));
});

test("run reports a nonzero exit status", () => {
  expect(() => run(process.execPath, ["-e", "process.exit(7)"], { stdio: "pipe" })).toThrow(
    `${process.execPath} exited with 7`,
  );
});

test("run preserves the native spawn error", () => {
  const missing = join(temporaryDirectory(), "missing-command");
  expect(() => run(missing, [], { stdio: "pipe" })).toThrow(
    expect.objectContaining({ code: "ENOENT", path: missing, syscall: `spawnSync ${missing}` }),
  );
});

test.skipIf(process.platform === "win32")("run identifies the terminating signal", () => {
  expect(() =>
    run(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")'], { stdio: "pipe" }),
  ).toThrow(`${process.execPath} terminated by SIGTERM`);
});
