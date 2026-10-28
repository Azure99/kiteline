import type { FileListing, Outcome, RpcMethod, RpcResult } from "@kiteline/shared/protocol";
import { ApiError, apiError, fileChannel, openChannel, rpc, rpcReply } from "../src/lib/api";
import { GitActions, type GitTarget } from "../src/git/actions";

export async function checkChannelContracts(deviceId: string) {
  const target = { deviceId, workspaceId: "w", path: "f" };
  const web = await openChannel(deviceId, "terminal.attach", { workspaceId: "w", sessionId: "s" });
  web.meta.terminalInputBytes.toFixed();
  // @ts-expect-error terminal metadata is not file metadata
  web.meta.size.toFixed();
  const tty = await openChannel(deviceId, "terminal.attach", {
    workspaceId: "w",
    sessionId: "s",
    mode: "tty",
    cols: 80,
    rows: 24,
    term: "xterm-256color",
  });
  tty.meta.terminalInputBytes.toFixed();
  const read = await fileChannel(target, "file.read", { purpose: "text" });
  read.meta.size.toFixed();
  // @ts-expect-error file metadata is not terminal metadata
  read.meta.terminalInputBytes.toFixed();
  await fileChannel(target, "file.write", {
    purpose: "save",
    size: 0,
    createOnly: false,
    expectedRevision: "revision",
  });
  const upload = await openChannel(deviceId, "file.write", {
    workspaceId: "w",
    path: "f",
    purpose: "upload",
    size: 0,
    createOnly: false,
    expectedTargetVersion: "version",
  });
  upload.meta.size.toFixed();
  // @ts-expect-error terminal attach needs a session identity
  await openChannel(deviceId, "terminal.attach", { workspaceId: "w" });
  // @ts-expect-error tty attach requires dimensions and TERM
  await openChannel(deviceId, "terminal.attach", { workspaceId: "w", sessionId: "s", mode: "tty" });
  // @ts-expect-error file reads cannot use a write purpose
  await openChannel(deviceId, "file.read", { workspaceId: "w", path: "f", purpose: "upload" });
  // @ts-expect-error file.read cannot use a save purpose through fileChannel either
  await fileChannel(target, "file.read", { purpose: "save" });
  await fileChannel(target, "file.write", {
    purpose: "save",
    size: 0,
    createOnly: true,
    // @ts-expect-error text saves use expectedRevision, not the upload target version
    expectedTargetVersion: "version",
  });
  // @ts-expect-error proxy channels are created internally by the server
  await openChannel(deviceId, "http.proxy", { port: 3000 });
  // @ts-expect-error download uses its dedicated GET endpoint
  await openChannel(deviceId, "file.read", { workspaceId: "w", path: "f", purpose: "download" });
  // @ts-expect-error fileChannel also reserves through the public POST endpoint
  await fileChannel(target, "file.read", { purpose: "download" });

  const error = { code: "io_error", message: "The response was lost" };
  const outcome: Outcome | undefined = apiError(error).outcome;
  void outcome;
  // @ts-expect-error API errors use the protocol outcome vocabulary
  new ApiError(error.code, error.message, "indeterminate");
  // @ts-expect-error the conversion helper uses the same outcome vocabulary
  apiError(error, "indeterminate");
}

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
  const copied = await rpcReply(deviceId, "request-id", [
    "files.copy",
    { workspaceId: "w", items: [{ path: "a", targetPath: "b", collision: "error" }] },
  ]);
  if (copied.outcome !== "succeeded") copied.result?.items.map((item) => item.outcome);
  const deleted = await rpcReply(deviceId, "request-id", [
    "files.delete",
    { workspaceId: "w", paths: ["a"] },
  ]);
  if (deleted.outcome !== "succeeded") deleted.result?.items.map((item) => item.outcome);
  // @ts-expect-error file delete uses paths, not copy items
  await rpcReply(deviceId, "request-id", ["files.delete", { workspaceId: "w", items: [] }]);
  const created = await rpcReply(deviceId, "request-id", ["sessions.create", { workspaceId: "w" }]);
  if (created.outcome === "succeeded") created.result.id.toUpperCase();
  else {
    // @ts-expect-error an unknown creation result is not a complete Session
    void created.result.id;
  }
}
