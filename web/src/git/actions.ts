import { useSyncExternalStore } from "react";
import type {
  FileProgress,
  GitWriteArguments,
  RpcReply,
  RpcResult,
} from "@kiteline/shared/protocol";
import { api, ApiError, errorMessage, post } from "../lib/api";

export interface GitTarget {
  deviceId: string;
  workspaceId: string;
  repoId: string;
}
export interface GitActivity {
  message: string;
  messageVersion: number;
  request?: { id: string; label: string; phase: FileProgress["phase"]; cancelling: boolean };
  error?: ApiError | Error;
  notice?: string;
  result?: unknown;
  revision: number;
}
const key = (target: GitTarget) => `${target.deviceId}:${target.workspaceId}:${target.repoId}`;

export class GitActions {
  private entries = new Map<string, GitActivity>();
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  private notify() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
  get(target: GitTarget) {
    let value = this.entries.get(key(target));
    if (!value)
      this.entries.set(key(target), (value = { message: "", messageVersion: 0, revision: 0 }));
    return value;
  }
  clear() {
    this.entries.clear();
    this.notify();
  }
  message(target: GitTarget, message: string) {
    const value = this.get(target);
    value.message = message;
    value.messageVersion++;
    this.notify();
  }
  async run<A extends GitWriteArguments>(
    target: GitTarget,
    ...[method, params, label]: A
  ): Promise<RpcResult<A[0]> | undefined> {
    const value = this.get(target);
    if (value.request) return;
    const request = {
      id: crypto.randomUUID(),
      label,
      phase: "queued" as FileProgress["phase"],
      cancelling: false,
    };
    const messageVersion = value.messageVersion;
    value.request = request;
    value.error = undefined;
    value.notice = undefined;
    value.result = undefined;
    this.notify();
    const progress = (event: Event) => {
      const message = (
        event as CustomEvent<FileProgress & { type: string; id: string; deviceId: string }>
      ).detail;
      if (
        message.type === "request.progress" &&
        message.id === request.id &&
        message.deviceId === target.deviceId
      ) {
        request.phase = message.phase;
        this.notify();
      }
    };
    window.addEventListener("kiteline:event", progress);
    try {
      const reply = await post<RpcReply<A[0]>>(`/api/devices/${target.deviceId}/rpc`, {
        id: request.id,
        method,
        params: { ...params, workspaceId: target.workspaceId, repoId: target.repoId },
      });
      if (reply.outcome !== "succeeded")
        throw new ApiError(
          reply.error.code,
          reply.error.message,
          reply.outcome,
          reply.error.details,
          reply.result,
        );
      value.error = undefined;
      value.result = reply.result;
      if (method === "git.commit" && messageVersion === value.messageVersion) value.message = "";
      value.notice = `${label}完成`;
      return reply.result;
    } catch (error) {
      value.error = error instanceof Error ? error : new Error(String(error));
    } finally {
      window.removeEventListener("kiteline:event", progress);
      value.request = undefined;
      value.revision++;
      this.notify();
    }
  }
  async cancel(target: GitTarget) {
    const value = this.get(target),
      request = value.request;
    if (!request || request.cancelling) return;
    request.cancelling = true;
    this.notify();
    try {
      await api(`/api/devices/${target.deviceId}/requests/${request.id}`, { method: "DELETE" });
    } catch (error) {
      if (value.request !== request) return;
      value.error = new Error(errorMessage(error));
      request.cancelling = false;
      this.notify();
    }
  }
}
export function useGitActivity(store: GitActions, target: GitTarget) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  return store.get(target);
}
