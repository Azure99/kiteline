import { newId } from "../lib/id";
import { useSyncExternalStore } from "react";
import type {
  FileProgress,
  GitWriteArguments,
  GitWriteMethod,
  Outcome,
  RpcArguments,
  RpcResult,
} from "@kiteline/shared/protocol";
import { apiError, ApiError, cancelRequest, rpcReply } from "../lib/api";

export interface GitTarget {
  deviceId: string;
  workspaceId: string;
  repoId: string;
}
export type GitCompletion =
  | {
      method: GitWriteMethod;
      outcome: "succeeded";
      result: RpcResult<GitWriteMethod>;
      error?: never;
    }
  | {
      method: GitWriteMethod;
      outcome: Exclude<Outcome, "succeeded"> | undefined;
      error: Error;
      result?: never;
    };

interface GitActivity {
  message: string;
  messageVersion: number;
  request?: {
    id: string;
    method: GitWriteMethod;
    phase: FileProgress["phase"];
    cancelling: boolean;
    cancelError?: Error;
  };
  completion?: GitCompletion;
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
  async run(
    target: GitTarget,
    ...[method, params]: GitWriteArguments
  ): Promise<GitCompletion | undefined> {
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
    value.completion = undefined;
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
    let completion: GitCompletion;
    try {
      const reply = await rpcReply(target.deviceId, request.id, [
        method,
        { ...params, workspaceId: target.workspaceId, repoId: target.repoId },
      ] as RpcArguments<GitWriteMethod>);
      if (reply.outcome !== "succeeded") throw apiError(reply.error, reply.outcome, reply.result);
      completion = { method, outcome: "succeeded", result: reply.result };
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      completion = {
        method,
        outcome: error instanceof ApiError ? error.outcome : undefined,
        error,
      } as GitCompletion;
    } finally {
      window.removeEventListener("kiteline:event", progress);
    }
    value.request = undefined;
    value.completion = completion;
    value.revision++;
    if (
      completion.outcome === "succeeded" &&
      method === "git.commit" &&
      messageVersion === value.messageVersion
    ) {
      value.message = "";
      value.messageVersion++;
      this.notifyMessage(target);
    }
    this.notify();
    return completion;
  }
  dismiss(target: GitTarget) {
    const value = this.get(target);
    if (value.request) return;
    value.completion = undefined;
    this.notify();
  }
  async cancel(target: GitTarget) {
    const value = this.get(target);
    const request = value.request;
    if (!request || request.cancelling) return;
    request.cancelling = true;
    request.cancelError = undefined;
    this.notify();
    try {
      await cancelRequest(target.deviceId, request.id);
    } catch (error) {
      if (value.request !== request) return;
      request.cancelError = error instanceof Error ? error : new Error(String(error));
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
