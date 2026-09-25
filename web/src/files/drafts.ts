import { newId } from "../lib/id";
import { useSyncExternalStore } from "react";
import { Compartment, type EditorState } from "@codemirror/state";
import type { KitelineError, Device, TextFormat } from "@kiteline/shared/protocol";
import { encodeText } from "@kiteline/shared/text";
import { ApiError, errorMessage, rpc } from "../lib/api";
import { readText, writeText, type DiskText, type FileTarget } from "./content";
import { textState } from "./editor-state";
import { isWithin, movedPath } from "./use-browser";

export type DraftNotice =
  | "loadingCapacity"
  | "fileCapacity"
  | "pageCapacity"
  | "savedOldPath"
  | "duplicateDraft"
  | "diskMatches"
  | "checkingMoved"
  | "diskChangedKept"
  | "deletedDraft"
  | "missingDraft";

interface SaveSnapshot {
  target: FileTarget;
  raw: string;
}

interface PendingSave extends SaveSnapshot {
  sourcePath: string;
  reconciliation?: Promise<void>;
}

export interface Draft extends FileTarget {
  id: string;
  deviceName: string;
  workspaceName: string;
  state?: EditorState;
  language: Compartment;
  phrases: Compartment;
  format: TextFormat;
  bytes: number;
  baseText: string;
  baseRaw: string;
  revision?: string;
  resolvedPath?: string;
  scrollTop: number;
  scrollLeft: number;
  location?: { line: number; range?: [number, number] };
  busy?: "loading" | "saving" | "checking";
  error?: unknown;
  observationError?: unknown;
  notice?: DraftNotice;
  pendingSave?: PendingSave;
  unknownSave?: SaveSnapshot;
  missing?: boolean;
  diskChanged?: boolean;
  request?: AbortController;
  diskActivity: number;
  readChannel?: string;
  readError?: ApiError;
}

export const isDirty = (draft: Draft) =>
  !!draft.state &&
  (draft.state.doc.toString() !== draft.baseText ||
    draft.unknownSave !== undefined ||
    draft.missing === true);

export class DraftStore {
  private items: Draft[] = [];
  private listeners = new Set<() => void>();
  private editorLimits = new Map<string, number>();
  private totalLimit?: number;
  closing?: string;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.items;
  changed() {
    this.items = [...this.items];
    for (const listener of this.listeners) listener();
  }
  has(draft: Draft) {
    return this.items.includes(draft);
  }
  fileFailed(channelId: string, error: KitelineError) {
    const draft = this.items.find((item) => item.readChannel === channelId);
    if (!draft) return;
    draft.readError = new ApiError(error.code, error.message, "failed", error.details);
    draft.error = draft.readError;
    this.changed();
  }
  private async read(draft: Draft, target: FileTarget, request: AbortController) {
    draft.readChannel = undefined;
    draft.readError = undefined;
    try {
      const disk = await readText(
        { deviceId: target.deviceId, workspaceId: target.workspaceId, path: target.path },
        request.signal,
        (id) => {
          if (draft.request === request) draft.readChannel = id;
        },
      );
      if (draft.request === request) draft.readChannel = undefined;
      return disk;
    } catch (error) {
      throw draft.readError ?? error;
    }
  }
  limits(devices: Device[], total: number) {
    this.totalLimit = total;
    for (const device of devices)
      if (device.editorBytes !== undefined) this.editorLimits.set(device.id, device.editorBytes);
    this.changed();
  }
  limitError(draft: Draft, size: number, previous = draft.bytes): DraftNotice | undefined {
    const limit = this.editorLimits.get(draft.deviceId);
    if (limit === undefined || this.totalLimit === undefined) return "loadingCapacity";
    if (size > limit && size > previous) return "fileCapacity";
    const total = this.items.reduce((sum, item) => sum + item.bytes, 0) - draft.bytes + size;
    if (total > this.totalLimit && size > previous) return "pageCapacity";
  }
  canSave(draft: Draft) {
    const limit = this.editorLimits.get(draft.deviceId);
    return !!draft.state && limit !== undefined && draft.bytes <= limit && !draft.busy;
  }
  overLimit(draft: Draft) {
    const limit = this.editorLimits.get(draft.deviceId);
    return limit !== undefined && draft.bytes > limit;
  }
  find(target: FileTarget, id?: string) {
    return this.items.find(
      (item) =>
        item.deviceId === target.deviceId &&
        item.workspaceId === target.workspaceId &&
        (id ? item.id === id : item.path === target.path),
    );
  }
  open(target: FileTarget & { deviceName: string; workspaceName: string }, disk?: DiskText) {
    const existing = this.find(target);
    if (existing) return existing;
    const draft: Draft = {
      ...target,
      id: newId(),
      language: new Compartment(),
      phrases: new Compartment(),
      format: { bom: false, lineEnding: "lf" },
      bytes: 0,
      baseText: "",
      baseRaw: "",
      scrollTop: 0,
      scrollLeft: 0,
      diskActivity: 0,
    };
    this.items.push(draft);
    if (disk) {
      try {
        this.adopt(draft, disk);
      } catch (error) {
        draft.error = error;
        this.changed();
      }
    } else void this.load(draft);
    return draft;
  }
  update(draft: Draft, state: EditorState) {
    if (!this.has(draft)) return;
    const changed = draft.state?.doc !== state.doc;
    draft.state = state;
    if (!changed) return;
    draft.bytes = encodeText(state.doc.toString(), draft.format).length;
    this.changed();
  }
  adopt(draft: Draft, disk: DiskText) {
    const size = encodeText(disk.text, disk.meta as TextFormat).length;
    const error = this.limitError(draft, size);
    if (error) {
      draft.notice = error;
      throw new ApiError("limit_exceeded", "The text exceeds the available editor capacity");
    }
    draft.path = disk.target.path;
    draft.format = disk.meta as TextFormat;
    draft.state = textState(
      disk.text,
      draft.language,
      draft.phrases,
      draft.state ? draft.language.get(draft.state) : undefined,
    );
    draft.bytes = size;
    draft.baseText = disk.text;
    draft.baseRaw = disk.raw;
    draft.revision = disk.meta.revision;
    draft.resolvedPath = disk.meta.resolvedPath;
    draft.unknownSave = undefined;
    draft.missing = false;
    draft.error = undefined;
    draft.observationError = undefined;
    draft.notice = undefined;
    draft.diskChanged = false;
    draft.scrollTop = draft.scrollLeft = 0;
    this.changed();
  }
  async load(draft: Draft) {
    if (!this.has(draft) || draft.busy) return;
    draft.diskActivity++;
    const request = new AbortController();
    const path = draft.path;
    draft.request = request;
    draft.busy = "loading";
    draft.error = undefined;
    this.changed();
    try {
      const disk = await this.read(draft, { ...draft }, request);
      if (this.has(draft) && draft.request === request && draft.path === path)
        this.adopt(draft, disk);
    } catch (error) {
      if (this.has(draft) && draft.request === request && draft.path === path) draft.error = error;
    } finally {
      if (draft.request === request) {
        draft.diskActivity++;
        draft.busy = undefined;
        draft.request = undefined;
      }
      if (this.has(draft)) this.changed();
    }
  }
  async save(draft: Draft, path = draft.path, revision: string | null = draft.revision ?? null) {
    if (!this.canSave(draft) || !this.has(draft)) return false;
    draft.diskActivity++;
    const text = draft.state!.doc.toString();
    const bytes = encodeText(text, draft.format);
    const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    const request = new AbortController();
    draft.request = request;
    draft.busy = "saving";
    const pending: PendingSave = {
      target: { deviceId: draft.deviceId, workspaceId: draft.workspaceId, path },
      raw,
      sourcePath: draft.path,
    };
    draft.pendingSave = pending;
    draft.error = undefined;
    this.changed();
    try {
      const saved = await writeText(
        { ...draft, path },
        bytes,
        revision ?? undefined,
        request.signal,
      );
      window.dispatchEvent(
        new CustomEvent("kiteline:file-written", {
          detail: { deviceId: draft.deviceId, workspaceId: draft.workspaceId, path },
        }),
      );
      if (!this.has(draft) || draft.request !== request) return false;
      if (draft.path !== pending.sourcePath) {
        draft.notice = "savedOldPath";
        return false;
      }
      const duplicate = this.items.some(
        (item) =>
          item !== draft &&
          item.deviceId === draft.deviceId &&
          item.workspaceId === draft.workspaceId &&
          item.path === path,
      );
      draft.path = path;
      draft.baseText = text;
      draft.baseRaw = raw;
      draft.revision = saved.revision;
      draft.unknownSave = undefined;
      draft.missing = false;
      draft.diskChanged = false;
      draft.observationError = undefined;
      draft.notice = duplicate ? "duplicateDraft" : undefined;
      return true;
    } catch (error) {
      // A failed save still needs the revision of its renamed source file.
      while (draft.request === request && pending.reconciliation) {
        const reconciliation = pending.reconciliation;
        await reconciliation;
        if (pending.reconciliation === reconciliation) break;
      }
      if (this.has(draft) && draft.request === request && draft.path === pending.sourcePath) {
        draft.error = error;
        if (error instanceof ApiError && error.outcome === "unknown")
          draft.unknownSave = { target: pending.target, raw: pending.raw };
      }
      return false;
    } finally {
      if (draft.request === request) {
        draft.diskActivity++;
        draft.busy = undefined;
        draft.request = undefined;
        draft.pendingSave = undefined;
      }
      if (this.has(draft)) this.changed();
    }
  }
  async check(draft: Draft): Promise<DiskText | undefined> {
    if (draft.busy || !this.has(draft)) return;
    draft.diskActivity++;
    const path = draft.path;
    const unknown = draft.unknownSave;
    const request = new AbortController();
    draft.request = request;
    draft.busy = "checking";
    this.changed();
    try {
      const disk = await this.read(draft, unknown?.target ?? { ...draft }, request);
      if (!this.has(draft) || draft.request !== request || draft.path !== path) return;
      if (unknown && disk.raw === unknown.raw) {
        this.confirmSave(draft, disk);
      }
      return disk;
    } catch (error) {
      if (this.has(draft) && draft.request === request && draft.path === path) draft.error = error;
    } finally {
      if (draft.request === request) {
        draft.diskActivity++;
        draft.request = undefined;
        draft.busy = undefined;
      }
      if (this.has(draft)) this.changed();
    }
  }
  async observe(draft: Draft, signal: AbortSignal) {
    if (draft.busy || !draft.state || !this.has(draft)) return;
    const activity = draft.diskActivity,
      path = draft.path;
    try {
      const disk = await readText({ ...draft }, signal);
      if (
        signal.aborted ||
        !this.has(draft) ||
        draft.diskActivity !== activity ||
        draft.path !== path
      )
        return;
      draft.diskChanged = disk.meta.revision !== draft.revision;
      draft.observationError = undefined;
      draft.missing = false;
      this.changed();
    } catch (error) {
      if (
        signal.aborted ||
        !this.has(draft) ||
        draft.diskActivity !== activity ||
        draft.path !== path
      )
        return;
      draft.observationError = error;
      if (error instanceof ApiError && error.code === "not_found") draft.missing = true;
      this.changed();
    }
  }
  async renameFile(target: FileTarget, newName: string) {
    const drafts = this.items.filter(
      (draft) =>
        draft.deviceId === target.deviceId &&
        draft.workspaceId === target.workspaceId &&
        (isWithin(draft.path, target.path) ||
          (draft.pendingSave && isWithin(draft.pendingSave.target.path, target.path)) ||
          (draft.unknownSave && isWithin(draft.unknownSave.target.path, target.path))),
    );
    const result = await rpc(target.deviceId, "files.rename", {
      workspaceId: target.workspaceId,
      path: target.path,
      newName,
    });
    void this.rename(target.deviceId, target.workspaceId, result.from, result.to, drafts);
    return result;
  }
  private confirmSave(draft: Draft, disk: DiskText) {
    draft.path = disk.target.path;
    draft.baseRaw = disk.raw;
    draft.baseText = disk.text;
    draft.revision = disk.meta.revision;
    draft.resolvedPath = disk.meta.resolvedPath;
    draft.unknownSave = undefined;
    draft.missing = false;
    draft.diskChanged = false;
    draft.error = undefined;
    draft.observationError = undefined;
    draft.notice = this.items.some(
      (item) =>
        item !== draft &&
        item.deviceId === draft.deviceId &&
        item.workspaceId === draft.workspaceId &&
        item.path === draft.path,
    )
      ? "duplicateDraft"
      : "diskMatches";
    window.dispatchEvent(new CustomEvent("kiteline:file-written", { detail: disk.target }));
  }
  private async checkMoved(
    draft: Draft,
    pending: PendingSave | undefined,
    previous: Promise<void>,
  ) {
    const request = pending ? draft.request! : new AbortController();
    if (!pending) {
      draft.request = request;
      draft.busy = "checking";
    }
    draft.readChannel = undefined;
    draft.readError = undefined;
    const source = { deviceId: draft.deviceId, workspaceId: draft.workspaceId, path: draft.path };
    const snapshot = pending ?? draft.unknownSave;
    const activity = draft.diskActivity;
    const current = () =>
      this.has(draft) &&
      draft.request === request &&
      draft.diskActivity === activity &&
      draft.path === source.path;
    let sourceDisk: DiskText | undefined;
    try {
      await previous;
      if (!current()) return;
      try {
        sourceDisk = await readText(source, request.signal);
        if (!current()) return;
        draft.missing = false;
        draft.observationError = undefined;
        if (sourceDisk.raw === draft.baseRaw) {
          draft.revision = sourceDisk.meta.revision;
          draft.resolvedPath = sourceDisk.meta.resolvedPath;
          draft.diskChanged = false;
          draft.notice = undefined;
        } else {
          draft.diskChanged = true;
          draft.notice = "diskChangedKept";
        }
      } catch (error) {
        if (!current()) return;
        draft.observationError = error;
        draft.notice = undefined;
        if (error instanceof ApiError && error.code === "not_found") draft.missing = true;
      }
      if (snapshot) {
        try {
          const disk =
            snapshot.target.path === source.path
              ? sourceDisk
              : await readText(snapshot.target, request.signal);
          if (!current()) return;
          if (disk?.raw === snapshot.raw) {
            this.confirmSave(draft, disk);
            if (pending) {
              draft.diskActivity++;
              draft.pendingSave = undefined;
              draft.request = undefined;
              draft.busy = undefined;
              request.abort();
            }
          }
        } catch (error) {
          // An observation cannot decide whether the independent write will publish.
          if (current() && !pending) draft.error = error;
        }
      }
    } finally {
      if (
        current() &&
        this.items.some(
          (item) =>
            item !== draft &&
            item.deviceId === draft.deviceId &&
            item.workspaceId === draft.workspaceId &&
            item.path === draft.path,
        )
      )
        draft.notice = "duplicateDraft";
      if (!pending && draft.request === request) {
        draft.diskActivity++;
        draft.request = undefined;
        draft.busy = undefined;
      }
      if (this.has(draft)) this.changed();
    }
  }
  async rename(
    deviceId: string,
    workspaceId: string,
    from: string,
    to: string,
    candidates = this.items,
  ) {
    const moved = candidates.filter(
      (item) =>
        this.has(item) &&
        item.deviceId === deviceId &&
        item.workspaceId === workspaceId &&
        (movedPath(item.path, from, to) !== item.path ||
          (item.pendingSave &&
            movedPath(item.pendingSave.target.path, from, to) !== item.pendingSave.target.path) ||
          (item.unknownSave &&
            movedPath(item.unknownSave.target.path, from, to) !== item.unknownSave.target.path)),
    );
    let checking = Promise.resolve();
    for (const draft of moved) {
      draft.diskActivity++;
      const pending = draft.pendingSave;
      draft.path = movedPath(draft.path, from, to);
      if (draft.unknownSave)
        draft.unknownSave.target.path = movedPath(draft.unknownSave.target.path, from, to);
      draft.notice = "checkingMoved";
      if (pending && movedPath(pending.target.path, from, to) === pending.target.path) {
        pending.sourcePath = draft.path;
        pending.reconciliation = this.checkMoved(draft, pending, checking);
        checking = pending.reconciliation;
        continue;
      }
      draft.request?.abort();
      draft.request = undefined;
      draft.busy = undefined;
      if (pending) {
        draft.unknownSave = {
          target: { ...pending.target, path: movedPath(pending.target.path, from, to) },
          raw: pending.raw,
        };
        draft.pendingSave = undefined;
      }
      checking = this.checkMoved(draft, undefined, checking);
    }
    this.changed();
    await checking;
  }
  private markMissing(draft: Draft, notice: DraftNotice) {
    draft.diskActivity++;
    draft.request?.abort();
    draft.request = undefined;
    draft.busy = undefined;
    draft.pendingSave = undefined;
    draft.missing = true;
    draft.notice = notice;
  }
  deleted(
    deviceId: string,
    workspaceId: string,
    path: string,
    notice: DraftNotice = "deletedDraft",
  ) {
    for (const draft of this.items)
      if (
        draft.deviceId === deviceId &&
        draft.workspaceId === workspaceId &&
        (draft.path === path || draft.path.startsWith(path + "/"))
      )
        this.markMissing(draft, notice);
    this.changed();
  }
  async checkMissing(deviceId: string, workspaceId: string, path: string) {
    const affected = this.items.filter(
      (draft) =>
        draft.deviceId === deviceId &&
        draft.workspaceId === workspaceId &&
        (draft.path === path || draft.path.startsWith(path + "/")),
    );
    for (const draft of affected) {
      const originalPath = draft.path;
      const activity = draft.diskActivity;
      try {
        await rpc(deviceId, "files.inspect", { workspaceId, path: originalPath });
      } catch (error) {
        if (
          this.has(draft) &&
          draft.path === originalPath &&
          draft.diskActivity === activity &&
          error instanceof ApiError &&
          error.code === "not_found"
        ) {
          this.markMissing(draft, "missingDraft");
          this.changed();
        }
      }
    }
  }
  close(draft: Draft) {
    draft.request?.abort();
    this.items = this.items.filter((item) => item !== draft);
    if (this.closing === draft.id) this.closing = undefined;
    this.changed();
  }
  clear() {
    for (const item of this.items) item.request?.abort();
    this.items = [];
    this.closing = undefined;
    this.changed();
  }
}
export function useDrafts(store: DraftStore) {
  return useSyncExternalStore(store.subscribe, store.snapshot);
}
export function draftError(draft: Draft) {
  const error = draft.error ?? draft.observationError;
  return error ? errorMessage(error) : undefined;
}
