import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  lstat,
  rm,
  rmdir,
  symlink,
  chmod,
  stat,
  link,
  readdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { AppError, OperationError } from "@kiteline/shared/protocol";
import { publish } from "../src/mutations.js";
import { FileOperations } from "../src/files/operations.js";
import { TemporaryFiles } from "../src/files/temporary.js";
import { Files } from "../src/files/index.js";
import { MetadataStore } from "../src/metadata.js";
import { Directories } from "../src/directories.js";
import { defaultAgentLimits } from "../src/config.js";
import { BinaryFiles } from "../src/files/binary.js";
import { TextFiles } from "../src/files/text.js";

const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const data = await mkdtemp("/var/tmp/kiteline-file-operations-");
  cleanups.push(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "workspace");
  await mkdir(root);
  const config = {
    dataDir: data,
    runDir: join(data, "run"),
    shell: "/bin/sh",
    limits: { ...defaultAgentLimits },
  };
  const metadata = new MetadataStore(config);
  const workspace = await metadata.add(root);
  const temporary = new TemporaryFiles(data);
  cleanups.push(() => temporary.close());
  const directories = new Directories();
  cleanups.push(() => directories.close());
  const operations = new FileOperations(metadata, temporary);
  cleanups.push(() => operations.close());
  return {
    root,
    data,
    temporary,
    files: new Files(metadata, directories, temporary),
    binary: new BinaryFiles(config, metadata, temporary),
    text: new TextFiles(config, metadata, temporary),
    operations,
    id: workspace.id,
    run: (
      kind: "copy" | "move" | "delete",
      inputs: unknown,
      signal = new AbortController().signal,
    ) => operations.run(kind, workspace.id, inputs, signal),
  };
}
const copy = (path: string, targetPath: string) => [{ path, targetPath, collision: "error" }];

test("cancel settles while cleanup waits for a real publication owner and later removes its record", async () => {
  const { root, data, id, operations, temporary } = await setup();
  await writeFile(join(root, "source"), Buffer.alloc(150000, 97));
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let owner: Promise<void> | undefined;
  const write = temporary.write.bind(temporary);
  vi.spyOn(temporary, "write").mockImplementationOnce(async (...args) => {
    const bytes = await write(...args);
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    owner = publish(async () => {
      entered();
      await gate;
    });
    await ready;
    controller.abort(new AppError("cancelled", "Cancel copying"));
    return bytes;
  });
  try {
    await expect(
      operations.run("copy", id, copy("source", "target"), controller.signal),
    ).rejects.toMatchObject({ outcome: "failed", code: "cancelled" });
    expect(operations.cleanupPending).toBe(true);
    const records = JSON.parse(await readFile(join(data, "temporary-files.json"), "utf8"));
    expect(records).toHaveLength(1);
    expect((await stat(join(root, records[0].name))).size).toBeGreaterThan(0);
    await expect(lstat(join(root, "target"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release();
    await owner;
    await operations.close();
  }
  expect(JSON.parse(await readFile(join(data, "temporary-files.json"), "utf8"))).toEqual([]);
  expect(temporary.status()).toMatchObject({ pending: false, retained: 0, failed: 0 });
});

test.each([1, 2])(
  "cancellation after confirmed publication uses business facts for %i selected items",
  async (count) => {
    const { root, id, operations, temporary } = await setup();
    await writeFile(join(root, "source"), "confirmed");
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const published = temporary.publishedLocked.bind(temporary);
    vi.spyOn(temporary, "publishedLocked").mockImplementationOnce(async (item) => {
      await published(item);
      controller.abort(new AppError("cancelled", "Late cancellation"));
      await gate;
    });
    try {
      const result = operations.run(
        "copy",
        id,
        Array.from({ length: count }, (_, i) => ({
          path: "source",
          targetPath: `target${i}`,
          collision: "error",
        })),
        controller.signal,
      );
      if (count === 1)
        await expect(result).resolves.toMatchObject({ items: [{ outcome: "succeeded" }] });
      else
        await expect(result).rejects.toMatchObject({
          outcome: "partial",
          result: {
            items: [{ outcome: "succeeded" }, { outcome: "failed", error: { code: "cancelled" } }],
          },
        });
      expect(await readFile(join(root, "target0"), "utf8")).toBe("confirmed");
      expect(operations.cleanupPending).toBe(true);
    } finally {
      release();
      await operations.close();
    }
  },
);

test("active upload blocks relocating its directory and recursive copy omits only its owned temporary", async () => {
  const { root, id, files, binary, temporary, run } = await setup();
  const signal = new AbortController().signal;
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source/.kiteline-user.tmp"), "user data");
  const upload = await binary.prepare(id, "source/result", 7, true, undefined, signal);
  try {
    upload.received = await temporary.write(upload.temporary, Buffer.from("partial"), 0, signal);
    await expect(files.rename(id, "source", "renamed", signal)).rejects.toMatchObject({
      code: "busy",
    });
    await expect(run("move", copy("source", "moved"))).rejects.toMatchObject({
      code: "busy",
      outcome: "failed",
    });
    await run("copy", copy("source", "copied"));
    expect(await readdir(join(root, "copied"))).toEqual([".kiteline-user.tmp"]);
    expect(await readFile(join(root, "copied/.kiteline-user.tmp"), "utf8")).toBe("user data");
    await binary.save(upload, signal);
    // Publication releases ownership even while its caller is still unwinding.
    await files.rename(id, "source", "renamed", signal);
    expect(await readFile(join(root, "renamed/result"), "utf8")).toBe("partial");
  } finally {
    await temporary.release(upload.temporary, upload);
  }
});

test("save guards the physical directory and the links traversed by its original path", async () => {
  const { root, id, files, text, temporary, run } = await setup();
  const signal = new AbortController().signal;
  await mkdir(join(root, "physical"));
  await mkdir(join(root, "bridge"));
  await writeFile(join(root, "physical/file"), "base");
  await symlink("../physical", join(root, "bridge/next"));
  await symlink("bridge/next", join(root, "entry"));
  await symlink("entry/file", join(root, "file-link"));
  const save = await text.prepare(id, "file-link", 4, false, "revision", signal);
  try {
    for (const path of ["physical", "bridge", "bridge/next", "entry", "file-link"])
      await expect(files.rename(id, path, "moved", signal)).rejects.toMatchObject({ code: "busy" });
    await symlink("physical", join(root, "replacement"));
    const target = await files.inspect(id, "entry");
    await expect(
      run("move", [
        {
          path: "replacement",
          targetPath: "entry",
          collision: "replace",
          expectedTargetVersion: target.targetVersion,
        },
      ]),
    ).rejects.toMatchObject({ code: "busy", outcome: "failed" });
  } finally {
    await temporary.release(save.temporary, save);
  }
  await files.rename(id, "entry", "released", signal);
});

test("replaced temporary objects and retained cleanup records do not create active ownership", async () => {
  const { root, data, id, files, binary, temporary, run } = await setup();
  const signal = new AbortController().signal;
  await mkdir(join(root, "source"));
  const upload = await binary.prepare(id, "source/result", 1, true, undefined, signal);
  await unlink(upload.temporary.path);
  await writeFile(upload.temporary.path, "replacement");
  await run("copy", copy("source", "copied"));
  expect(await readFile(join(root, "copied", upload.temporary.name), "utf8")).toBe("replacement");
  await temporary.release(upload.temporary, { published: false, uncertain: true });
  expect(JSON.parse(await readFile(join(data, "temporary-files.json"), "utf8"))).toHaveLength(1);
  await files.rename(id, "source", "renamed", signal);
});

test("a published write is not busy when forgetting its cleanup record fails", async () => {
  const { root, data, id, files, binary, temporary } = await setup();
  const signal = new AbortController().signal;
  await mkdir(join(root, "source"));
  const upload = await binary.prepare(id, "source/result", 0, true, undefined, signal);
  await unlink(join(data, "temporary-files.json"));
  await mkdir(join(data, "temporary-files.json"));
  try {
    await expect(binary.save(upload, signal)).resolves.toMatchObject({
      path: "source/result",
      size: 0,
    });
    expect(temporary.status()).toMatchObject({ retained: 1, failed: 1 });
    await files.rename(id, "source", "renamed", signal);
    expect(await readFile(join(root, "renamed/result"), "utf8")).toBe("");
    await mkdir(join(root, "source"));
    await writeFile(upload.temporary.path, "unrelated replacement");
    await rmdir(join(data, "temporary-files.json"));
    await temporary.release(upload.temporary, upload);
    expect(await readFile(upload.temporary.path, "utf8")).toBe("unrelated replacement");
    expect(temporary.status().retained).toBe(0);
  } finally {
    await temporary.release(upload.temporary, upload);
  }
});

test("copy preserves regular permissions and links; explicit replacement changes the link entry only", async () => {
  const { root, files, id, run } = await setup();
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source/a"), Buffer.from([0, 1, 255, 10]));
  await chmod(join(root, "source/a"), 0o640);
  await symlink("a", join(root, "source/link"));
  await symlink(Buffer.from([255]), join(root, "source/raw-link"));
  await run("copy", copy("source", "target"));
  expect(await readFile(join(root, "target/a"))).toEqual(Buffer.from([0, 1, 255, 10]));
  expect((await stat(join(root, "target/a"))).mode & 0o777).toBe(0o640);
  expect(await readlink(join(root, "target/link"))).toBe("a");
  expect(await readlink(join(root, "target/raw-link"), { encoding: "buffer" })).toEqual(
    Buffer.from([255]),
  );
  await writeFile(join(root, "shared"), "keep");
  await symlink("shared", join(root, "config"));
  const inspection = await files.inspect(id, "config");
  await run("copy", [
    {
      path: "source/a",
      targetPath: "config",
      collision: "replace",
      expectedTargetVersion: inspection.targetVersion,
    },
  ]);
  expect((await lstat(join(root, "config"))).isFile()).toBe(true);
  expect(await readFile(join(root, "shared"), "utf8")).toBe("keep");
  await expect(run("copy", copy("source", "target"))).rejects.toMatchObject({
    outcome: "failed",
    code: "conflict",
  });
  await expect(run("copy", copy("source", "source/nested"))).rejects.toMatchObject({
    outcome: "failed",
    code: "invalid_argument",
  });
  await link(join(root, "shared"), join(root, "hard-link"));
  await expect(
    run("move", [
      {
        path: "shared",
        targetPath: "hard-link",
        collision: "replace",
        expectedTargetVersion: (await files.inspect(id, "hard-link")).targetVersion,
      },
    ]),
  ).rejects.toMatchObject({ outcome: "failed", code: "invalid_argument" });
  expect(await readFile(join(root, "shared"), "utf8")).toBe("keep");
});

test("recursive failures retain successful siblings and deletion never follows a final symlink", async () => {
  const { root, data, run } = await setup();
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source/a"), "A");
  await exec("mkfifo", [join(root, "source/pipe")]);
  await expect(run("copy", copy("source", "target"))).rejects.toMatchObject({
    outcome: "partial",
    result: { items: [{ outcome: "partial" }] },
  });
  expect(await readFile(join(root, "target/a"), "utf8")).toBe("A");
  await writeFile(join(data, "outside"), "keep");
  await symlink(join(data, "outside"), join(root, "source/link"));
  await expect(run("delete", ["source"])).rejects.toMatchObject({ outcome: "partial" });
  expect(await readFile(join(data, "outside"), "utf8")).toBe("keep");
  await expect(lstat(join(root, "source/a"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(join(root, "source/pipe"))).isFIFO()).toBe(true);
  await expect(run("delete", ["."])).rejects.toMatchObject({
    outcome: "failed",
    code: "invalid_argument",
  });
});

test("cancellation preserves published directory and stops scheduling its children", async () => {
  const { root, operations, id } = await setup();
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source/a"), "A");
  const controller = new AbortController();
  await expect(
    operations.run("copy", id, copy("source", "target"), controller.signal, (progress) => {
      if (progress.completedItems) controller.abort(new Error("cancel"));
    }),
  ).rejects.toMatchObject({ outcome: "partial" });
  expect((await lstat(join(root, "target"))).isDirectory()).toBe(true);
  await expect(lstat(join(root, "target/a"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("cross-filesystem move publishes before deleting only its copied source; bind deletion enters visible data", async (context) => {
  const { root, data, run, id, binary, temporary } = await setup();
  const disk = join(root, "disk");
  await mkdir(disk);
  try {
    await exec("mount", ["-t", "tmpfs", "-o", "size=1m", "tmpfs", disk]);
  } catch (error) {
    if (/permission denied|Operation not permitted/.test(String(error))) context.skip();
    throw error;
  }
  cleanups.push(() => exec("umount", [disk]));
  await writeFile(join(disk, "source"), "cross-device");
  await run("move", copy("disk/source", "moved"));
  expect(await readFile(join(root, "moved"), "utf8")).toBe("cross-device");
  await expect(lstat(join(disk, "source"))).rejects.toMatchObject({ code: "ENOENT" });
  await symlink(Buffer.from([255]), join(disk, "link"));
  await run("move", copy("disk/link", "moved-link"));
  expect(await readlink(join(root, "moved-link"), { encoding: "buffer" })).toEqual(
    Buffer.from([255]),
  );
  await mkdir(join(disk, "tree"));
  await writeFile(join(disk, "tree/file"), "copied before the new write");
  let pending: Awaited<ReturnType<BinaryFiles["prepare"]>> | undefined;
  const write = temporary.write.bind(temporary);
  vi.spyOn(temporary, "write").mockImplementationOnce(async (...args) => {
    const count = await write(...args);
    pending = await binary.prepare(
      id,
      "disk/tree/late",
      1,
      true,
      undefined,
      new AbortController().signal,
    );
    return count;
  });
  try {
    await expect(run("move", copy("disk/tree", "moved-tree"))).rejects.toMatchObject({
      code: "busy",
      outcome: "partial",
    });
    expect(pending).toBeDefined();
    expect(await readFile(join(root, "moved-tree/file"), "utf8")).toBe(
      "copied before the new write",
    );
    expect((await lstat(pending!.temporary.path)).isFile()).toBe(true);
    expect((await stat(join(disk, "tree"))).isDirectory()).toBe(true);
  } finally {
    if (pending) await temporary.release(pending.temporary, pending);
  }
  await symlink(disk, join(root, "disk-link"));
  await run("move", copy("disk-link", "disk-link/relocated"));
  expect(await readlink(join(disk, "relocated"))).toBe(disk);
  await expect(lstat(join(root, "disk-link"))).rejects.toMatchObject({ code: "ENOENT" });
  const outside = join(data, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "shared"), "delete");
  const project = join(root, "project");
  await mkdir(project);
  const mounted = join(project, "data");
  await mkdir(mounted);
  await exec("mount", ["--bind", outside, mounted]);
  cleanups.push(() => exec("umount", [mounted]));
  let result: unknown;
  try {
    await run("delete", ["project"]);
  } catch (error) {
    result = error;
  }
  expect(result).toBeInstanceOf(OperationError);
  expect(result).toMatchObject({ outcome: "partial" });
  await expect(lstat(join(outside, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(mounted)).isDirectory()).toBe(true);
});
