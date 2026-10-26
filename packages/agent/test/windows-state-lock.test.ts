import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lockAgentRuntime, lockAgentState } from "../src/state-lock.js";

const native = vi.hoisted(() => ({ lock: vi.fn(), closeHandle: vi.fn() }));
vi.mock("@kiteline/shared/windows/native", () => ({ windowsNative: () => native }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string;
beforeEach(async () => {
  root = await mkdtemp("/var/tmp/kiteline-windows-lock-");
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe.each([
  { kind: "data", fileName: "process.lock", lock: lockAgentState },
  { kind: "run", fileName: "agent.lock", lock: lockAgentRuntime },
])("Windows $kind directory lock", ({ kind, fileName, lock }) => {
  test("requests a native lock and preserves the file on release", async () => {
    const path = join(root, fileName);
    await writeFile(path, "existing lock file");
    const handle = {};
    native.lock.mockReturnValueOnce(handle);

    const release = await lock(root);
    expect(native.lock).toHaveBeenCalledExactlyOnceWith(path);
    expect(native.closeHandle).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("existing lock file");
    await release();
    expect(native.closeHandle).toHaveBeenCalledExactlyOnceWith(handle);
    expect(await readFile(path, "utf8")).toBe("existing lock file");
  });

  test("identifies a locked directory without guessing the holder", async () => {
    const cause = Object.assign(new Error("acquire lock: Win32 error 33"), {
      win32Code: 33,
    });
    native.lock.mockImplementationOnce(() => {
      throw cause;
    });

    const failure = lock(root);
    await expect(failure).rejects.toMatchObject({
      message: `Agent ${kind} directory is already locked: ${root} (Win32 error 33)`,
      cause,
    });
    await expect(failure.catch((error: Error) => error.cause)).resolves.toBe(cause);
  });

  test.each([32, 5])("preserves Win32 error %i as the actual failure", async (win32Code) => {
    const cause = Object.assign(new Error(`open lock file: Win32 error ${win32Code}`), {
      win32Code,
    });
    native.lock.mockImplementationOnce(() => {
      throw cause;
    });

    await expect(lock(root)).rejects.toMatchObject({
      message: `Could not lock agent ${kind} directory ${root}: ${cause.message}`,
      cause,
    });
  });

  test("includes the directory and Node error when the file cannot be opened", async () => {
    const directory = join(root, "missing");
    await expect(lock(directory)).rejects.toMatchObject({
      message: expect.stringContaining(
        `Could not lock agent ${kind} directory ${directory}: ENOENT`,
      ),
      cause: { code: "ENOENT", syscall: "open", path: join(directory, fileName) },
    });
    expect(native.lock).not.toHaveBeenCalled();
  });

  test("includes the directory and original error when the temporary handle cannot close", async () => {
    const file = await open(join(root, fileName), "a");
    const close = file.close.bind(file);
    const cause = Object.assign(new Error("close failed"), { code: "EIO" });
    vi.spyOn(file, "close").mockRejectedValueOnce(cause);
    vi.mocked(open).mockResolvedValueOnce(file);
    try {
      await expect(lock(root)).rejects.toMatchObject({
        message: `Could not lock agent ${kind} directory ${root}: ${cause.message}`,
        cause,
      });
      expect(native.lock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  test("propagates native release failures", async () => {
    const release = await lock(root);
    const cause = new Error("close native handle: Win32 error 6");
    native.closeHandle.mockImplementationOnce(() => {
      throw cause;
    });
    await expect(release()).rejects.toBe(cause);
  });
});
