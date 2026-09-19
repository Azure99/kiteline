import type { FileListing, RpcMethod, RpcResult } from "@kiteline/shared/protocol";
import { rpc, rpcReply } from "../src/lib/api";
import { GitActions, type GitTarget } from "../src/git/actions";

// Compiled by typecheck, never executed. Each rejected call reproduces a contract mistake.
export async function checkRpcContracts(deviceId: string, target: GitTarget, method: RpcMethod) {
  const result = await rpc(deviceId, "sessions.list", {});
  result.sessions.map((session) => session.id);
  // @ts-expect-error sessions.list cannot produce a file listing
  const files: FileListing = result;
  void files;
  // @ts-expect-error remote session end must include its workspace
  await rpc(deviceId, "sessions.end", { sessionId: "s" });
  // @ts-expect-error method spelling is checked
  await rpc(deviceId, "git.stats", { workspaceId: "w", repoId: "r" });
  const invalidCommit = {
    workspaceId: "w",
    repoId: "r",
    message: "m",
    expectedIndexToken: "t",
  };
  // @ts-expect-error commit requires indexToken, not expectedIndexToken
  await rpc(deviceId, "git.commit", invalidCommit);
  // @ts-expect-error a dynamic method cannot be paired with unrelated parameters
  await rpc(deviceId, method, { workspaceId: "w", sessionId: "s" });
  // @ts-expect-error commit-side diff requires a commit identity
  await rpc(deviceId, "git.diff", { workspaceId: "w", repoId: "r", path: "a", side: "commit" });
  const actions = new GitActions();
  await actions.run(target, "git.pull", { expectedHead: { symbolicRef: null, oid: null } });
  // @ts-expect-error the independent Git write entry point also requires HEAD
  await actions.run(target, "git.pull", {});
  // @ts-expect-error result cannot be chosen independently of a method
  const wrong: RpcResult<"files.rename"> = result;
  void wrong;
  const write = await rpcReply(deviceId, "request-id", [
    "files.move",
    { workspaceId: "w", items: [{ path: "a", targetPath: "b", collision: "error" }] },
  ]);
  write.result?.items.map((item) => item.outcome);
  // @ts-expect-error file delete uses paths, not copy items
  await rpcReply(deviceId, "request-id", ["files.delete", { workspaceId: "w", items: [] }]);
  const created = await rpcReply(deviceId, "request-id", ["sessions.create", { workspaceId: "w" }]);
  if (created.outcome === "succeeded") created.result.id.toUpperCase();
  else {
    // @ts-expect-error an unknown creation result is not a complete Session
    void created.result.id;
  }
}
