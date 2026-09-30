import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Device } from "@kiteline/shared/protocol";
import { api, post } from "../lib/api";
import { copyText } from "../lib/clipboard";
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
}: {
  devices: Device[];
  connected: boolean;
  onDevice: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();

  const [binding, setBinding] = useState<Binding>();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<unknown>();
  const [copyError, setCopyError] = useState<{ text: string; error: unknown }>();
  const [platform, setPlatform] = useState<AgentPlatform>("linux");
  const [busy, setBusy] = useState(true);
  const [copied, setCopied] = useState("");
  const create = useCallback(async () => {
    setError(undefined);
    setCopyError(undefined);
    setBusy(true);
    try {
      setBinding(await post<Binding>("/api/bindings"));
      setResult({ status: "pending" });
      setCopied("");
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }, []);
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
    async function poll() {
      try {
        const status = await api<Result>(`/api/bindings/${binding!.bindingId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setResult(status);
        setError(undefined);
        if (status.status === "pending") timer = setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(error);
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [binding]);
  const commands = binding?.commands[platform];
  const command = commands?.install;
  const visibleCopyError =
    copyError && (copyError.text === command || copyError.text === commands?.bind)
      ? copyError.error
      : undefined;
  const device = devices.find((entry) => entry.id === result?.deviceId);
  const online = connected && device?.status === "online";
  const copy = (text: string) => {
    setCopyError(undefined);
    setCopied("");
    void copyText(text)
      .then(() => setCopied(text))
      .catch((error: unknown) => setCopyError({ text, error }));
  };
  return (
    <DialogContent>
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
            <AgentPlatformChoice value={platform} onChange={setPlatform} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
              <span role="status" className="text-sm">
                {result?.status === "consumed"
                  ? online
                    ? t(($) => $.devices.deviceOnline)
                    : !connected
                      ? t(($) => $.devices.registeredUnknown)
                      : device?.status === "revoked"
                        ? t(($) => $.common.deviceRevoked)
                        : t(($) => $.devices.registeredOffline)
                  : result?.status === "expired"
                    ? t(($) => $.devices.bindingExpired)
                    : t(($) => $.devices.waitingDevice)}
              </span>
              <span className="text-xs">
                {t(($) => $.devices.expiresAt, {
                  time: new Date(binding.expiresAt).toLocaleTimeString(i18n.resolvedLanguage),
                })}
              </span>
            </div>
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
                  disabled={result?.status !== "pending"}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => copy(command!)}
                >
                  {copied === command ? <Check /> : <Copy />}
                </IconButton>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all p-3 text-xs leading-relaxed">
                {command}
              </pre>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
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
                  disabled={result?.status !== "pending"}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => copy(commands!.bind)}
                >
                  {copied === commands!.bind ? <Check /> : <Copy />}
                </IconButton>
              </div>
            </details>
            {result?.status === "consumed" && !online && (
              <p className="text-sm text-muted-foreground">{t(($) => $.devices.lostCredentials)}</p>
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
        {result?.deviceId && (
          <Button onClick={() => onDevice(result.deviceId!)}>
            {t(($) => $.devices.viewDevice)}
          </Button>
        )}
        {result?.status === "expired" && (
          <Button onClick={() => void create()} disabled={busy}>
            {t(($) => $.devices.regenerate)}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
