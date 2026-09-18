import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import type { Branch } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { errorMessage, rpc } from "../lib/api";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";

export function BranchesView({
  deviceId,
  workspaceId,
  repoId,
  active,
}: {
  deviceId: string;
  workspaceId: string;
  repoId: string;
  active: boolean;
}) {
  const [items, setItems] = useState<Branch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController>(undefined);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const result = await rpc<{ branches: Branch[] }>(
        deviceId,
        "git.branches",
        { workspaceId, repoId },
        controller.signal,
      );
      if (!controller.signal.aborted) setItems(result.branches);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setBusy(false);
      }
    }
  }, [deviceId, workspaceId, repoId]);
  useEffect(() => {
    return () => request.current?.abort();
  }, [active, load]);
  useWorkspaceRefresh(deviceId, workspaceId, active, "git", load);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 shrink-0 items-center justify-end border-b border-border px-3">
        <IconButton label="刷新分支" disabled={!active || busy} onClick={() => void load()}>
          <RefreshCw />
        </IconButton>
      </div>
      {error && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="scroll-area min-h-0 flex-1 overflow-auto">
        {items.map((branch) => (
          <div
            key={branch.name}
            className="flex min-h-16 items-start gap-3 border-b border-border px-4 py-3"
          >
            <GitBranch className="mt-1 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="break-all text-sm">{branch.name}</p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {branch.oid.slice(0, 8)}
                {branch.worktreePath && !branch.current ? ` · ${branch.worktreePath}` : ""}
              </p>
            </div>
            {branch.current && <span className="text-xs text-primary">当前</span>}
          </div>
        ))}
        {!items.length && (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {busy ? "正在读取" : error ? "" : "暂无分支"}
          </p>
        )}
      </div>
    </div>
  );
}
