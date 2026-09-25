import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Trash2, ArrowRightLeft } from "lucide-react";
import type { Branch } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { rpc } from "../lib/api";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";
import { type GitActions, useGitActivity } from "./actions";

export function BranchesView({
  deviceId,
  workspaceId,
  repoId,
  active,
  actions,
  refreshKey,
}: {
  deviceId: string;
  workspaceId: string;
  repoId: string;
  active: boolean;
  actions: GitActions;
  refreshKey: number;
}) {
  const { t } = useTranslation();

  const [items, setItems] = useState<Branch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const request = useRef<AbortController>(undefined);
  const target = { deviceId, workspaceId, repoId };
  const activity = useGitActivity(actions, target);
  const disabled = !active || !!activity.request;
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await rpc(
        deviceId,
        "git.branches",
        { workspaceId, repoId },
        controller.signal,
      );
      if (!controller.signal.aborted) setItems(result.branches);
    } catch (error) {
      if (!controller.signal.aborted) setError(error);
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
    if (active && (activity.revision || refreshKey)) void load();
  }, [active, activity.revision, refreshKey, load]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!!error && (
        <div role="alert" className="px-4 py-2 text-xs text-destructive">
          <ErrorNotice error={error} />
        </div>
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
            {branch.current && (
              <span className="text-xs text-primary">{t(($) => $.git.current)}</span>
            )}
            {!branch.current && (
              <div className="flex shrink-0">
                <IconButton
                  label={t(($) => $.git.switchNamed, { name: branch.name })}
                  disabled={disabled || !!branch.worktreePath}
                  onClick={() =>
                    void actions.run(target, "git.branch.switch", {
                      name: branch.name,
                      refOid: branch.oid,
                    })
                  }
                >
                  <ArrowRightLeft />
                </IconButton>
                <IconButton
                  label={t(($) => $.git.deleteBranchNamed, { name: branch.name })}
                  disabled={disabled || !!branch.worktreePath}
                  onClick={() => {
                    if (window.confirm(t(($) => $.git.deleteBranchConfirm, { name: branch.name })))
                      void actions.run(target, "git.branch.delete", {
                        name: branch.name,
                        refOid: branch.oid,
                      });
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
            {busy ? t(($) => $.common.reading) : error ? "" : t(($) => $.git.noBranches)}
          </p>
        )}
      </div>
    </div>
  );
}
