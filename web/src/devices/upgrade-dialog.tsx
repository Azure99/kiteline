import { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { ErrorNotice } from "../components/error-notice";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { AgentPlatformChoice, type AgentPlatform } from "./agent-platform";

interface Upgrade {
  version: string;
  commands: Record<AgentPlatform, string>;
}

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
  const [upgrade, setUpgrade] = useState<Upgrade>();
  const [platform, setPlatform] = useState<AgentPlatform>("linux");
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState<{ text: string; error: unknown }>();
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<Upgrade>("/api/agent/upgrade-command", {
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

  const command = upgrade?.commands[platform];
  const visibleCopyError = copyError?.text === command ? copyError?.error : undefined;
  async function copy() {
    if (!command) return;
    setCopied("");
    setCopyError(undefined);
    setPending(true);
    try {
      await copyText(command);
      setCopied(command);
    } catch (error) {
      setCopyError({ text: command, error });
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
              <AgentPlatformChoice value={platform} onChange={setPlatform} />
              <p>{t(($) => $.devices.upgradeTarget, { version: upgrade.version })}</p>
              <p className="text-muted-foreground">{t(($) => $.devices.upgradeHint)}</p>
              <Button
                variant="outline"
                disabled={pending}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void copy()}
              >
                {copied === command ? <Check /> : <Copy />}
                {copied === command ? t(($) => $.common.copied) : t(($) => $.devices.copyUpgrade)}
              </Button>
              <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs" tabIndex={0}>
                {command}
              </pre>
            </>
          ) : (
            !error && <p role="status">{t(($) => $.common.loading)}</p>
          )}
          {!!(error || visibleCopyError) && (
            <div role="alert" className="break-words text-destructive">
              {!!visibleCopyError && <p>{t(($) => $.devices.upgradeCopyFailed)}</p>}
              <ErrorNotice error={error || visibleCopyError} />
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
