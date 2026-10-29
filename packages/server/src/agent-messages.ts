import {
  AppError,
  checkEnvironment,
  checkMetadata,
  integer,
  limits,
  record,
  string,
  type FileProgress,
  type Reply,
  type WorkspaceEvent,
} from "@kiteline/shared/protocol";

export function parseHello(message: Record<string, unknown>) {
  return {
    environment: checkEnvironment(message.environment),
    editorBytes: integer(message.editorBytes, "editorBytes", 1, Number.MAX_SAFE_INTEGER),
    snapshot: checkMetadata(message.snapshot),
  };
}

export function parseWorkspaceEvent(
  type: WorkspaceEvent["type"],
  message: Record<string, unknown>,
): WorkspaceEvent {
  const workspaceId = string(message.workspaceId);
  if (type === "workspace.changed" || type === "sessions.changed") return { type, workspaceId };
  const { status, reason } = message;
  if (
    (status !== "normal" && status !== "degraded") ||
    (reason !== undefined && typeof reason !== "string")
  )
    throw new AppError("invalid_argument", "Invalid workspace watch status");
  return { type, workspaceId, status, reason };
}

export function parseRequestProgress(message: Record<string, unknown>): FileProgress {
  const { phase, currentPath, completedItems, bytes } = message;
  if (
    (phase !== "queued" && phase !== "running") ||
    (currentPath !== undefined && typeof currentPath !== "string") ||
    (completedItems !== undefined && typeof completedItems !== "number") ||
    (bytes !== undefined && typeof bytes !== "number")
  )
    throw new AppError("invalid_argument", "Invalid request progress");
  return { phase, currentPath, completedItems, bytes };
}

export function parseTerminalNotice(message: Record<string, unknown>) {
  const notice = record(message.notice);
  if (
    typeof notice.title !== "string" ||
    typeof notice.body !== "string" ||
    typeof notice.blocked !== "boolean"
  )
    throw new AppError("invalid_argument", "Invalid terminal report");
  return {
    workspaceId: string(message.workspaceId),
    sessionId: string(message.sessionId),
    name: string(message.name, "session name", limits.nameLength),
    notice: { title: notice.title, body: notice.body, blocked: notice.blocked },
  };
}

export function parseReplyError(value: unknown) {
  const error = record(value);
  const code = string(error.code);
  if (typeof error.message !== "string")
    throw new AppError("invalid_argument", "Expected a diagnostic string");
  return new AppError(code, error.message, error.details);
}

export function checkReply(reply: Record<string, unknown>): Reply {
  if (
    typeof reply.outcome !== "string" ||
    !["succeeded", "failed", "partial", "unknown"].includes(reply.outcome)
  )
    throw new AppError("invalid_argument", "Invalid reply");
  if (reply.outcome !== "succeeded") parseReplyError(reply.error);
  return reply as unknown as Reply;
}
