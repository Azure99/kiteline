import { agentLimits } from "../limits.js";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { Dir } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AppError,
  asError,
  type PathError,
  type Repo,
  type RepoDiscovery,
} from "@kiteline/shared/protocol";
import { CursorBudget, CursorTable } from "../cursor-budget.js";
import type { MetadataStore } from "../metadata.js";
import { commandLine, git } from "./process.js";
import { entryInfo, realPath, sameObject } from "../files/paths.js";

interface Scan {
  workspaceId: string;
  root: string;
  stack: { path: string; checked: boolean; directory?: Dir }[];
  pending?: Repo | PathError;
  found: Set<string>;
}
async function exists(path: string) {
  try {
    return await entryInfo(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
async function identity(repo: Omit<Repo, "id" | "path" | "linked">) {
  const stats = await Promise.all(
    [repo.rootPath, repo.gitDir, repo.commonDir].map((path) => stat(path, { bigint: true })),
  );
  return createHash("sha256")
    .update(
      JSON.stringify([
        repo.rootPath,
        repo.gitDir,
        repo.commonDir,
        ...stats.map((info) => [String(info.dev), String(info.ino)]),
      ]),
    )
    .digest("hex");
}

export class Repositories {
  readonly known = new Map<string, Repo>();
  onObserved?: (workspaceId: string, repo: Repo) => void;
  onComplete?: (workspaceId: string, repoIds: Set<string>) => void;
  private owners = new Map<string, Set<string>>();
  private scans: CursorTable<Scan>;
  constructor(
    private metadata: MetadataStore,
    budget: CursorBudget,
  ) {
    this.scans = new CursorTable(
      budget,
      async (scan) => {
        await Promise.all(scan.stack.map((frame) => frame.directory?.close().catch(() => {})));
      },
      {
        expired: "Repository scan has expired; scan again",
        busy: "Repository scan is running",
        ended: "Repository scan has ended",
      },
    );
  }
  async inspect(path: string, workspaceRoot: string, signal: AbortSignal): Promise<Repo> {
    const root = await realPath(path);
    const readPath = async (option: string) =>
      realPath(resolve(root, commandLine((await git(root, ["rev-parse", option], signal)).bytes)));
    const bare =
      commandLine((await git(root, ["rev-parse", "--is-bare-repository"], signal)).bytes) ===
      "true";
    const rootPath = bare ? root : await readPath("--show-toplevel");
    const within = relative(workspaceRoot, rootPath);
    if (within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
      throw new AppError("unsupported", "Repository root is outside the workspace");
    const gitDir = await readPath("--git-dir");
    const commonDir = await readPath("--git-common-dir");
    const entry = { rootPath, gitDir, commonDir, available: !bare };
    const repo: Repo = {
      ...entry,
      id: await identity(entry),
      path: within.split(sep).join("/") || ".",
      linked: gitDir !== commonDir,
    };
    signal.throwIfAborted();
    this.known.set(repo.id, repo);
    return repo;
  }
  async resolve(workspaceId: string, id: string, signal: AbortSignal) {
    const old = this.known.get(id);
    if (!old)
      throw new AppError(
        "not_found",
        "Repository was not found or has expired; refresh repositories",
      );
    return this.verify(workspaceId, old, signal);
  }
  async verify(workspaceId: string, old: Repo, signal: AbortSignal) {
    const root = this.metadata.workspace(workspaceId).path;
    let current: Repo;
    try {
      current = await this.inspect(old.rootPath, root, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new AppError("not_found", `Repository is unavailable: ${asError(error).message}`);
    }
    if (current.id !== old.id)
      throw new AppError("conflict", "Repository identity has changed; select it again");
    if (!current.available)
      throw new AppError("unsupported", "Bare repositories do not support worktree operations");
    this.remember(workspaceId, current);
    return current;
  }
  async discover(
    workspaceId: string,
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<RepoDiscovery> {
    const root = this.metadata.workspace(workspaceId).path;
    const page = this.scans.acquire(
      token,
      () => ({
        workspaceId,
        root,
        stack: [{ path: root, checked: false }],
        found: new Set(),
      }),
      signal,
      (scan) => scan.workspaceId === workspaceId && scan.root === root,
    );
    const { id, value: scan } = page;
    signal = page.signal;
    let keep = false;
    const result: RepoDiscovery = { repos: [], issues: [], complete: false };
    let bytes = 256,
      visited = 0;
    const started = Date.now();
    const add = (item: Repo | PathError) => {
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (size + 256 > agentLimits.resultBytes)
        throw new AppError("limit_exceeded", "Repository entry exceeds the size limit");
      if (bytes + size > agentLimits.resultBytes) {
        scan.pending = item;
        return false;
      }
      bytes += size;
      if ("id" in item) result.repos.push(item);
      else result.issues.push(item);
      scan.pending = undefined;
      return true;
    };
    try {
      if (scan.pending) add(scan.pending);
      while (
        scan.stack.length &&
        !scan.pending &&
        visited < agentLimits.discoveryDirectories &&
        Date.now() - started < agentLimits.discoverySlice
      ) {
        signal.throwIfAborted();
        const frame = scan.stack.at(-1)!;
        if (!frame.checked) {
          frame.checked = true;
          visited++;
          try {
            if (
              (await exists(join(frame.path, ".git"))) ||
              ((await exists(join(frame.path, "HEAD")))?.isFile() &&
                (await exists(join(frame.path, "objects")))?.isDirectory())
            ) {
              const repo = await this.inspect(frame.path, root, signal);
              signal.throwIfAborted();
              scan.found.add(repo.id);
              this.remember(workspaceId, repo);
              if (!repo.available) {
                scan.stack.pop();
                if (!add(repo)) break;
                continue;
              }
              if (!add(repo)) break;
            }
          } catch (error) {
            signal.throwIfAborted();
            if (
              !add({
                path: relative(root, frame.path).split(sep).join("/") || ".",
                error: asError(error),
              })
            )
              break;
          }
        }
        try {
          if (!frame.directory) {
            const directory = await opendir(frame.path, { encoding: "buffer" as BufferEncoding });
            if (signal.aborted) {
              await directory.close();
              signal.throwIfAborted();
            }
            frame.directory = directory;
          }
          const entry = await frame.directory.read();
          if (!entry) {
            await frame.directory.close();
            scan.stack.pop();
            continue;
          }
          if (!entry.isDirectory() && !(process.platform === "win32" && entry.isSymbolicLink()))
            continue;
          const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
          if (!isUtf8(name)) {
            if (
              !add({
                path: relative(root, frame.path).split(sep).join("/") || ".",
                error: {
                  code: "unsupported",
                  message: "Directory contains a non-UTF-8 name; this item cannot be scanned",
                },
              })
            )
              break;
          } else if (name.toString() !== ".git") {
            const path = join(frame.path, name.toString());
            try {
              const info = await entryInfo(path);
              if (info.isDirectory()) {
                if (name.toString().toLowerCase() === ".git") {
                  const metadata = await exists(join(frame.path, ".git"));
                  if (metadata && sameObject(info, metadata)) continue;
                }
                scan.stack.push({ path, checked: false });
              }
            } catch (error) {
              signal.throwIfAborted();
              if (!add({ path: relative(root, path).split(sep).join("/"), error: asError(error) }))
                break;
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          await frame.directory?.close().catch(() => {});
          scan.stack.pop();
          if (
            !add({
              path: relative(root, frame.path).split(sep).join("/") || ".",
              error: asError(error),
            })
          )
            break;
        }
      }
      signal.throwIfAborted();
      result.complete = scan.stack.length === 0 && !scan.pending;
      if (result.complete) {
        this.owners.set(workspaceId, scan.found);
        this.prune();
        this.onComplete?.(workspaceId, scan.found);
      } else result.scanCursor = id;
      keep = !result.complete;
      return result;
    } finally {
      await page.finish(keep);
    }
  }
  release(id: string) {
    return this.scans.release(id);
  }
  async retain(workspaceIds: Set<string>) {
    for (const id of this.owners.keys()) if (!workspaceIds.has(id)) this.owners.delete(id);
    this.prune();
    await this.scans.close((scan) => !workspaceIds.has(scan.workspaceId));
  }
  async close() {
    const closing = this.scans.close();
    this.known.clear();
    this.owners.clear();
    await closing;
  }
  private remember(workspaceId: string, repo: Repo) {
    let owned = this.owners.get(workspaceId);
    if (!owned) this.owners.set(workspaceId, (owned = new Set()));
    owned.add(repo.id);
    this.onObserved?.(workspaceId, repo);
  }
  private prune() {
    const retained = new Set([...this.owners.values()].flatMap((ids) => [...ids]));
    for (const id of this.known.keys()) if (!retained.has(id)) this.known.delete(id);
  }
}
