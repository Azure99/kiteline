import type { CopyItem, FileItemResult, RpcArguments } from "@kiteline/shared/protocol";
import { apiError, ApiError, rpc, rpcReply } from "../lib/api";
import type { WorkspaceTarget } from "../lib/navigation";
import type { FileTarget } from "./content";
import type { DraftStore } from "./drafts";

export function blockedBySave(
  store: DraftStore,
  { deviceId, workspaceId }: WorkspaceTarget,
  kind: "copy" | "move" | "delete",
  items: readonly CopyItem[],
) {
  if (kind === "copy") return false;
  for (const item of items) {
    if (store.savingWithin(deviceId, workspaceId, item.path)) return true;
    if (kind === "move" && item.collision === "replace") {
      if (store.savingWithin(deviceId, workspaceId, item.targetPath)) return true;
    }
  }
  return false;
}

export async function renameFile(
  store: DraftStore,
  { deviceId, workspaceId, path }: FileTarget,
  newName: string,
) {
  if (store.savingWithin(deviceId, workspaceId, path))
    throw new ApiError("busy", "A file save is still in progress", "failed");
  const change = store.capture(deviceId, workspaceId, path);
  const result = await rpc(deviceId, "files.rename", { workspaceId, path, newName });
  void store.rename(result.from, result.to, change);
  return result;
}

export async function operateFiles(
  store: DraftStore,
  { deviceId, workspaceId }: WorkspaceTarget,
  kind: "copy" | "move" | "delete",
  items: readonly CopyItem[],
  request: { id: string; signal: AbortSignal },
): Promise<{ items: FileItemResult[]; error?: unknown }> {
  const submitted = items.map((item) => ({ ...item }));
  const changes = new Map(
    kind === "copy"
      ? []
      : submitted.map((item) => [item.path, store.capture(deviceId, workspaceId, item.path)]),
  );
  const params = { workspaceId, items: submitted };
  let operation: RpcArguments<"files.copy" | "files.move" | "files.delete">;
  if (kind === "delete") {
    operation = [
      "files.delete",
      { workspaceId, paths: submitted.map((item) => item.path) },
      request.signal,
    ];
  } else if (kind === "copy") {
    operation = ["files.copy", params, request.signal];
  } else {
    operation = ["files.move", params, request.signal];
  }
  let result: FileItemResult[];
  let error: unknown;
  try {
    if (blockedBySave(store, { deviceId, workspaceId }, kind, submitted))
      throw new ApiError("busy", "A file save is still in progress", "failed");
    const reply = await rpcReply(deviceId, request.id, operation);
    result =
      reply.result?.items ??
      submitted.map((item) => ({
        path: item.path,
        targetPath: item.targetPath,
        outcome: reply.outcome,
        ...(reply.outcome !== "succeeded" ? { error: reply.error } : {}),
      }));
    if (reply.outcome !== "succeeded") error = apiError(reply.error, reply.outcome, reply.result);
  } catch (reason) {
    result = submitted.map((item) => ({
      path: item.path,
      targetPath: item.targetPath,
      outcome: reason instanceof ApiError && reason.outcome !== "unknown" ? "failed" : "unknown",
    }));
    error = reason;
  }
  for (const item of result) {
    const change = changes.get(item.path);
    if (!change) continue;
    if (item.outcome === "succeeded") {
      if (kind === "move") void store.rename(item.path, item.targetPath!, change);
      else store.deleted(change);
    } else if (item.outcome === "partial" || item.outcome === "unknown")
      void store.checkMissing(deviceId, workspaceId, change);
  }
  return { items: result, error };
}
