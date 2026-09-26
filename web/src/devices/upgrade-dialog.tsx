import { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { ErrorNotice } from "../components/error-notice";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";

export function UpgradeDialog({
  deviceName,
  trigger,
  onClose,
}: {
  deviceName: string;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [upgrade, setUpgrade] = useState<{ version: string; command: string }>();
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ version: string; command: string }>("/api/agent/upgrade-command", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setUpgrade(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(error);
      });
    return () => controller.abort();
  }, [attempt]);

  async function copy() {
    if (!upgrade) return;
    setCopied(false);
    setError(undefined);
    setPending(true);
    try {
      await copyText(upgrade.command);
      setCopied(true);
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent finalFocus={trigger}>
        <DialogHeader>
          <DialogTitle>{t(($) => $.devices.upgradeAgent)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 overflow-auto p-5 text-sm">
          <p className="break-words font-medium">
            {t(($) => $.devices.upgradeDevice, { device: deviceName })}
          </p>
          {upgrade ? (
            <>
              <p>{t(($) => $.devices.upgradeTarget, { version: upgrade.version })}</p>
              <p className="text-muted-foreground">{t(($) => $.devices.upgradeHint)}</p>
              <Button
                variant="outline"
                disabled={pending}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void copy()}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? t(($) => $.common.copied) : t(($) => $.devices.copyUpgrade)}
              </Button>
              <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs" tabIndex={0}>
                {upgrade.command}
              </pre>
            </>
          ) : (
            !error && <p role="status">{t(($) => $.common.loading)}</p>
          )}
          {!!error && (
            <div role="alert" className="break-words text-destructive">
              {upgrade && <p>{t(($) => $.devices.upgradeCopyFailed)}</p>}
              <ErrorNotice error={error} />
            </div>
          )}
          {!upgrade && !!error && (
            <Button
              variant="outline"
              onClick={() => {
                setError(undefined);
                setAttempt((value) => value + 1);
              }}
            >
              <RefreshCw />
              {t(($) => $.common.retry)}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
