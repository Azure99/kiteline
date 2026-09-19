import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { api } from "../lib/api";
import { ErrorNotice } from "../components/error-notice";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";

export function UpgradeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [upgrade, setUpgrade] = useState<{ version: string; command: string }>();
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);
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
  }, []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(($) => $.devices.upgradeAgent)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 overflow-auto p-5 text-sm">
          {upgrade ? (
            <>
              <p>{t(($) => $.devices.upgradeTarget, { version: upgrade.version })}</p>
              <p className="text-muted-foreground">{t(($) => $.devices.upgradeHint)}</p>
              <Button
                variant="outline"
                onClick={() => {
                  setError(undefined);
                  void navigator.clipboard
                    .writeText(upgrade.command)
                    .then(() => setCopied(true))
                    .catch(setError);
                }}
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
            <div role="alert">
              <ErrorNotice error={error} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
