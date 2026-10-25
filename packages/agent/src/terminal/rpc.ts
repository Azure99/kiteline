import {
  limits,
  optionalString,
  string,
  type RpcMethod,
  type RpcResult,
} from "@kiteline/shared/protocol";
import type { MetadataStore } from "../metadata.js";
import type { Sessions } from "./sessions.js";

type SessionMethod = Extract<RpcMethod, `sessions.${string}`>;

export function isSessionMethod(method: RpcMethod): method is SessionMethod {
  return method.startsWith("sessions.");
}

export async function terminalRpc(
  method: SessionMethod,
  params: Record<string, unknown>,
  signal: AbortSignal,
  { sessions, metadata }: { sessions: Sessions; metadata: MetadataStore },
): Promise<RpcResult<SessionMethod>> {
  switch (method) {
    case "sessions.list": {
      const workspaceId = optionalString(params.workspaceId);
      if (workspaceId) metadata.workspace(workspaceId);
      return sessions.list(workspaceId) satisfies RpcResult<typeof method>;
    }
    case "sessions.create":
      return sessions.create(
        {
          workspaceId: string(params.workspaceId),
          name: optionalString(params.name, "name", limits.nameLength),
          shortcutId: optionalString(params.shortcutId),
        },
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "sessions.rename":
      return sessions.rename(
        { workspaceId: string(params.workspaceId), sessionId: string(params.sessionId) },
        string(params.name, "name", limits.nameLength),
      ) satisfies RpcResult<typeof method>;
    case "sessions.end":
      return sessions.end({
        workspaceId: string(params.workspaceId),
        sessionId: string(params.sessionId),
      }) satisfies Promise<RpcResult<typeof method>>;
    case "sessions.recover":
      return sessions.recover({
        workspaceId: string(params.workspaceId),
        sessionId: string(params.sessionId),
      }) satisfies RpcResult<typeof method>;
    case "sessions.redraw":
      return sessions.redraw({
        workspaceId: string(params.workspaceId),
        sessionId: string(params.sessionId),
      }) satisfies Promise<RpcResult<typeof method>>;
    case "sessions.snapshot":
      return sessions.snapshot(params);
    case "sessions.send":
      return sessions.send(params);
    case "sessions.wait":
      return sessions.wait(params);
    case "sessions.resize":
      return sessions.resize(params);
  }
}
