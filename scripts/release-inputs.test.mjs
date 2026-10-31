import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { agentTargets } from "../packages/shared/src/artifacts.ts";
import {
  capture,
  digest,
  json,
  nodeHeadersInput,
  nodeInput,
  prepareInputs,
  ripgrepInput,
  run,
  verifyPreparedInputs,
} from "./release-inputs.mjs";

const release = json(new URL("../release/inputs.json", import.meta.url));

test.each(agentTargets)("%s has pinned Node and ripgrep inputs", (target) => {
  const node = nodeInput(release.node, target);
  const ripgrep = ripgrepInput(release.ripgrep, target);
  for (const input of [node, ripgrep]) {
    expect(input.download.url).toMatch(/^https:\/\//);
    expect(input.download.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input.archiveRoot).toMatch(/^\S+$/);
  }
  expect(node.archiveName).toMatch(/\.(?:tar\.xz|zip)$/);
  expect(node.architecture).toMatch(/^(?:x64|arm64)$/);
});

test.each([
  ["tar.xz", "arm64"],
  ["zip", "x64"],
])("Node %s inputs preserve download, archive root and architecture", (extension, architecture) => {
  const node = {
    version: "1.2.3",
    archives: {
      example: { archiveSuffix: `example.${extension}`, sha256: "node-sha256", architecture },
    },
  };
  expect(nodeInput(node, "example")).toEqual({
    download: {
      url: `https://nodejs.org/dist/v1.2.3/node-v1.2.3-example.${extension}`,
      sha256: "node-sha256",
    },
    archiveName: `node-v1.2.3-example.${extension}`,
    archiveRoot: "node-v1.2.3-example",
    architecture,
  });
});

test("Node headers use the pinned Node version and headers checksum", () => {
  expect(nodeHeadersInput(release.node)).toEqual({
    url: `https://nodejs.org/dist/v${release.node.version}/node-v${release.node.version}-headers.tar.gz`,
    sha256: release.node.headers.sha256,
  });
});

test.each(["tar.gz", "zip"])(
  "ripgrep %s inputs preserve download and archive root",
  (extension) => {
    const ripgrep = {
      version: "1.2.3",
      archives: {
        example: { archiveSuffix: `example.${extension}`, sha256: "ripgrep-sha256" },
      },
    };
    expect(ripgrepInput(ripgrep, "example")).toEqual({
      download: {
        url: `https://github.com/BurntSushi/ripgrep/releases/download/1.2.3/ripgrep-1.2.3-example.${extension}`,
        sha256: "ripgrep-sha256",
      },
      archiveRoot: "ripgrep-1.2.3-example",
    });
  },
);

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

test.each(["prepared directory", "shared cache"])(
  "prepareInputs preserves source paths and reuses checked downloads from %s",
  (location) => {
    const root = temporaryDirectory();
    const directory = join(root, "prepared");
    const download = join(root, "download");
    const recipe = "scripts/recipe.sh";
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, recipe), "printf 'prepared recipe\\n'\n");
    writeFileSync(download, "pinned archive\n");
    const expected = {
      downloads: {
        "archives/input.tar": { url: pathToFileURL(download).href, sha256: digest(download) },
      },
      files: { [recipe]: digest(join(root, recipe)) },
    };
    const downloadCache = location === "shared cache" ? join(root, "cache") : undefined;
    const options = downloadCache ? { downloadCache } : undefined;
    prepareInputs(directory, root, [recipe], expected, options);
    expect(readFileSync(join(directory, recipe), "utf8")).toBe("printf 'prepared recipe\\n'\n");
    verifyPreparedInputs(directory, expected, "test");

    rmSync(download);
    const reused = downloadCache ? join(root, "reused") : directory;
    prepareInputs(reused, root, [recipe], expected, options);
    verifyPreparedInputs(reused, expected, "test");

    const archive = expected.downloads["archives/input.tar"];
    const cached = downloadCache
      ? join(downloadCache, archive.sha256)
      : join(directory, "archives/input.tar");
    writeFileSync(cached, "damaged archive\n");
    writeFileSync(download, "pinned archive\n");
    prepareInputs(directory, root, [recipe], expected, options);
    expect(digest(cached)).toBe(archive.sha256);
    verifyPreparedInputs(directory, expected, "test");
  },
);

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

test("capture trims UTF-8 output and preserves cwd and stdin options", () => {
  const cwd = temporaryDirectory();
  const output = capture(
    process.execPath,
    [
      "-e",
      'process.stdout.write("  " + process.cwd() + "\\n"); process.stdin.pipe(process.stdout)',
    ],
    { cwd, stdio: ["pipe", "pipe", "inherit"], input: "中文  \n" },
  );
  expect(output).toBe(`${cwd}\n中文`);
});

test("capture preserves the caller's output limit", () => {
  expect(() =>
    capture(process.execPath, ["-e", 'process.stdout.write("x".repeat(4096))'], {
      maxBuffer: 32,
    }),
  ).toThrow(expect.objectContaining({ code: "ENOBUFS" }));
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
