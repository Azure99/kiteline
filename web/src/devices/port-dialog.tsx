import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import type { Device, ListeningPorts } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import { IconButton } from "../components/icon-button";
import { rpc } from "../lib/api";
import { serviceURL } from "../lib/device-service";
import { copyText } from "../lib/clipboard";

export function PortDialog({ device, onClose }: { device: Device; onClose: () => void }) {
  const { t } = useTranslation();

  const input = useRef<HTMLInputElement>(null);
  const [port, setPort] = useState("");
  const [retain, setRetain] = useState(false);
  const [ports, setPorts] = useState<ListeningPorts>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<{ kind: "copied" } | { kind: "error"; error: unknown }>();
  const request = useRef<AbortController>(undefined);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const next = await rpc(device.id, "ports.list", {}, controller.signal);
      if (!controller.signal.aborted) setPorts(next);
    } catch (error) {
      if (!controller.signal.aborted) setError(error);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [device.id]);
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  const value = /^\d{1,5}$/.test(port) ? Number(port) : 0;
  const url = value >= 1 && value <= 65535 ? serviceURL(device.id, value, retain).href : undefined;
  function open() {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }
  async function copy() {
    if (!url) return;
    try {
      await copyText(url);
      setNotice({ kind: "copied" });
    } catch (error) {
      setNotice({ kind: "error", error });
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent initialFocus={input}>
        <DialogHeader>
          <DialogTitle>{t(($) => $.shell.openPort)}</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            open();
          }}
        >
          <div className="space-y-4 overflow-auto p-5">
            <p className="break-all text-sm font-medium">{device.name}</p>
            <label className="block space-y-2 text-sm">
              <span>{t(($) => $.devices.port)}</span>
              <Input
                ref={input}
                aria-label={t(($) => $.devices.port)}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={5}
                value={port}
                onChange={(event) => {
                  setPort(event.target.value);
                  setNotice(undefined);
                }}
              />
            </label>
            <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <legend className="sr-only">{t(($) => $.devices.proxyPath)}</legend>
              <label className="flex min-h-8 items-center gap-2 max-desk:min-h-11">
                <input
                  type="radio"
                  name="proxy-mode"
                  checked={!retain}
                  onChange={() => setRetain(false)}
                />
                {t(($) => $.devices.stripPrefix)}
              </label>
              <label className="flex min-h-8 items-center gap-2 max-desk:min-h-11">
                <input
                  type="radio"
                  name="proxy-mode"
                  checked={retain}
                  onChange={() => setRetain(true)}
                />
                {t(($) => $.devices.keepPrefix)}
              </label>
            </fieldset>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>{t(($) => $.devices.listeningPorts)}</span>
                <IconButton
                  label={t(($) => $.devices.refreshPorts)}
                  onClick={() => void load()}
                  disabled={loading}
                >
                  <RefreshCw />
                </IconButton>
              </div>
              {loading ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t(($) => $.common.reading)}
                </p>
              ) : error ? (
                <div role="alert" className="break-words text-sm text-destructive">
                  <ErrorNotice error={error} />
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {ports?.ports.map((entry) => (
                    <Button
                      key={entry}
                      variant="outline"
                      onClick={() => {
                        setPort(String(entry));
                        setNotice(undefined);
                      }}
                    >
                      {entry}
                    </Button>
                  ))}
                  {ports?.ports.length === 0 && (
                    <p className="text-sm text-muted-foreground">{t(($) => $.devices.noPorts)}</p>
                  )}
                </div>
              )}
              {ports?.truncated && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(($) => $.devices.partialPorts)}
                </p>
              )}
            </div>
            {port && !url && (
              <p role="alert" className="text-sm text-destructive">
                {t(($) => $.devices.portRange)}
              </p>
            )}
            {notice && (
              <div role="status" className="text-sm text-muted-foreground">
                {notice.kind === "copied" ? (
                  t(($) => $.common.copied)
                ) : (
                  <ErrorNotice error={notice.error} />
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={!url}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void copy()}
            >
              <Copy />
              {t(($) => $.devices.copyLink)}
            </Button>
            <Button type="submit" disabled={!url}>
              <ExternalLink />
              {t(($) => $.common.open)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
