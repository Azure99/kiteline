import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import { IconButton } from "./icon-button";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

export function WatchStatus({
  reason,
  compact = false,
  onDismiss,
}: {
  reason?: string;
  compact?: boolean;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  return reason !== undefined ? (
    <div
      className={
        compact
          ? "shrink-0"
          : "flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground"
      }
    >
      {!compact && (
        <span role="status" className="flex-1">
          {t(($) => $.common.watchLimited)}
        </span>
      )}
      <Dialog>
        <DialogTrigger
          render={
            compact ? (
              <IconButton label={t(($) => $.common.watchLimited)} />
            ) : (
              <Button variant="ghost" className="h-11 text-xs" />
            )
          }
        >
          {compact ? <AlertTriangle /> : t(($) => $.common.watchDetails)}
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
      {!compact && (
        <IconButton label={t(($) => $.common.dismiss)} onClick={onDismiss}>
          <X />
        </IconButton>
      )}
    </div>
  ) : null;
}
