import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { limits, type BrowserEvent, type FileCleanup } from "@kiteline/shared/protocol";
import { ErrorNotice } from "../components/error-notice";
import { ApiError, rpc } from "../lib/api";

export function FileCleanupNotice({
  deviceId,
  active = true,
  refresh = 0,
}: {
  deviceId: string;
  active?: boolean;
  refresh?: number;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<FileCleanup>();
  const [unknown, setUnknown] = useState(false);
  useEffect(() => {
    if (!active) return;
    let disposed = false,
      running = false,
      again = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const read = async () => {
      if (disposed || document.hidden) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      clearTimeout(timer);
      let repeat = false;
      try {
        const result = await rpc(deviceId, "files.cleanup", {}, controller.signal);
        if (disposed) return;
        setState(result);
        setUnknown(false);
        repeat = result.pending;
      } catch {
        if (disposed) return;
        setUnknown(true);
        repeat = true;
      } finally {
        running = false;
        if (!disposed) {
          timer = setTimeout(
            () => void read(),
            again ? 0 : repeat ? 5000 : limits.visibleRefreshInterval,
          );
          again = false;
        }
      }
    };
    const update = (event: Event) => {
      const message = (event as CustomEvent<BrowserEvent>).detail;
      if (
        message.type === "devices.changed" ||
        (message.type === "workspace.changed" && message.deviceId === deviceId)
      )
        void read();
    };
    const visible = () => void read();
    void read();
    window.addEventListener("kiteline:event", update);
    window.addEventListener("kiteline:connected", visible);
    window.addEventListener("kiteline:files-operated", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("kiteline:event", update);
      window.removeEventListener("kiteline:connected", visible);
      window.removeEventListener("kiteline:files-operated", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [deviceId, active, refresh]);
  if (!active || (!unknown && !state?.pending && !state?.failed)) return null;
  return (
    <div
      role="status"
      className="scroll-area max-h-40 shrink-0 space-y-1 overflow-auto break-words border-b px-4 py-2 text-xs text-muted-foreground"
    >
      <p>
        {unknown
          ? t(($) => $.files.cleanupUnknown)
          : state?.pending
            ? t(($) => $.files.cleaning)
            : t(($) => $.files.cleanupFailed)}
      </p>
      {state && <p>{t(($) => $.files.cleanupRetained, { count: state.retained })}</p>}
      {!!state?.failed && (
        <details>
          <summary className="cursor-pointer">
            {t(($) => $.files.cleanupFailures, { count: state.failed })}
          </summary>
          {state.failures.map((failure) => (
            <p key={failure.path} className="break-all text-destructive">
              {failure.path}:{" "}
              <ErrorNotice error={new ApiError(failure.error.code, failure.error.message)} />
            </p>
          ))}
          {state.truncated && <p>{t(($) => $.files.errorsOmitted)}</p>}
        </details>
      )}
    </div>
  );
}
