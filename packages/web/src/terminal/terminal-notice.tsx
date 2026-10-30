import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, X } from "lucide-react";
import { ErrorNotice } from "../components/error-notice";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { ApiError } from "../lib/api";
import type { DisplayState } from "./display";

export function TerminalNotice({
  state,
  notice,
  recovering,
  compatible,
  onRecover,
  onRestore,
  onClose,
  onDismiss,
}: {
  state: DisplayState;
  notice: unknown;
  recovering: boolean;
  compatible: boolean;
  onRecover(): Promise<void>;
  onRestore(history: "retained" | "screen"): void;
  onClose(): void;
  onDismiss(): void;
}) {
  const { t } = useTranslation();
  const code = state.error instanceof ApiError ? state.error.code : undefined;
  const screenRetry =
    state.status === "error" && ["limit_exceeded", "timeout", "busy"].includes(code ?? "");
  const missing = !!state.missing || (state.status === "error" && code === "not_found");
  if (
    state.status === "ready" &&
    !state.error &&
    !state.notice &&
    !state.historyGap &&
    !state.historyLimited &&
    !notice
  )
    return null;
  let message: ReactNode;
  if (missing && !notice) {
    message = t(($) => $.terminal.endedMissing);
  } else if (notice || state.error) {
    message = <ErrorNotice error={notice || state.error} />;
  } else if (state.notice) {
    message = t(($) => $.terminal[state.notice!]);
  } else if (state.status === "ended") {
    message =
      state.exitCode == null
        ? t(($) => $.terminal.ended)
        : t(($) => $.terminal.endedCode, { code: state.exitCode });
  } else if (state.status === "connecting") {
    message = t(($) => $.common.connecting);
  } else if (state.historyGap && state.historyLimited) {
    message = t(($) => $.terminal.historyGapLimited);
  } else if (state.historyGap) {
    message = t(($) => $.terminal.historyGap);
  } else if (state.historyLimited) {
    message = t(($) => $.terminal.historyLimited);
  }
  return (
    <div
      className="terminal-notice flex flex-wrap items-start gap-2 px-3 py-1 text-xs"
      data-two-actions={screenRetry}
      data-compact={
        !notice &&
        !missing &&
        !state.error &&
        !state.notice &&
        (state.status === "ended" || state.status === "connecting")
      }
      role="status"
    >
      <div className="min-w-0 flex-1 break-words">{message}</div>
      {state.status === "error" && !missing && (
        <>
          <Button
            variant="ghost"
            disabled={recovering || !compatible}
            onClick={() =>
              code === "recording_unavailable" ? void onRecover() : onRestore("retained")
            }
          >
            <RefreshCw />
            {recovering
              ? t(($) => $.terminal.recovering)
              : code === "recording_unavailable"
                ? t(($) => $.terminal.recover)
                : t(($) => $.terminal.reconnect)}
          </Button>
          {screenRetry && (
            <Button
              variant="ghost"
              onClick={() => onRestore("screen")}
              title={t(($) => $.terminal.screenOnlyHint)}
            >
              {t(($) => $.terminal.screenOnly)}
            </Button>
          )}
        </>
      )}
      {missing && (
        <Button variant="ghost" onClick={onClose}>
          <X />
          {t(($) => $.terminal.closeDisplay)}
        </Button>
      )}
      {!!notice && (
        <IconButton label={t(($) => $.common.dismiss)} onClick={onDismiss}>
          <X />
        </IconButton>
      )}
    </div>
  );
}
