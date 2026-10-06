import { newId } from "../lib/id";
import { useCallback, useSyncExternalStore } from "react";
import { Compartment, type EditorState } from "@codemirror/state";
import type { KitelineError, Device, TextFormat } from "@kiteline/shared/protocol";
import { encodeText } from "@kiteline/shared/protocol/text";
import { apiError, ApiError, errorMessage, rpc } from "../lib/api";
import { emit } from "../lib/events";
import { readText, writeText, type DiskText, type FileTarget } from "./content";
import { textState } from "./editor-state";
import { isWithin, movedPath } from "./paths";

export type DraftNotice =
  | "loadingCapacity"
  | "fileCapacity"
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
  replacesSource: boolean;
}

// Draft and disk ownership: docs/design/files.md.
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
  operation?: { request: AbortController } & (
    | { kind: "loading" | "checking" }
    | { kind: "saving"; snapshot: SaveSnapshot }
  );
  error?: unknown; // Explicit operation failure, retained for the user's next action.
  observationError?: unknown; // Background observation failure; does not replace an operation error.
  notice?: DraftNotice;
  unknownSave?: SaveSnapshot; // Unconfirmed publication checked against its original target.
  missing?: boolean;
  diskChanged?: boolean;
  diskActivity: number; // Invalidates background reads when a foreground operation changes disk facts.
  sourceVersion: number; // Invalidates captured file changes after the draft adopts another source.
  readChannel?: string; // Associates channel failure events with the active foreground read.
  readError?: ApiError; // Preserves the channel diagnostic when HTTP cannot deliver the body.
}

interface CapturedDraft {
  draft: Draft;
  source: { path: string; version: number };
}

interface FileChange {
  drafts: CapturedDraft[];
}

const dirtyCache = new WeakMap<
  Draft,
  { doc: EditorState["doc"]; baseText: string; dirty: boolean }
>();
export function isDirty(draft: Draft) {
  if (!draft.state) return false;
  let cached = dirtyCache.get(draft);
  if (cached?.doc !== draft.state.doc || cached.baseText !== draft.baseText) {
    cached = {
      doc: draft.state.doc,
      baseText: draft.baseText,
      dirty: draft.state.doc.toString() !== draft.baseText,
    };
    dirtyCache.set(draft, cached);
  }
  return cached.dirty || draft.unknownSave !== undefined || draft.missing === true;
}

export class DraftStore {
  private items: Draft[] = [];
  private listeners = new Set<() => void>();
  private draftListeners = new WeakMap<Draft, Set<() => void>>();
  private draftVersions = new WeakMap<Draft, number>();
  private editorLimits = new Map<string, number>();
  private closingId?: string;
  get closing() {
    return this.closingId;
  }
  setClosing(id?: string) {
    this.closingId = id;
    this.changed();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.items;
  subscribeDraft(draft: Draft, listener: () => void) {
    let listeners = this.draftListeners.get(draft);
    if (!listeners) this.draftListeners.set(draft, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  draftSnapshot(draft: Draft) {
    return this.draftVersions.get(draft) ?? 0;
  }
  changed(draft?: Draft, list = true) {
    for (const item of draft ? [draft] : this.items) {
      this.draftVersions.set(item, this.draftSnapshot(item) + 1);
      for (const listener of this.draftListeners.get(item) ?? []) listener();
    }
    if (list) {
      this.items = [...this.items];
      for (const listener of this.listeners) listener();
    }
  }
  has(draft: Draft) {
    return this.items.includes(draft);
  }
  private finish(draft: Draft, request: AbortController) {
    if (draft.operation?.request === request) {
      draft.diskActivity++;
      draft.operation = undefined;
    }
    if (this.has(draft)) this.changed();
  }
  private hasDuplicate(draft: Draft, path: string) {
    return this.items.some(
      (item) =>
        item !== draft &&
        item.deviceId === draft.deviceId &&
        item.workspaceId === draft.workspaceId &&
        item.path === path,
    );
  }
  capture(deviceId: string, workspaceId: string, path: string): FileChange {
    const matches = (target: FileTarget) =>
      target.deviceId === deviceId &&
      target.workspaceId === workspaceId &&
      isWithin(target.path, path);
    const drafts: CapturedDraft[] = [];
    for (const draft of this.items) {
      if (matches(draft))
        drafts.push({ draft, source: { path: draft.path, version: draft.sourceVersion } });
    }
    return { drafts };
  }
  private sourceCurrent({ draft, source }: CapturedDraft) {
    return this.has(draft) && draft.path === source.path && draft.sourceVersion === source.version;
  }
  savingWithin(deviceId: string, workspaceId: string, path: string) {
    return this.items.some(
      (draft) =>
        draft.deviceId === deviceId &&
        draft.workspaceId === workspaceId &&
        draft.operation?.kind === "saving" &&
        (isWithin(draft.path, path) || isWithin(draft.operation.snapshot.target.path, path)),
    );
  }
  fileFailed(channelId: string, error: KitelineError) {
    const draft = this.items.find((item) => item.readChannel === channelId);
    if (!draft) return;
    draft.readError = apiError(error, "failed");
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
          if (draft.operation?.request === request) draft.readChannel = id;
        },
      );
      if (draft.operation?.request === request) draft.readChannel = undefined;
      return disk;
    } catch (error) {
      throw draft.readError ?? error;
    }
  }
  limits(devices: Device[]) {
    for (const device of devices)
      if (device.editorBytes !== undefined) this.editorLimits.set(device.id, device.editorBytes);
    this.changed();
  }
  limitError(draft: Draft, size: number, previous = draft.bytes): DraftNotice | undefined {
    const limit = this.editorLimits.get(draft.deviceId);
    if (limit === undefined) return "loadingCapacity";
    if (size > limit && size > previous) return "fileCapacity";
  }
  canSave(draft: Draft) {
    const limit = this.editorLimits.get(draft.deviceId);
    return !!draft.state && limit !== undefined && draft.bytes <= limit && !draft.operation;
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
      sourceVersion: 0,
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
  update(draft: Draft, state: EditorState, measured?: { text: string; bytes: number }) {
    if (!this.has(draft)) return;
    const changed = draft.state?.doc !== state.doc;
    const dirty = isDirty(draft),
      canSave = this.canSave(draft),
      overLimit = this.overLimit(draft);
    draft.state = state;
    if (!changed) return;
    const text = measured?.text ?? state.doc.toString();
    draft.bytes = measured?.bytes ?? encodeText(text, draft.format).length;
    dirtyCache.set(draft, {
      doc: state.doc,
      baseText: draft.baseText,
      dirty: text !== draft.baseText,
    });
    this.changed(
      draft,
      dirty !== isDirty(draft) ||
        canSave !== this.canSave(draft) ||
        overLimit !== this.overLimit(draft),
    );
  }
  adopt(draft: Draft, disk: DiskText) {
    const size = encodeText(disk.text, disk.meta as TextFormat).length;
    const error = this.limitError(draft, size);
    if (error) {
      draft.notice = error;
      throw new ApiError("limit_exceeded", "The text exceeds the available editor capacity");
    }
    draft.sourceVersion++;
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
    if (!this.has(draft) || draft.operation) return;
    draft.diskActivity++;
    const request = new AbortController();
    const path = draft.path;
    draft.operation = { kind: "loading", request };
    draft.error = undefined;
    this.changed();
    try {
      const disk = await this.read(draft, { ...draft }, request);
      if (this.has(draft) && draft.operation?.request === request && draft.path === path)
        this.adopt(draft, disk);
    } catch (error) {
      if (this.has(draft) && draft.operation?.request === request && draft.path === path)
        draft.error = error;
    } finally {
      this.finish(draft, request);
    }
  }
  async save(draft: Draft, path = draft.path, revision: string | null = draft.revision ?? null) {
    if (!this.canSave(draft) || !this.has(draft)) return false;
    draft.diskActivity++;
    const text = draft.state!.doc.toString();
    const bytes = encodeText(text, draft.format);
    const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    const request = new AbortController();
    const sourcePath = draft.path;
    const pending: SaveSnapshot = {
      target: { deviceId: draft.deviceId, workspaceId: draft.workspaceId, path },
      raw,
      replacesSource: path === draft.path && revision !== null,
    };
    draft.operation = { kind: "saving", request, snapshot: pending };
    draft.error = undefined;
    this.changed();
    try {
      const saved = await writeText(
        { ...draft, path },
        bytes,
        revision ?? undefined,
        request.signal,
        (path) => {
          pending.target.path = path;
        },
      );
      const savedPath = saved.path;
      emit("kiteline:file-written", {
        deviceId: draft.deviceId,
        workspaceId: draft.workspaceId,
        path: savedPath,
      });
      if (!this.has(draft) || draft.operation?.request !== request) return false;
      if (draft.path !== sourcePath) {
        draft.notice = "savedOldPath";
        return false;
      }
      const duplicate = this.hasDuplicate(draft, savedPath);
      if (!pending.replacesSource || draft.path !== savedPath) draft.sourceVersion++;
      draft.path = savedPath;
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
      if (this.has(draft) && draft.operation?.request === request && draft.path === sourcePath) {
        draft.error = error;
        if (error instanceof ApiError && error.outcome === "unknown") draft.unknownSave = pending;
      }
      return false;
    } finally {
      this.finish(draft, request);
    }
  }
  async check(draft: Draft): Promise<DiskText | undefined> {
    if (draft.operation || !this.has(draft)) return;
    draft.diskActivity++;
    const path = draft.path;
    const unknown = draft.unknownSave;
    const request = new AbortController();
    draft.operation = { kind: "checking", request };
    this.changed();
    try {
      const disk = await this.read(draft, unknown?.target ?? { ...draft }, request);
      if (!this.has(draft) || draft.operation?.request !== request || draft.path !== path) return;
      if (unknown && disk.raw === unknown.raw) {
        this.confirmSave(draft, disk, unknown);
      }
      return disk;
    } catch (error) {
      if (this.has(draft) && draft.operation?.request === request && draft.path === path)
        draft.error = error;
    } finally {
      this.finish(draft, request);
    }
  }
  async observe(draft: Draft, signal: AbortSignal) {
    if (draft.operation || !draft.state || !this.has(draft)) return;
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
    if (this.savingWithin(target.deviceId, target.workspaceId, target.path))
      throw new ApiError("busy", "A file save is still in progress", "failed");
    const change = this.capture(target.deviceId, target.workspaceId, target.path);
    const result = await rpc(target.deviceId, "files.rename", {
      workspaceId: target.workspaceId,
      path: target.path,
      newName,
    });
    void this.rename(target.deviceId, target.workspaceId, result.from, result.to, change);
    return result;
  }
  private confirmSave(draft: Draft, disk: DiskText, snapshot: SaveSnapshot) {
    if (!snapshot.replacesSource || draft.path !== disk.target.path) draft.sourceVersion++;
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
    draft.notice = this.hasDuplicate(draft, draft.path) ? "duplicateDraft" : "diskMatches";
    emit("kiteline:file-written", disk.target);
  }
  private async checkMoved(draft: Draft, previous: Promise<void>) {
    const request = new AbortController();
    draft.operation = { kind: "checking", request };
    draft.readChannel = undefined;
    draft.readError = undefined;
    const source = { deviceId: draft.deviceId, workspaceId: draft.workspaceId, path: draft.path };
    const activity = draft.diskActivity;
    const current = () =>
      this.has(draft) &&
      draft.operation?.request === request &&
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
        if (!draft.state) {
          this.adopt(draft, sourceDisk);
        } else if (sourceDisk.raw === draft.baseRaw) {
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
        if (!draft.state) draft.error = error;
        else draft.notice = undefined;
        if (error instanceof ApiError && error.code === "not_found") draft.missing = true;
      }
    } finally {
      if (current() && this.hasDuplicate(draft, draft.path)) draft.notice = "duplicateDraft";
      this.finish(draft, request);
    }
  }
  async rename(
    deviceId: string,
    workspaceId: string,
    from: string,
    to: string,
    change = this.capture(deviceId, workspaceId, from),
  ) {
    let checking = Promise.resolve();
    for (const owner of change.drafts) {
      const { draft } = owner;
      if (!this.sourceCurrent(owner)) continue;
      draft.diskActivity++;
      draft.path = movedPath(draft.path, from, to);
      draft.sourceVersion++;
      draft.notice = "checkingMoved";
      this.interruptRequest(draft);
      checking = this.checkMoved(draft, checking);
    }
    this.changed();
    await checking;
  }
  private markMissing(owner: CapturedDraft, notice: DraftNotice) {
    const { draft } = owner;
    if (!this.sourceCurrent(owner)) return;
    draft.diskActivity++;
    this.interruptRequest(draft);
    draft.missing = true;
    draft.notice = notice;
  }
  private interruptRequest(draft: Draft) {
    const operation = draft.operation;
    if (operation?.kind === "saving") draft.unknownSave = operation.snapshot;
    operation?.request.abort();
    draft.operation = undefined;
  }
  deleted(
    deviceId: string,
    workspaceId: string,
    path: string,
    notice: DraftNotice = "deletedDraft",
    change = this.capture(deviceId, workspaceId, path),
  ) {
    for (const owner of change.drafts) if (this.has(owner.draft)) this.markMissing(owner, notice);
    this.changed();
  }
  async checkMissing(
    deviceId: string,
    workspaceId: string,
    path: string,
    change = this.capture(deviceId, workspaceId, path),
  ) {
    for (const owner of change.drafts) {
      const { draft } = owner;
      if (!this.sourceCurrent(owner)) continue;
      const activity = draft.diskActivity;
      try {
        await rpc(deviceId, "files.inspect", { workspaceId, path: owner.source.path });
      } catch (error) {
        if (
          this.sourceCurrent(owner) &&
          draft.diskActivity === activity &&
          error instanceof ApiError &&
          error.code === "not_found"
        ) {
          this.markMissing(owner, "missingDraft");
          this.changed();
        }
      }
    }
  }
  close(draft: Draft) {
    draft.operation?.request.abort();
    this.items = this.items.filter((item) => item !== draft);
    if (this.closingId === draft.id) this.closingId = undefined;
    this.changed();
  }
  clear() {
    for (const item of this.items) item.operation?.request.abort();
    this.items = [];
    this.closingId = undefined;
    this.changed();
  }
}
export function useDrafts(store: DraftStore) {
  return useSyncExternalStore(store.subscribe, store.snapshot);
}
export function useDraftVersion(store: DraftStore, draft: Draft) {
  return useSyncExternalStore(
    useCallback((listener) => store.subscribeDraft(draft, listener), [store, draft]),
    useCallback(() => store.draftSnapshot(draft), [store, draft]),
  );
}
export function draftError(draft: Draft) {
  const error = draft.error ?? draft.observationError;
  return error ? errorMessage(error) : undefined;
}
