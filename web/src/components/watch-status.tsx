import { useWatchStatus } from "../lib/use-workspace-refresh";
import { useTranslation } from "react-i18next";

export function WatchStatus({ deviceId, workspaceId }: { deviceId: string; workspaceId: string }) {
  const { t } = useTranslation();
  const reason = useWatchStatus(deviceId, workspaceId);
  return reason !== undefined ? (
    <p
      role="status"
      className="workbench-notice shrink-0 border-b border-border px-3 py-1 text-xs text-muted-foreground"
      title={reason}
    >
      {t(($) => $.common.watchLimited, { reason: reason || t(($) => $.common.watchUnavailable) })}
    </p>
  ) : null;
}
