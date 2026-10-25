import type { RpcArguments, RpcResult } from "@kiteline/shared/protocol";
import { apiError, cancelRequest, rpc, rpcReply } from "./api";
import { newId } from "./id";

type CursorArguments = RpcArguments<"directories.list" | "files.list" | "repos.discover">;

export async function releaseCursor(deviceId: string, kind: "directory" | "repo", id?: string) {
  if (id) await rpc(deviceId, "cursors.release", { kind, id }).catch(() => {});
}

export async function cursorRpc<A extends CursorArguments>(
  deviceId: string,
  ...args: A
): Promise<RpcResult<A[0]>> {
  const signal = args[2];
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const id = newId();
  const cancel = () => {
    void cancelRequest(deviceId, id).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    // Keep the response alive so an abandoned first page can return its cursor.
    args[2] = undefined;
    const reply = await rpcReply(deviceId, id, args);
    if (reply.outcome !== "succeeded") throw apiError(reply.error, reply.outcome, reply.result);
    if (signal?.aborted) {
      const result = reply.result;
      await releaseCursor(
        deviceId,
        args[0] === "repos.discover" ? "repo" : "directory",
        "entries" in result ? result.entries.nextCursor : result.scanCursor,
      );
      throw new DOMException("The operation was aborted", "AbortError");
    }
    return reply.result;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
