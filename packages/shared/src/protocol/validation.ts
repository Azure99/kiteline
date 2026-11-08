export const errorCodes = [
  "invalid_argument",
  "unsupported",
  "unauthenticated",
  "forbidden",
  "permission_denied",
  "not_found",
  "conflict",
  "limit_exceeded",
  "version_mismatch",
  "busy",
  "offline",
  "timeout",
  "cancelled",
  "io_error",
  "command_failed",
  "recording_unavailable",
] as const;
export type ErrorCode = (typeof errorCodes)[number];
// A peer may run a build with a different list, so a code it reports passes through unchecked.
export type PeerErrorCode = string & { readonly peer: unique symbol };
export function peerErrorCode(code: string) {
  return code as PeerErrorCode;
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode | PeerErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("invalid_argument", "Expected an object");
  return value as Record<string, unknown>;
}
export function string(value: unknown, name = "value", max = 4096): string {
  if (typeof value !== "string" || !value.length || value.length > max || value.includes("\0"))
    throw new AppError("invalid_argument", `Invalid ${name}`);
  return value;
}
export function optionalString(value: unknown, name = "value", max = 4096): string | undefined {
  return value === undefined ? undefined : string(value, name, max);
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new AppError("invalid_argument", `Invalid ${name}`);
  return value;
}
