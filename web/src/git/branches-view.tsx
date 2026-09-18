import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, RefreshCw, Plus, Trash2, ArrowRightLeft } from "lucide-react";
import type { Branch } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { errorMessage, rpc } from "../lib/api";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";
import { type GitActions, useGitActivity } from "./actions";
import { BranchDialog } from "./branch-dialog";

export function BranchesView({
  deviceId,
  workspaceId,
  repoId,
  active,
  actions,
  headOid,
}: {
  deviceId: string;
  workspaceId: string;
  repoId: string;
  active: boolean;
  actions: GitActions;
  headOid?: string | null;
}) {
  const [items, setItems] = useState<Branch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController>(undefined);
  const target = { deviceId, workspaceId, repoId };
  const activity = useGitActivity(actions, target);
  const [creating, setCreating] = useState(false);
  const disabled = !active || !!activity.request;
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
  useEffect(() => {
    if (active && activity.revision) void load();
  }, [active, activity.revision, load]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 shrink-0 items-center justify-end border-b border-border px-3">
        <IconButton
          label="创建分支"
          disabled={disabled || !headOid}
          onClick={() => setCreating(true)}
        >
          <Plus />
        </IconButton>
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
            {!branch.current && (
              <div className="flex shrink-0">
                <IconButton
                  label={`切换到 ${branch.name}`}
                  disabled={disabled || !!branch.worktreePath}
                  onClick={() =>
                    void actions.run(
                      target,
                      "git.branch.switch",
                      { name: branch.name, refOid: branch.oid },
                      "切换分支",
                    )
                  }
                >
                  <ArrowRightLeft />
                </IconButton>
                <IconButton
                  label={`删除分支 ${branch.name}`}
                  disabled={disabled || !!branch.worktreePath}
                  onClick={() => {
                    if (window.confirm(`删除分支 ${branch.name}？`))
                      void actions.run(
                        target,
                        "git.branch.delete",
                        { name: branch.name, refOid: branch.oid },
                        "删除分支",
                      );
                  }}
                >
                  <Trash2 />
                </IconButton>
              </div>
            )}
          </div>
        ))}
        {!items.length && (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {busy ? "正在读取" : error ? "" : "暂无分支"}
          </p>
        )}
      </div>
      {creating && (
        <BranchDialog
          target={target}
          actions={actions}
          startOid={headOid ?? undefined}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
