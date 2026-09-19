import { useSyncExternalStore } from "react";
import { Compartment, type EditorState } from "@codemirror/state";
import type { KitelineError, Device, TextFormat } from "@kiteline/shared/protocol";
import { encodeText } from "@kiteline/shared/text";
import { ApiError, errorMessage, rpc } from "../lib/api";
import { navigate, workspacePath } from "../lib/navigation";
import { readText, writeText, type DiskText, type FileTarget } from "./content";
import { textState } from "./editor-state";
import { isWithin, movedPath, parentPath } from "./use-browser";

export interface Draft extends FileTarget {
  id: string;
  deviceName: string;
  workspaceName: string;
  state?: EditorState;
  language: Compartment;
  format: TextFormat;
  bytes: number;
  baseText: string;
  baseRaw: string;
  revision?: string;
  resolvedPath?: string;
  mode?: number;
  scrollTop: number;
  scrollLeft: number;
  location?: { line: number; range?: [number, number] };
  busy?: "loading" | "saving" | "checking";
  error?: unknown;
  observationError?: unknown;
  notice?: string;
  unknownSave?: { target: FileTarget; raw: string; text: string };
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
  limitError(draft: Draft, size: number, previous = draft.bytes) {
    const limit = this.editorLimits.get(draft.deviceId);
    if (limit === undefined || this.totalLimit === undefined) return "正在获取编辑容量";
    if (size > limit && size > previous) return "内容超过单文件编辑容量";
    const total = this.items.reduce((sum, item) => sum + item.bytes, 0) - draft.bytes + size;
    if (total > this.totalLimit && size > previous)
      return "已打开文本超过页面容量，请先关闭其他文件";
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
  open(target: FileTarget & { deviceName: string; workspaceName: string }) {
    const existing = this.find(target);
    if (existing) return existing;
    const draft: Draft = {
      ...target,
      id: crypto.randomUUID(),
      language: new Compartment(),
      format: { bom: false, lineEnding: "lf" },
      bytes: 0,
      baseText: "",
      baseRaw: "",
      scrollTop: 0,
      scrollLeft: 0,
      diskActivity: 0,
    };
    this.items.push(draft);
    void this.load(draft);
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
    if (error) throw new Error(error);
    draft.path = disk.target.path;
    draft.format = disk.meta as TextFormat;
    draft.state = textState(disk.text, draft.language);
    draft.bytes = size;
    draft.baseText = disk.text;
    draft.baseRaw = disk.raw;
    draft.revision = disk.meta.revision;
    draft.resolvedPath = disk.meta.resolvedPath;
    draft.mode = disk.meta.mode;
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
      draft.diskActivity++;
      if (draft.request === request) {
        draft.busy = undefined;
        draft.request = undefined;
      }
      if (this.has(draft)) this.changed();
    }
  }
  async save(draft: Draft, path = draft.path, revision: string | null = draft.revision ?? null) {
    if (!this.canSave(draft) || !this.has(draft)) return false;
    draft.diskActivity++;
    const originalPath = draft.path;
    const text = draft.state!.doc.toString();
    const bytes = encodeText(text, draft.format);
    const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    const request = new AbortController();
    draft.request = request;
    draft.busy = "saving";
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
      if (draft.path !== originalPath) {
        draft.notice = "原路径保存已完成，请核对移动后的文件";
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
      draft.notice = duplicate ? "目标还有一份打开的草稿，两份内容均已保留" : undefined;
      return true;
    } catch (error) {
      if (this.has(draft) && draft.request === request && draft.path === originalPath) {
        draft.error = error;
        if (error instanceof ApiError && error.outcome === "unknown")
          draft.unknownSave = {
            target: { deviceId: draft.deviceId, workspaceId: draft.workspaceId, path },
            raw,
            text,
          };
      }
      return false;
    } finally {
      draft.diskActivity++;
      if (draft.request === request) {
        draft.busy = undefined;
        draft.request = undefined;
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
        draft.path = unknown.target.path;
        draft.baseRaw = disk.raw;
        draft.baseText = disk.text;
        draft.revision = disk.meta.revision;
        draft.unknownSave = undefined;
        draft.missing = false;
        draft.error = undefined;
        draft.notice = "磁盘内容与上次发送内容一致";
        window.dispatchEvent(new CustomEvent("kiteline:file-written", { detail: unknown.target }));
        const query = new URLSearchParams(location.search);
        if (query.get("draft") === draft.id) {
          query.set("file", draft.path);
          query.set("folder", parentPath(draft.path));
          navigate(`${location.pathname}?${query}`, true);
        }
      }
      return disk;
    } catch (error) {
      if (this.has(draft) && draft.request === request && draft.path === path) draft.error = error;
    } finally {
      draft.diskActivity++;
      if (draft.request === request) {
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
          (item.unknownSave &&
            movedPath(item.unknownSave.target.path, from, to) !== item.unknownSave.target.path)),
    );
    for (const draft of moved) {
      draft.request?.abort();
      draft.request = undefined;
      draft.busy = undefined;
      draft.path = movedPath(draft.path, from, to);
      if (draft.unknownSave)
        draft.unknownSave.target.path = movedPath(draft.unknownSave.target.path, from, to);
      draft.notice = "路径已更新，正在核对磁盘版本";
    }
    this.changed();
    for (const draft of moved) {
      const disk = await this.check(draft);
      if (!disk || !this.has(draft)) continue;
      if (disk.raw === draft.baseRaw) {
        draft.revision = disk.meta.revision;
        draft.resolvedPath = disk.meta.resolvedPath;
        draft.notice = undefined;
      } else draft.notice = "磁盘内容已变化，草稿已保留";
      if (
        this.items.some(
          (item) =>
            item !== draft &&
            item.deviceId === deviceId &&
            item.workspaceId === workspaceId &&
            item.path === draft.path,
        )
      )
        draft.notice = "目标还有一份打开的草稿，两份内容均已保留";
      this.changed();
    }
  }
  requestClose(draft: Draft) {
    if (isDirty(draft)) {
      this.closing = draft.id;
      this.changed();
    } else this.close(draft);
  }
  private markMissing(draft: Draft, notice: string) {
    draft.diskActivity++;
    draft.request?.abort();
    draft.request = undefined;
    draft.busy = undefined;
    draft.missing = true;
    draft.notice = notice;
  }
  deleted(
    deviceId: string,
    workspaceId: string,
    path: string,
    notice = "磁盘文件已删除，当前内容可另存",
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
          this.markMissing(draft, "原路径已不存在，当前内容可另存");
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
    const query = new URLSearchParams(location.search);
    if (query.get("draft") === draft.id) {
      query.delete("draft");
      query.delete("file");
      navigate(location.pathname + (query.size ? `?${query}` : ""), true);
    }
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
export function showDraft(draft: Draft, replace = false) {
  const query = new URLSearchParams({
    file: draft.path,
    draft: draft.id,
    folder: parentPath(draft.path),
  });
  navigate(`${workspacePath(draft.deviceId, draft.workspaceId, "files")}?${query}`, replace);
}
export function draftError(draft: Draft) {
  const error = draft.error ?? draft.observationError;
  return error ? errorMessage(error) : undefined;
}
