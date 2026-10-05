import { newId } from "../lib/id";
import { useSyncExternalStore } from "react";
import type {
  FileProgress,
  GitWriteArguments,
  GitWriteMethod,
  RpcArguments,
  RpcResult,
} from "@kiteline/shared/protocol";
import { apiError, ApiError, cancelRequest, rpcReply } from "../lib/api";

export interface GitTarget {
  deviceId: string;
  workspaceId: string;
  repoId: string;
}
export interface GitActivity {
  message: string;
  messageVersion: number;
  request?: {
    id: string;
    method: GitWriteMethod;
    phase: FileProgress["phase"];
    cancelling: boolean;
  };
  error?: ApiError | Error;
  completed?: GitWriteMethod;
  result?: unknown;
  revision: number;
}
const key = (target: GitTarget) => `${target.deviceId}:${target.workspaceId}:${target.repoId}`;

export class GitActions {
  private entries = new Map<string, GitActivity>();
  private listeners = new Set<() => void>();
  private messageListeners = new Map<string, Set<() => void>>();
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
  subscribeMessage(target: GitTarget, listener: () => void) {
    const id = key(target);
    let listeners = this.messageListeners.get(id);
    if (!listeners) this.messageListeners.set(id, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.messageListeners.delete(id);
    };
  }
  private notifyMessage(target: GitTarget) {
    for (const listener of this.messageListeners.get(key(target)) ?? []) listener();
  }
  get(target: GitTarget) {
    let value = this.entries.get(key(target));
    if (!value)
      this.entries.set(key(target), (value = { message: "", messageVersion: 0, revision: 0 }));
    return value;
  }
  clear() {
    this.entries.clear();
    for (const listeners of this.messageListeners.values())
      for (const listener of listeners) listener();
    this.notify();
  }
  message(target: GitTarget, message: string) {
    const value = this.get(target);
    value.message = message;
    value.messageVersion++;
    this.notifyMessage(target);
  }
  async run<A extends GitWriteArguments>(
    target: GitTarget,
    ...[method, params]: A
  ): Promise<RpcResult<A[0]> | undefined> {
    const value = this.get(target);
    if (value.request) return;
    const request = {
      id: newId(),
      method,
      phase: "queued" as FileProgress["phase"],
      cancelling: false,
    };
    const messageVersion = value.messageVersion;
    value.request = request;
    value.error = undefined;
    value.completed = undefined;
    value.result = undefined;
    this.notify();
    const progress = (event: WindowEventMap["kiteline:event"]) => {
      const message = event.detail;
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
      const reply = await rpcReply(target.deviceId, request.id, [
        method,
        { ...params, workspaceId: target.workspaceId, repoId: target.repoId },
      ] as RpcArguments<GitWriteMethod>);
      if (reply.outcome !== "succeeded") throw apiError(reply.error, reply.outcome, reply.result);
      value.error = undefined;
      value.result = reply.result;
      if (method === "git.commit" && messageVersion === value.messageVersion) {
        value.message = "";
        value.messageVersion++;
        this.notifyMessage(target);
      }
      value.completed = method;
      return reply.result as RpcResult<A[0]>;
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
      await cancelRequest(target.deviceId, request.id);
    } catch (error) {
      if (value.request !== request) return;
      value.error = error instanceof Error ? error : new Error(String(error));
      request.cancelling = false;
      this.notify();
    }
  }
}
export function useGitActivity(store: GitActions, target: GitTarget) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  return store.get(target);
}
export function useGitMessage(store: GitActions, target: GitTarget) {
  useSyncExternalStore(
    (listener) => store.subscribeMessage(target, listener),
    () => store.get(target).messageVersion,
  );
  return store.get(target).message;
}
