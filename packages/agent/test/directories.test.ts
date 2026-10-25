import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Directories } from "../src/files/directories.js";
import { MetadataStore } from "../src/metadata.js";
import { testConfig as config } from "./support/config.js";
import { gitRepoFixture } from "./support/git.js";
import { CursorBudget } from "../src/cursor-budget.js";
import { Repositories } from "../src/git/repos.js";
import { agentLimits } from "../src/limits.js";
import { absolutePath, windowsName } from "@kiteline/shared/protocol";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const path = await mkdtemp("/var/tmp/kiteline-directory-test-");
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
test("device paths distinguish native absolute paths from Windows aliases", () => {
  for (const path of [
    "C:\\",
    "C:/Users/Project",
    "\\\\host.example\\share\\folder",
    "\\\\host\\C$\\folder",
  ])
    expect(absolutePath(path, "windows")).toBe(path);
  for (const path of [
    "/",
    "\\folder",
    "C:folder",
    "\\\\?\\C:\\x",
    "\\\\.\\pipe\\x",
    "C:\\a:b",
    "C:\\AUX.txt",
    "C:\\folder.\\x",
  ])
    expect(() => absolutePath(path, "windows")).toThrow();
  for (const name of ["a\\b", "a:b", "CON .txt", "CONOUT$", "a.", "a "])
    expect(() => windowsName(name)).toThrow();
  for (const os of ["linux", "macos"] as const) {
    expect(absolutePath("/a:b/CON.txt/space ", os)).toBe("/a:b/CON.txt/space ");
    expect(() => absolutePath("relative", os)).toThrow();
  }
});

test("directory pages keep raw names non-actionable and enforce the concurrent cursor limit", async () => {
  const path = await directory();
  for (let index = 0; index < 501; index++) await writeFile(join(path, `file-${index}`), "");
  await writeFile(Buffer.concat([Buffer.from(path + "/"), Buffer.from([255])]), "raw");
  const directories = new Directories();
  cleanups.push(() => directories.close());
  const first = await directories.list(path);
  const second = await directories.list(path, first.entries.nextCursor);
  const entries = [...first.entries.items, ...second.entries.items];
  expect(entries).toHaveLength(502);
  expect(entries.find((entry) => entry.unavailableReason)).toMatchObject({
    path: null,
    unavailableReason: "invalid_utf8",
  });
  expect(entries.find((entry) => entry.name === "file-0")).toMatchObject({
    path: join(path, "file-0"),
    size: 0,
    mtime: expect.any(String),
  });
  const peer = await directories.list(path);
  for (let index = 0; index < 20; index++) {
    const page = await directories.list(path);
    await directories.release(page.entries.nextCursor!);
    await directories.release(page.entries.nextCursor!);
  }
  const peerMore = await directories.list(path, peer.entries.nextCursor);
  expect(peer.entries.items.length + peerMore.entries.items.length).toBe(502);
  const concurrent = await Promise.allSettled(
    Array.from({ length: 32 }, () => directories.list(path)),
  );
  expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(16);
  const saved = concurrent.find((result) => result.status === "fulfilled");
  expect(saved?.status).toBe("fulfilled");
  await directories.close();
  if (saved?.status === "fulfilled")
    await expect(directories.list(path, saved.value.entries.nextCursor)).rejects.toMatchObject({
      code: "conflict",
    });
});

test("closing a first directory read waits for it and prevents a late live cursor", async () => {
  const path = await directory();
  const directories = new Directories();
  cleanups.push(() => directories.close());
  const pending = directories.list(path);
  const cancelled = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await Promise.all([directories.close(), directories.close()]);
  await cancelled;
  await expect(directories.list(path)).resolves.toMatchObject({
    entries: { items: [], truncated: false },
  });
});

test("directory and repository pages share slots until their resources are released", async () => {
  const saved = { ...agentLimits };
  Object.assign(agentLimits, { listPageEntries: 1, discoveryDirectories: 1, cursorsPerDevice: 2 });
  const data = await directory();
  const root = join(data, "project");
  await mkdir(join(root, "one"), { recursive: true });
  await mkdir(join(root, "two"));
  const metadata = new MetadataStore(config(data));
  const workspace = await metadata.add(root);
  const budget = new CursorBudget();
  const directories = new Directories(budget);
  const repos = new Repositories(metadata, budget);
  const signal = new AbortController().signal;
  try {
    const listing = await directories.list(root);
    expect(listing.entries.nextCursor).toBeTruthy();
    const scan = await repos.discover(workspace.id, undefined, signal);
    expect(scan.scanCursor).toBeTruthy();
    await expect(directories.list(root)).rejects.toMatchObject({ code: "busy" });
    await Promise.all([
      directories.release(listing.entries.nextCursor!),
      directories.release(listing.entries.nextCursor!),
    ]);
    const second = await repos.discover(workspace.id, undefined, signal);
    expect(second.scanCursor).toBeTruthy();
    await expect(directories.list(root)).rejects.toMatchObject({ code: "busy" });
    await repos.release(scan.scanCursor!);
    const available = await directories.list(root);
    expect(available.entries.items).toHaveLength(1);
  } finally {
    await Promise.all([directories.close(), repos.close()]);
    Object.assign(agentLimits, saved);
  }
});

test("repository continuation renews on acquisition and a busy reader cannot renew it", async () => {
  const data = await directory();
  const root = join(data, "project");
  const nested = join(root, "repo");
  await mkdir(nested, { recursive: true });
  await gitRepoFixture(nested);
  const metadata = new MetadataStore(config(data));
  const workspace = await metadata.add(root);
  const repos = new Repositories(metadata, new CursorBudget());
  const saved = { ...agentLimits };
  Object.assign(agentLimits, { discoveryDirectories: 1, cursorsPerDevice: 1 });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  let resume!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let readingSignal: AbortSignal | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    const first = await repos.discover(workspace.id, undefined, new AbortController().signal);
    expect(first.scanCursor).toBeTruthy();
    await vi.advanceTimersByTimeAsync(59_000);
    const inspect = repos.inspect.bind(repos);
    vi.spyOn(repos, "inspect").mockImplementationOnce(async (...args) => {
      readingSignal = args[2];
      entered();
      await held;
      return inspect(...args);
    });
    pending = repos.discover(workspace.id, first.scanCursor, new AbortController().signal);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await started;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(readingSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(58_998);
    await expect(
      repos.discover(workspace.id, first.scanCursor, new AbortController().signal),
    ).rejects.toMatchObject({ code: "busy" });
    expect(readingSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(readingSignal!.aborted).toBe(true);
    resume();
    await cancelled;
    const available = await repos.discover(workspace.id, undefined, new AbortController().signal);
    expect(available.scanCursor).toBeTruthy();
  } finally {
    resume();
    await pending?.catch(() => {});
    await repos.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    Object.assign(agentLimits, saved);
  }
});
