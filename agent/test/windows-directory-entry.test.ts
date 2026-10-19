import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { entryInfo, linkType, readDirectoryEntry } from "../src/files/paths.js";

const native = vi.hoisted(() => ({ directoryEntry: vi.fn(), fileAttributes: vi.fn() }));
vi.mock("@kiteline/shared/windows/native", () => ({ windowsNative: () => native }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.resetAllMocks();
});

test("unsupported Windows reparse entries stay visible without enabling file operations", async () => {
  const metadata = { attributes: 0x400, tag: 0x8000001b, size: 0, mtimeMs: 1000 };
  native.directoryEntry.mockResolvedValue(metadata);
  native.fileAttributes.mockResolvedValue(metadata);
  await expect(
    readDirectoryEntry("/entries", Buffer.from("alias.exe"), "alias.exe"),
  ).resolves.toEqual({
    name: "alias.exe",
    path: null,
    kind: "other",
    size: 0,
    mtime: "1970-01-01T00:00:01.000Z",
    unavailableReason: "unsupported_reparse_point",
  });
  for (const operation of [linkType, entryInfo]) {
    await expect(operation("/entries/alias.exe")).rejects.toMatchObject({
      code: "unsupported",
      message: "Unsupported Windows reparse point: /entries/alias.exe",
    });
  }
});

test("ordinary Windows entries retain their paths and metadata", async () => {
  native.directoryEntry.mockResolvedValue({ attributes: 0, tag: 0, size: 42, mtimeMs: 2000 });
  await expect(
    readDirectoryEntry("/entries", Buffer.from("notes.txt"), "notes.txt"),
  ).resolves.toEqual({
    name: "notes.txt",
    path: "notes.txt",
    kind: "file",
    size: 42,
    mtime: "1970-01-01T00:00:02.000Z",
  });
});

test("native errors are not converted to unavailable entries", async () => {
  for (const code of ["EACCES", "ENOENT"]) {
    const error = Object.assign(new Error(code), { code });
    native.directoryEntry.mockRejectedValue(error);
    native.fileAttributes.mockRejectedValue(error);
    await expect(readDirectoryEntry("/entries", Buffer.from("entry"), "entry")).rejects.toBe(error);
    await expect(linkType("/entries/entry")).rejects.toBe(error);
  }
});
