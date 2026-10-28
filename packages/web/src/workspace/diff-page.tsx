import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Columns2, FilePenLine, RefreshCw, Rows2 } from "lucide-react";
import { DiffView, type DiffTarget } from "../git/diff-view";
import type { Repo } from "@kiteline/shared/protocol";
import { GitFilePath } from "../git/view-header";
import { ErrorNotice } from "../components/error-notice";
import type { useRepos } from "../git/use-repos";
import { IconButton } from "../components/icon-button";
import { useMobile } from "../lib/use-mobile";
import { showFile } from "../files/navigation";
import { childPath } from "../files/paths";
import { useDrafts, type DraftStore } from "../files/drafts";
import { hasUnsavedDraft } from "../git/drafts";
import { useGitActivity, type GitActions } from "../git/actions";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";
import type { DiffPage } from "./pages";

export function DiffPageView({
  page,
  deviceId,
  workspaceId,
  actions,
  view,
  onView,
  active,
  repositories,
  store,
  onDiff,
  onChanges,
}: {
  page: DiffPage;
  deviceId: string;
  workspaceId: string;
  actions: GitActions;
  view: "unified" | "split";
  onView(view: "unified" | "split"): void;
  active: boolean;
  repositories: ReturnType<typeof useRepos>;
  store: DraftStore;
  onDiff(repo: Repo, target: DiffTarget): void;
  onChanges(): void;
}) {
  const { t } = useTranslation();
  const mobile = useMobile();
  const unsaved = hasUnsavedDraft(useDrafts(store), { deviceId, workspaceId }, page.repoPath, [
    page.target.path,
  ]);
  const [revision, setRevision] = useState(0);
  const repo = repositories.repos.find((repo) => repo.id === page.repoId);
  const activity = useGitActivity(actions, { deviceId, workspaceId, repoId: page.repoId });
  useWorkspaceRefresh(deviceId, workspaceId, active && page.target.side !== "commit", () =>
    setRevision((value) => value + 1),
  );
  const refreshKey = useMemo(() => [revision, activity.revision], [revision, activity.revision]);
  const nextView = view === "unified" ? "split" : "unified";
  const source =
    page.target.side === "commit"
      ? `${page.target.commitOid.slice(0, 8)}${page.target.parentOid ? ` ← ${page.target.parentOid.slice(0, 8)}` : ""}`
      : t(($) => (page.target.side === "staged" ? $.git.index : $.git.worktree));
  let unavailableMessage: ReactNode;
  if (!active) {
    unavailableMessage = t(($) => $.common.deviceOffline);
  } else if (repositories.error) {
    unavailableMessage = <ErrorNotice error={repositories.error} />;
  } else if (repositories.busy || !repositories.scan) {
    unavailableMessage = t(($) => $.git.discovering);
  } else if (repo) {
    unavailableMessage = t(($) => $.git.bareUnsupported);
  } else if (repositories.scanComplete) {
    unavailableMessage = t(($) => $.git.repoMissing);
  } else {
    unavailableMessage = t(($) => $.git.repoNotFoundYet);
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 text-xs">
        <div className="flex min-w-0 flex-1 basis-32 items-center gap-2">
          <span
            className="max-w-[50%] overflow-x-auto whitespace-nowrap text-muted-foreground"
            tabIndex={0}
            title={page.repoPath}
          >
            {page.repoPath === "." ? t(($) => $.git.workspaceRoot) : page.repoPath}
          </span>
          <span aria-hidden="true">/</span>
          <GitFilePath path={page.target.path} title={`${page.repoPath} / ${page.target.path}`} />
        </div>
        <span className="shrink-0 text-muted-foreground">{source}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!mobile && (
            <IconButton
              label={t(($) => $.git.cycleDiffLayout, {
                current: t(($) => $.git[view]),
                next: t(($) => $.git[nextView]),
              })}
              onClick={() => onView(nextView)}
            >
              {view === "unified" ? <Rows2 /> : <Columns2 />}
            </IconButton>
          )}
          <IconButton
            label={t(($) => $.git.openFiles)}
            onClick={() =>
              showFile({ deviceId, workspaceId, path: childPath(page.repoPath, page.target.path) })
            }
          >
            <FilePenLine />
          </IconButton>
          <IconButton
            label={t(($) => $.git.refresh)}
            disabled={!active}
            onClick={() => {
              if (!repo?.available) void repositories.discover();
              setRevision((value) => value + 1);
            }}
          >
            <RefreshCw />
          </IconButton>
        </div>
      </div>
      {page.target.side !== "commit" && unsaved && (
        <p className="shrink-0 border-b border-border px-3 py-2 text-xs">
          {t(($) =>
            page.target.side === "staged"
              ? $.git.draftComparisonStaged
              : $.git.draftComparisonWorktree,
          )}
        </p>
      )}
      {repo?.available ? (
        <DiffView
          {...{ deviceId, workspaceId, refreshKey }}
          active={active && repo.discovered}
          repoId={page.repoId}
          target={page.target}
          viewType={mobile ? "unified" : view}
          onOtherSide={
            page.target.side === "commit"
              ? undefined
              : () =>
                  onDiff(repo, {
                    path: page.target.path,
                    side: page.target.side === "worktree" ? "staged" : "worktree",
                  })
          }
          onChanges={onChanges}
        />
      ) : (
        <div className="p-4 text-sm text-muted-foreground">{unavailableMessage}</div>
      )}
    </div>
  );
}
