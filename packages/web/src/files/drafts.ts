import { newId } from "../lib/id";
import { useCallback, useSyncExternalStore } from "react";
import { Compartment, type EditorState } from "@codemirror/state";
import type { AgentEnvironment, Device, TextFormat } from "@kiteline/shared/protocol";
import { encodeText } from "@kiteline/shared/protocol/text";
import { ApiError, rpc } from "../lib/api";
import { emit } from "../lib/events";
import { readText, writeText, type DiskText, type FileTarget } from "./content";
import { syncTextTransactions, textState } from "./editor-state";
import { isWithin, movedPath } from "./paths";

type DraftNotice =
  | "loadingCapacity"
  | "fileCapacity"
  | "duplicateDraft"
  | "checkingMoved"
  | "deletedDraft"
  | "missingDraft";

interface SaveSnapshot {
  target: FileTarget;
  raw: string;
  replacesSource: boolean;
}

type SaveTarget =
  | { kind: "create"; path: string }
  | { kind: "overwrite"; path: string; revision: string };

type SaveResult = { kind: "ignored" | "saved" } | { kind: "conflict" | "failed"; error: unknown };

type CheckResult =
  | { kind: "ignored" }
  | { kind: "read"; disk: DiskText; unconfirmedSave: boolean }
  | { kind: "confirmed-save"; disk: DiskText }
  | { kind: "failed"; error: unknown };

// Draft and disk ownership: docs/design/files.md.
export interface Draft extends FileTarget {
  id: string;
  untitled?: { folder: string; number: number };
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
  view: {
    scrollSnapshot?: { line: number; column: number; offsetX: number; offsetY: number };
    markdownPreview?: boolean;
    markdownPosition?: { line: number; offset: number };
  };
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
  private devices = new Map<string, { editorBytes?: number; os?: AgentEnvironment["os"] }>();
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
      if (draft.path && matches(draft))
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
  observeDevices(devices: Device[]) {
    for (const device of devices) {
      const facts = this.devices.get(device.id) ?? {};
      if (device.editorBytes !== undefined) facts.editorBytes = device.editorBytes;
      if (device.environment?.os !== undefined) facts.os = device.environment.os;
      this.devices.set(device.id, facts);
    }
    this.changed();
  }
  private capacityNotice(draft: Draft, size: number): DraftNotice | undefined {
    const limit = this.devices.get(draft.deviceId)?.editorBytes;
    if (limit === undefined) return "loadingCapacity";
    if (size > limit && size > draft.bytes) return "fileCapacity";
  }
  acceptEdit(draft: Draft, size: number) {
    const notice = this.capacityNotice(draft, size);
    if (!notice) return true;
    draft.notice = notice;
    this.changed();
    return false;
  }
  canSave(draft: Draft) {
    const limit = this.devices.get(draft.deviceId)?.editorBytes;
    return !!draft.state && limit !== undefined && draft.bytes <= limit && !draft.operation;
  }
  overLimit(draft: Draft) {
    const limit = this.devices.get(draft.deviceId)?.editorBytes;
    return limit !== undefined && draft.bytes > limit;
  }
  find(target: FileTarget, id?: string) {
    return this.items.find(
      (item) =>
        item.deviceId === target.deviceId &&
        item.workspaceId === target.workspaceId &&
        (id ? item.id === id : !!target.path && item.path === target.path),
    );
  }
  open(
    {
      folder = ".",
      ...target
    }: FileTarget & {
      deviceName: string;
      workspaceName: string;
      folder?: string;
    },
    disk?: DiskText,
  ) {
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
      diskActivity: 0,
      sourceVersion: 0,
      view: {},
    };
    this.items.push(draft);
    if (disk) {
      try {
        this.replaceSource(draft, disk);
      } catch (error) {
        draft.error = error;
        this.changed();
      }
    } else if (!target.path) {
      draft.untitled = {
        folder,
        number: Math.max(0, ...this.items.map((item) => item.untitled?.number ?? 0)) + 1,
      };
      draft.state = textState("", draft.language, draft.phrases);
      this.changed();
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
  private checkedDiskSize(draft: Draft, disk: DiskText) {
    const size = encodeText(disk.text, disk.meta as TextFormat).length;
    const notice = this.capacityNotice(draft, size);
    if (notice) {
      draft.notice = notice;
      throw new ApiError("limit_exceeded", "The text exceeds the available editor capacity");
    }
    return size;
  }
  private applyDiskBaseline(draft: Draft, disk: DiskText, size: number) {
    draft.path = disk.target.path;
    draft.format = disk.meta as TextFormat;
    draft.bytes = size;
    draft.baseText = disk.text;
    draft.baseRaw = disk.raw;
    draft.revision = disk.meta.revision;
    draft.resolvedPath = disk.meta.resolvedPath;
  }
  replaceSource(draft: Draft, disk: DiskText) {
    const size = this.checkedDiskSize(draft, disk);
    draft.sourceVersion++;
    draft.state = textState(
      disk.text,
      draft.language,
      draft.phrases,
      draft.state ? draft.language.get(draft.state) : undefined,
    );
    this.applyDiskBaseline(draft, disk, size);
    draft.unknownSave = undefined;
    draft.missing = false;
    draft.error = undefined;
    draft.observationError = undefined;
    draft.notice = undefined;
    draft.diskChanged = false;
    draft.view.scrollSnapshot = undefined;
    draft.view.markdownPosition = undefined;
    this.changed();
  }
  private applyObserved(draft: Draft, disk: DiskText) {
    const size = this.checkedDiskSize(draft, disk);
    if (draft.state!.doc.toString() !== disk.text)
      draft.state = syncTextTransactions(draft.state!, disk.text)[1].state;
    this.applyDiskBaseline(draft, disk, size);
    draft.missing = false;
    draft.observationError = undefined;
    draft.notice = undefined;
    draft.diskChanged = false;
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
      const disk = await readText({ ...draft }, request.signal);
      if (this.has(draft) && draft.operation?.request === request && draft.path === path)
        this.replaceSource(draft, disk);
    } catch (error) {
      if (this.has(draft) && draft.operation?.request === request && draft.path === path)
        draft.error = error;
    } finally {
      this.finish(draft, request);
    }
  }
  async save(draft: Draft, target?: SaveTarget): Promise<SaveResult> {
    if (!this.canSave(draft) || !this.has(draft)) return { kind: "ignored" };
    target ??=
      draft.path && draft.revision !== undefined
        ? { kind: "overwrite", path: draft.path, revision: draft.revision }
        : { kind: "create", path: draft.path };
    const { path } = target;
    const text = draft.state!.doc.toString();
    const format =
      !draft.path && this.devices.get(draft.deviceId)?.os === "windows" && /\.ps1$/i.test(path)
        ? { ...draft.format, bom: true }
        : draft.format;
    const bytes = encodeText(text, format);
    const capacity = this.capacityNotice(draft, bytes.length);
    if (capacity) {
      draft.notice = capacity;
      const error = new ApiError(
        "limit_exceeded",
        "The text exceeds the available editor capacity",
      );
      draft.error = error;
      this.changed();
      return { kind: "failed", error };
    }
    draft.diskActivity++;
    const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    const request = new AbortController();
    const pending: SaveSnapshot = {
      target: { deviceId: draft.deviceId, workspaceId: draft.workspaceId, path },
      raw,
      replacesSource: path === draft.path && target.kind === "overwrite",
    };
    draft.operation = { kind: "saving", request, snapshot: pending };
    draft.error = undefined;
    this.changed();
    try {
      const saved = await writeText(
        { ...draft, path },
        bytes,
        target.kind === "overwrite" ? target.revision : undefined,
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
      if (!this.has(draft) || draft.operation?.request !== request) return { kind: "ignored" };
      this.updateSavedBaseline(draft, {
        path: savedPath,
        text,
        raw,
        format,
        revision: saved.revision,
        replacesSource: pending.replacesSource,
      });
      return { kind: "saved" };
    } catch (error) {
      if (!this.has(draft) || draft.operation?.request !== request) return { kind: "ignored" };
      draft.error = error;
      if (error instanceof ApiError && error.outcome === "unknown") draft.unknownSave = pending;
      return {
        kind: error instanceof ApiError && error.code === "conflict" ? "conflict" : "failed",
        error,
      };
    } finally {
      this.finish(draft, request);
    }
  }
  async check(draft: Draft): Promise<CheckResult> {
    if (draft.operation || !this.has(draft)) return { kind: "ignored" };
    draft.diskActivity++;
    const path = draft.path;
    const unknown = draft.unknownSave;
    const request = new AbortController();
    draft.operation = { kind: "checking", request };
    this.changed();
    try {
      const disk = await readText(unknown?.target ?? { ...draft }, request.signal);
      if (!this.has(draft) || draft.operation?.request !== request || draft.path !== path)
        return { kind: "ignored" };
      if (unknown && disk.raw === unknown.raw) {
        this.updateSavedBaseline(draft, {
          path: disk.target.path,
          text: disk.text,
          raw: disk.raw,
          format: disk.meta as TextFormat,
          revision: disk.meta.revision,
          replacesSource: unknown.replacesSource,
        });
        draft.resolvedPath = disk.meta.resolvedPath;
        draft.error = undefined;
        emit("kiteline:file-written", disk.target);
        return { kind: "confirmed-save", disk };
      }
      return { kind: "read", disk, unconfirmedSave: unknown !== undefined };
    } catch (error) {
      if (!this.has(draft) || draft.operation?.request !== request || draft.path !== path)
        return { kind: "ignored" };
      draft.error = error;
      return { kind: "failed", error };
    } finally {
      this.finish(draft, request);
    }
  }
  async observe(draft: Draft, signal: AbortSignal) {
    if (!draft.path || draft.operation || !draft.state || !this.has(draft)) return;
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
      if (disk.meta.revision !== draft.revision && !isDirty(draft)) {
        this.applyObserved(draft, disk);
        return;
      }
      draft.diskChanged = disk.meta.revision !== draft.revision;
      draft.observationError = undefined;
      draft.missing = false;
      if (draft.notice === "deletedDraft" || draft.notice === "missingDraft")
        draft.notice = undefined;
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
  private updateSavedBaseline(
    draft: Draft,
    saved: {
      path: string;
      text: string;
      raw: string;
      format: TextFormat;
      revision: string | undefined;
      replacesSource: boolean;
    },
  ) {
    if (!saved.replacesSource || draft.path !== saved.path) draft.sourceVersion++;
    if (draft.path !== saved.path) draft.resolvedPath = undefined;
    draft.path = saved.path;
    draft.format = saved.format;
    draft.bytes = encodeText(draft.state!.doc.toString(), saved.format).length;
    draft.baseText = saved.text;
    draft.baseRaw = saved.raw;
    draft.revision = saved.revision;
    draft.unknownSave = undefined;
    draft.missing = false;
    draft.diskChanged = false;
    draft.observationError = undefined;
    draft.notice = this.hasDuplicate(draft, draft.path) ? "duplicateDraft" : undefined;
  }
  private async checkMoved(draft: Draft, previous: Promise<void>) {
    const request = new AbortController();
    draft.operation = { kind: "checking", request };
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
          this.replaceSource(draft, sourceDisk);
        } else if (sourceDisk.raw === draft.baseRaw) {
          draft.revision = sourceDisk.meta.revision;
          draft.resolvedPath = sourceDisk.meta.resolvedPath;
          draft.diskChanged = false;
          draft.notice = undefined;
        } else {
          draft.diskChanged = true;
          draft.notice = undefined;
        }
      } catch (error) {
        if (!current()) return;
        if (draft.state) draft.observationError = error;
        else draft.error = error;
        if (draft.state || draft.notice === "checkingMoved") draft.notice = undefined;
        if (error instanceof ApiError && error.code === "not_found") draft.missing = true;
      }
    } finally {
      if (current() && this.hasDuplicate(draft, draft.path)) draft.notice = "duplicateDraft";
      this.finish(draft, request);
    }
  }
  async rename(from: string, to: string, change: FileChange) {
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
  deleted(change: FileChange) {
    for (const owner of change.drafts)
      if (this.has(owner.draft)) this.markMissing(owner, "deletedDraft");
    this.changed();
  }
  async checkMissing(deviceId: string, workspaceId: string, change: FileChange) {
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
export function draftProblem(draft: Draft) {
  return draft.error ?? draft.observationError;
}
