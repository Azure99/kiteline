import {
  AppError,
  optionalString,
  string,
  type FileProgress,
  type RpcMethod,
  type RpcResult,
} from "@kiteline/shared/protocol";
import type { MetadataStore } from "../metadata.js";
import type { Files } from "./index.js";
import type { FileOperations } from "./operations.js";
import { searchFiles } from "./search.js";

type FileMethod = Extract<RpcMethod, `files.${string}`>;

export function isFileMethod(method: RpcMethod): method is FileMethod {
  return method.startsWith("files.");
}

export async function fileRpc(
  method: FileMethod,
  params: Record<string, unknown>,
  signal: AbortSignal,
  context: {
    files: Files;
    operations: FileOperations;
    metadata: MetadataStore;
  },
  progress?: (value: FileProgress) => void,
): Promise<RpcResult<FileMethod>> {
  switch (method) {
    case "files.search": {
      if (
        (params.mode !== "name" && params.mode !== "content") ||
        typeof params.includeIgnored !== "boolean"
      )
        throw new AppError("invalid_argument", "Invalid search parameters");
      return (await searchFiles(
        context.metadata.workspace(string(params.workspaceId)).path,
        params.mode,
        string(params.query, "query"),
        params.includeIgnored,
        signal,
      )) satisfies RpcResult<typeof method>;
    }
    case "files.copy":
      return (await context.operations.run(
        "copy",
        string(params.workspaceId),
        params.items,
        signal,
        progress,
      )) satisfies RpcResult<typeof method>;
    case "files.move":
      return (await context.operations.run(
        "move",
        string(params.workspaceId),
        params.items,
        signal,
        progress,
      )) satisfies RpcResult<typeof method>;
    case "files.delete":
      return (await context.operations.run(
        "delete",
        string(params.workspaceId),
        params.paths,
        signal,
        progress,
      )) satisfies RpcResult<typeof method>;
    case "files.list":
      return (await context.files.list(
        string(params.workspaceId),
        string(params.path),
        optionalString(params.cursor),
        signal,
      )) satisfies RpcResult<typeof method>;
    case "files.inspect":
      return (await context.files.inspect(
        string(params.workspaceId),
        string(params.path),
        params.suggestCopyName === true,
        signal,
      )) satisfies RpcResult<typeof method>;
    case "files.create":
      return (await context.files.create(
        string(params.workspaceId),
        string(params.path),
        string(params.kind),
        signal,
      )) satisfies RpcResult<typeof method>;
    case "files.rename":
      return (await context.files.rename(
        string(params.workspaceId),
        string(params.path),
        string(params.newName),
        signal,
      )) satisfies RpcResult<typeof method>;
    default: {
      const unhandled: never = method;
      throw new AppError("unsupported", `Unsupported operation: ${unhandled}`);
    }
  }
}
