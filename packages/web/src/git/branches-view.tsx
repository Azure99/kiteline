import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Trash2,
  ArrowRightLeft,
  FolderGit2,
} from "lucide-react";
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

  const [expanded, setExpanded] = useState<string>();
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
  useWorkspaceRefresh(deviceId, workspaceId, active, load);
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
          <div key={branch.name} className="border-b border-border">
            <div className="flex min-h-9 items-center gap-2 px-2">
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
              <button
                className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left text-xs max-desk:min-h-11"
                title={[branch.name, branch.oid, branch.worktreePath].filter(Boolean).join(" · ")}
                aria-expanded={expanded === branch.name}
                onClick={() => setExpanded(expanded === branch.name ? undefined : branch.name)}
              >
                <span className="min-w-0 truncate">{branch.name}</span>
                {branch.worktreePath && !branch.current && (
                  <FolderGit2
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label={t(($) => $.git.worktree)}
                  />
                )}
                {expanded === branch.name ? (
                  <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
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
                      if (
                        window.confirm(t(($) => $.git.deleteBranchConfirm, { name: branch.name }))
                      )
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
            {expanded === branch.name && (
              <div className="bg-muted px-8 py-2 text-xs">
                <p className="break-all">{branch.name}</p>
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                  {branch.oid}
                </p>
                {branch.worktreePath && (
                  <p className="mt-1 break-all text-muted-foreground">
                    {t(($) => $.git.worktree)} · {branch.worktreePath}
                  </p>
                )}
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
