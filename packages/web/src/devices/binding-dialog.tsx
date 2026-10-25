import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleCheck, Copy, FolderPlus } from "lucide-react";
import type { Device } from "@kiteline/shared/protocol";
import { api, ApiError, post } from "../lib/api";
import { useCopyFeedback } from "../lib/use-copy-feedback";
import {
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { AgentPlatformChoice, type AgentPlatform } from "./agent-platform";

interface Binding {
  bindingId: string;
  code: string;
  expiresAt: string;
  commands: Record<AgentPlatform, Record<"install" | "bind", string>>;
}
interface Result {
  status: "pending" | "consumed" | "expired";
  deviceId?: string;
}

export function BindingDialog({
  devices,
  connected,
  onDevice,
  onAddWorkspace,
  finalFocus,
}: {
  devices: Device[];
  connected: boolean;
  onDevice: (id: string) => void;
  onAddWorkspace: (device: Device) => void;
  finalFocus: () => boolean | HTMLElement | null;
}) {
  const { t, i18n } = useTranslation();

  const [binding, setBinding] = useState<Binding>();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<unknown>();
  const { copied, error: copyError, copy, reset } = useCopyFeedback();
  const [platform, setPlatform] = useState<AgentPlatform>("linux");
  const [busy, setBusy] = useState(true);
  const [queryStopped, setQueryStopped] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const boundDevicePresent = result?.deviceId
    ? devices.some((device) => device.id === result.deviceId)
    : undefined;
  const create = useCallback(async () => {
    setBinding(undefined);
    setResult(undefined);
    setError(undefined);
    reset();
    setBusy(true);
    try {
      setBinding(await post<Binding>("/api/bindings"));
      setResult({ status: "pending" });
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }, [reset]);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void create();
  }, [create]);
  useEffect(() => {
    if (!binding) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    setQueryStopped(false);
    setError(undefined);
    async function poll() {
      try {
        const status = await api<Result>(`/api/bindings/${binding!.bindingId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setResult(status);
        setError(undefined);
        failures = 0;
        if (status.status === "pending") timer = setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(error);
          const temporary = error instanceof ApiError && error.retryable;
          if (temporary && failures++ < 3) timer = setTimeout(() => void poll(), 3000);
          else setQueryStopped(true);
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [binding, attempt, boundDevicePresent]);
  const unavailable = error instanceof ApiError && error.code === "not_found";
  const pending = result?.status === "pending" && !unavailable;
  const commands = binding?.commands[platform];
  const command = commands?.install;
  const visibleCopyError =
    copyError && (copyError.id === command || copyError.id === commands?.bind)
      ? copyError.error
      : undefined;
  const device = devices.find((entry) => entry.id === result?.deviceId);
  const online = connected && device?.status === "online";
  const hostname = window.location.hostname;
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("127.") ||
    hostname === "[::1]";
  return (
    <DialogContent finalFocus={finalFocus}>
      <DialogHeader>
        <DialogTitle>{t(($) => $.devices.bind)}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 overflow-auto p-5">
        {!binding ? (
          busy ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t(($) => $.devices.generating)}
            </p>
          ) : (
            <Button onClick={() => void create()}>{t(($) => $.common.retry)}</Button>
          )
        ) : (
          <>
            {pending && (
              <>
                <p className="text-sm">{t(($) => $.devices.bindIntro)}</p>
                {loopback && (
                  <p className="rounded border border-border bg-muted p-3 text-sm">
                    {t(($) => $.devices.loopbackOrigin, { origin: window.location.origin })}
                  </p>
                )}
                <AgentPlatformChoice value={platform} onChange={setPlatform} />
              </>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
              <span
                role="status"
                className={`flex items-center gap-2 text-sm ${online && result?.status === "consumed" ? "font-medium text-foreground" : ""}`}
              >
                {online && result?.status === "consumed" && (
                  <CircleCheck size={18} className="text-primary" />
                )}
                {unavailable
                  ? t(($) => $.devices.bindingUnavailable)
                  : result?.status === "consumed"
                    ? online
                      ? t(($) => $.devices.deviceOnline, { name: device.name })
                      : !connected
                        ? t(($) => $.devices.registeredUnknown)
                        : t(($) => $.devices.registeredOffline)
                    : result?.status === "expired"
                      ? t(($) => $.devices.bindingExpired)
                      : t(($) => $.devices.waitingDevice)}
              </span>
              {pending && (
                <span className="text-xs">
                  {t(($) => $.devices.expiresAt, {
                    time: new Date(binding.expiresAt).toLocaleTimeString(i18n.resolvedLanguage),
                  })}
                </span>
              )}
            </div>
            {pending && (
              <div className="rounded border border-border">
                <div className="flex items-center justify-between border-b border-border px-3 py-1">
                  <span className="text-xs text-muted-foreground">
                    {t(($) => $.devices.projectUser)}
                  </span>
                  <IconButton
                    label={
                      copied === command
                        ? t(($) => $.devices.copiedInstall)
                        : t(($) => $.devices.copyInstall)
                    }
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => void copy(command!)}
                  >
                    {copied === command ? <Check /> : <Copy />}
                  </IconButton>
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all p-3 text-xs leading-relaxed">
                  {command}
                </pre>
              </div>
            )}
            {pending && platform === "windows" && (
              <p className="text-xs text-muted-foreground">{t(($) => $.devices.windowsHint)}</p>
            )}
            {pending && (
              <details className="text-sm">
                <summary className="min-h-11 cursor-pointer py-3 text-muted-foreground">
                  {t(($) => $.devices.bindOnly)}
                </summary>
                <div className="mt-2 flex items-start gap-2">
                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs">
                    {commands!.bind}
                  </code>
                  <IconButton
                    label={
                      copied === commands!.bind
                        ? t(($) => $.devices.copiedBind)
                        : t(($) => $.devices.copyBind)
                    }
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => void copy(commands!.bind)}
                  >
                    {copied === commands!.bind ? <Check /> : <Copy />}
                  </IconButton>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(($) => $.devices.bindOnlyRun)}
                </p>
              </details>
            )}
            {result?.status === "consumed" && !unavailable && (
              <p className="text-sm text-muted-foreground">
                {online ? t(($) => $.devices.nextWorkspace) : t(($) => $.devices.waitingRun)}
              </p>
            )}
          </>
        )}
        {!!(visibleCopyError || error) && (
          <div role="alert" className="text-sm text-destructive">
            <ErrorNotice error={visibleCopyError || error} />
          </div>
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>{t(($) => $.common.close)}</DialogClose>
        {result?.deviceId && !unavailable && (
          <Button
            variant={online ? "outline" : "default"}
            onClick={() => onDevice(result.deviceId!)}
          >
            {t(($) => $.devices.viewDevice)}
          </Button>
        )}
        {online && device && !unavailable && (
          <Button onClick={() => onAddWorkspace(device)}>
            <FolderPlus />
            {t(($) => $.devices.addWorkspace)}
          </Button>
        )}
        {(result?.status === "expired" || unavailable) && (
          <Button onClick={() => void create()} disabled={busy}>
            {t(($) => $.devices.regenerate)}
          </Button>
        )}
        {binding && queryStopped && !unavailable && result?.status !== "expired" && (
          <Button onClick={() => setAttempt((value) => value + 1)}>
            {t(($) => $.common.retry)}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
