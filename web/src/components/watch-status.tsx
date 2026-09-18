import { useWatchStatus } from "../lib/use-workspace-refresh";

export function WatchStatus({ deviceId, workspaceId }: { deviceId: string; workspaceId: string }) {
  const reason = useWatchStatus(deviceId, workspaceId);
  return reason ? (
    <p
      role="status"
      className="shrink-0 border-b border-border px-3 py-1 text-xs text-muted-foreground"
      title={reason}
    >
      自动监听受限，定时刷新仍可用：{reason}
    </p>
  ) : null;
}
