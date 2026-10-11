import { useTranslation } from "react-i18next";
import { useWatchStatus } from "../lib/use-workspace-refresh";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

export function WatchStatus({ deviceId, workspaceId }: { deviceId: string; workspaceId: string }) {
  const { t } = useTranslation();
  const reason = useWatchStatus(deviceId, workspaceId);
  return reason !== undefined ? (
    <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3 text-xs text-muted-foreground">
      <span role="status">{t(($) => $.common.watchLimited)}</span>
      <Dialog>
        <DialogTrigger render={<Button variant="ghost" className="h-11 text-xs" />}>
          {t(($) => $.common.watchDetails)}
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.common.details)}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-5 py-4 text-sm">
            <p className="text-muted-foreground">{t(($) => $.common.watchRefresh)}</p>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
              {reason || t(($) => $.common.watchUnavailable)}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  ) : null;
}
