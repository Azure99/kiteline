import { newId } from "./id";
import { ApiError, createApiClient } from "@kiteline/shared/protocol/client";
import { i18n } from "../i18n";
import { en } from "../i18n/en";
import { observeServerVersion } from "./release";

export { ApiError, apiError } from "@kiteline/shared/protocol/client";
export const {
  request,
  api,
  post,
  openChannel,
  cancelChannel,
  fileChannel,
  cancelRequest,
  rpcReply,
  rpc,
} = createApiClient({
  request: async (path, options, consume) => consume(await fetch(path, options)),
  newId,
  observeServerVersion,
  unauthenticated: () => window.dispatchEvent(new Event("kiteline:unauthenticated")),
});

export function errorMessage(error: unknown, context?: "login") {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ApiError ? error.code : undefined;
  const summary =
    context === "login" && code === "unauthenticated"
      ? i18n.t(($) => $.auth.invalidCredentials)
      : code && Object.hasOwn(en.errors, code)
        ? i18n.t(($) => $.errors[code as keyof typeof en.errors])
        : i18n.t(($) => $.errors.requestFailed);
  const outcome = error instanceof ApiError ? error.outcome : undefined;
  const outcomeMessage =
    outcome === "unknown" || outcome === "partial" ? i18n.t(($) => $.errors[outcome]) : "";
  return [outcomeMessage, summary, code ? `[${code}] ${message}` : message]
    .filter(Boolean)
    .join(" ");
}
