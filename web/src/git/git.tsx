import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderGit2,
  GitBranch,
  RefreshCw,
  Plus,
  Minus,
  Undo2,
} from "lucide-react";
import type {
  Device,
  DiscardScope,
  GitEntry,
  Repo,
  RepoDiscovery,
  Workspace,
} from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { ToolHeader, ToolSidebar } from "../components/tool-layout";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { ApiError } from "../lib/api";
import { cursorRpc, releaseCursor } from "../lib/cursors";
import { useMobile } from "../lib/use-mobile";
import type { DraftStore } from "../files/drafts";
import { showFile } from "../files/navigation";
import { DiffView, type DiffTarget } from "./diff-view";
import { inSide, selectionOf, type ChangeSide } from "./selection";
import { useGitStatus } from "./use-status";
import { HistoryView } from "./history-view";
import { BranchesView } from "./branches-view";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";
import {
  currentRoute,
  isWorkspaceRoute,
  navigateWorkspace,
  updateWorkspaceQuery,
  useRoute,
} from "../lib/navigation";
import { parentPath } from "../files/use-browser";
import { type GitActions, useGitActivity } from "./actions";
import {
  confirmDiskVersion,
  DiscardDialog,
  discardable,
  GitFeedback,
  RowActions,
  stageable,
} from "./change-actions";
import { CommitBox } from "./commit-box";
import { BranchDialog } from "./branch-dialog";
import { RemoteActions } from "./remote-actions";
import { OperationBar } from "./operation-bar";
import { GitFilePath, GitViewHeader, type GitView } from "./view-header";

export function GitTool({
  device,
  workspace,
  visible,
  store,
  actions,
}: {
  device: Device;
  workspace: Workspace;
  visible: boolean;
  store: DraftStore;
  actions: GitActions;
}) {
  const { t } = useTranslation();

  const route = useRoute();
  const requestedRepo = route.query.repo;
  const [repos, setRepos] = useState<Repo[]>([]);
  const [scan, setScan] = useState<RepoDiscovery>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const request = useRef<AbortController>(undefined);
  const scanCursor = useRef<string>(undefined);
  const scanned = useRef(new Map<string, Repo>());
  const enabled = device.status === "online";
  const discover = useCallback(async () => {
    if (request.current) return;
    const cursor = scanCursor.current;
    if (!cursor) scanned.current.clear();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const read = (scanCursor?: string) =>
        cursorRpc(
          device.id,
          "repos.discover",
          { workspaceId: workspace.id, scanCursor },
          controller.signal,
        );
      let found: RepoDiscovery;
      try {
        found = await read(cursor);
      } catch (error) {
        if (
          !cursor ||
          !(error instanceof ApiError) ||
          error.code !== "conflict" ||
          controller.signal.aborted
        )
          throw error;
        scanCursor.current = undefined;
        scanned.current.clear();
        found = await read();
      }
      if (controller.signal.aborted) {
        void releaseCursor(device.id, "repo", found.scanCursor);
        return;
      }
      scanCursor.current = found.scanCursor;
      for (const repo of found.repos) scanned.current.set(repo.id, repo);
      setRepos((old) => {
        const entries = new Map((found.complete ? [] : old).map((item) => [item.id, item]));
        for (const repo of scanned.current.values()) entries.set(repo.id, repo);
        const next = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
        return next;
      });
      setScan(found);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error);
      }
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setBusy(false);
      }
    }
  }, [device.id, workspace.id]);
  useEffect(() => {
    return () => {
      request.current?.abort();
      request.current = undefined;
      void releaseCursor(device.id, "repo", scanCursor.current);
      scanCursor.current = undefined;
    };
  }, [enabled, discover, device.id]);
  useWorkspaceRefresh(device.id, workspace.id, enabled, "repos", discover);
  const selectedRepoId = requestedRepo ?? repos.find((item) => item.available)?.id ?? repos[0]?.id;
  const repo = repos.find((item) => item.id === selectedRepoId);
  const activeRepoId = repo?.id;
  useEffect(() => {
    if (route.tool !== "git" || requestedRepo || !activeRepoId) return;
    const current = currentRoute();
    const target = { deviceId: device.id, workspaceId: workspace.id };
    if (current.tool === "git" && isWorkspaceRoute(current, target) && !current.query.repo)
      updateWorkspaceQuery(target, { repo: activeRepoId }, true);
  }, [route.tool, requestedRepo, activeRepoId, device.id, workspace.id]);
  function chooseRepo(id: string) {
    updateWorkspaceQuery({ deviceId: device.id, workspaceId: workspace.id }, { repo: id });
  }
  function openFile(path: string) {
    if (!repo) return;
    showFile({
      deviceId: device.id,
      workspaceId: workspace.id,
      path: repo.path === "." ? path : `${repo.path}/${path}`,
    });
  }
  function locateFile(path: string) {
    if (!repo) return;
    const full = repo.path === "." ? path : `${repo.path}/${path}`;
    navigateWorkspace({ deviceId: device.id, workspaceId: workspace.id }, "files", {
      folder: parentPath(full),
      reveal: full,
      file: undefined,
      draft: undefined,
      search: undefined,
    });
  }
  const picker = (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" className="min-w-0 max-w-[55%] shrink" />}>
        <FolderGit2 />
        <span className="min-w-0 truncate">
          {repo?.path === "." ? workspace.name : (repo?.path ?? t(($) => $.git.repository))}
        </span>
        <ChevronDown />
      </MenuTrigger>
      <MenuContent>
        {repos.map((item) => (
          <MenuItem key={item.id} onClick={() => chooseRepo(item.id)}>
            <span className="min-w-0 break-all">
              {item.available
                ? item.path === "."
                  ? workspace.name
                  : item.path
                : t(($) => $.git.bareRepository, {
                    path: item.path === "." ? workspace.name : item.path,
                  })}
              {item.linked ? " · worktree" : ""}
            </span>
          </MenuItem>
        ))}
        <MenuItem disabled={!enabled || busy} onClick={() => void discover()}>
          <RefreshCw />
          {t(($) => $.git.discover)}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
  return (
    <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <ToolHeader visible={visible}>
        {!repo?.available && (
          <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
            {picker}
          </div>
        )}
        {!enabled && (
          <p role="status" className="border-b border-border px-4 py-2 text-xs">
            {device.status === "revoked"
              ? t(($) => $.common.deviceRevoked)
              : t(($) => $.common.deviceOffline)}
          </p>
        )}
        {!!(!!error || !!scan?.issues.length) && (
          <div className="max-h-36 shrink-0 overflow-auto border-b border-border px-4 py-2 text-xs text-destructive">
            {!!error && (
              <div role="alert">
                <ErrorNotice error={error} />
              </div>
            )}
            {scan?.issues.map((item, i) => (
              <div key={i} className="break-all">
                {item.path}:{" "}
                <ErrorNotice
                  error={
                    new ApiError(item.error.code, item.error.message, "failed", item.error.details)
                  }
                />
              </div>
            ))}
          </div>
        )}
        {scan && !scan.complete && (
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-1 text-xs">
            <span>{t(($) => $.git.scanIncomplete)}</span>
            <Button variant="ghost" disabled={!enabled || busy} onClick={() => void discover()}>
              {t(($) => $.git.continueScan)}
            </Button>
          </div>
        )}
      </ToolHeader>
      {repo?.available ? (
        <Changes
          key={repo.id}
          {...{ device, workspace, repo, visible, enabled, actions, store, picker }}
          onFile={openFile}
          onLocate={locateFile}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
          {busy
            ? t(($) => $.git.discovering)
            : repo
              ? t(($) => $.git.bareUnsupported)
              : selectedRepoId
                ? scan?.complete
                  ? t(($) => $.git.repoMissing)
                  : t(($) => $.git.repoNotFoundYet)
                : t(($) => $.git.noRepositories)}
        </div>
      )}
    </div>
  );
}

function Changes({
  device,
  workspace,
  repo,
  visible,
  enabled,
  onFile,
  onLocate,
  actions,
  store,
  picker,
}: {
  device: Device;
  workspace: Workspace;
  repo: Repo;
  visible: boolean;
  enabled: boolean;
  onFile: (path: string) => void;
  onLocate: (path: string) => void;
  actions: GitActions;
  store: DraftStore;
  picker: ReactNode;
}) {
  const { t, i18n } = useTranslation();

  const mobile = useMobile();
  const state = useGitStatus(device.id, workspace.id, repo.id, visible && enabled);
  const [target, setTarget] = useState<DiffTarget>();
  const [view, setView] = useState<GitView>("changes");
  const [historyVisited, setHistoryVisited] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const selectionVersion = useRef(0);
  const selectTarget = (next?: DiffTarget) => {
    selectionVersion.current++;
    setTarget(next);
  };
  const selectView = (next: GitView) => {
    selectionVersion.current++;
    if (next === "history") setHistoryVisited(true);
    setView(next);
  };
  useEffect(() => {
    if (!visible) selectionVersion.current++;
  }, [visible]);
  const { value, selected, setSelected } = state;
  const actionTarget = { deviceId: device.id, workspaceId: workspace.id, repoId: repo.id };
  const activity = useGitActivity(actions, actionTarget);
  const diffRefresh = useMemo(
    () => [value, activity.revision, refresh],
    [value, activity.revision, refresh],
  );
  const [discarding, setDiscarding] = useState<{ paths: string[]; scope: DiscardScope }>();
  const [branchStart, setBranchStart] = useState<string>();
  const disabled = !enabled || !!activity.request;
  const { load } = state;
  useEffect(() => {
    if (visible && enabled && activity.revision) void load();
  }, [activity.revision, visible, enabled, load]);
  async function indexAction(paths: string[], kind: "stage" | "unstage") {
    if (kind === "stage" && !confirmDiskVersion(store, actionTarget, repo.path, paths)) return;
    const params = { paths: [...new Set(paths)] };
    const selection = selectionVersion.current;
    const result =
      kind === "stage"
        ? await actions.run(actionTarget, "git.stage", params)
        : await actions.run(actionTarget, "git.unstage", params);
    if (
      result &&
      selection === selectionVersion.current &&
      target &&
      view === "changes" &&
      paths.includes(target.path)
    ) {
      setTarget({ path: target.path, side: kind === "stage" ? "staged" : "worktree" });
    }
  }
  const renderHeader = (preview?: DiffTarget, onBack?: () => void) => (
    <GitViewHeader
      view={view}
      count={value?.totalCount}
      target={preview}
      disabled={!enabled}
      onView={selectView}
      onBack={onBack}
      onRefresh={() => {
        void state.load();
        setRefresh((value) => value + 1);
      }}
      onFile={onFile}
      onCreateBranch={
        view === "branches" && value?.head.oid && !disabled
          ? () => setBranchStart(value.head.oid!)
          : undefined
      }
    />
  );
  const select = (entry: GitEntry, side: ChangeSide) => {
    if (entry.path === undefined) return;
    const item = selectionOf(entry, side);
    setSelected((old) =>
      old.some((x) => x.path === item.path && x.side === side)
        ? old.filter((x) => x.path !== item.path || x.side !== side)
        : [...old, item],
    );
  };
  return (
    <>
      <ToolHeader visible={visible} order={1}>
        <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          {picker}
          <button
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-xs max-[959px]:min-h-11"
            title={value?.head.oid ?? undefined}
            onClick={() => selectView("branches")}
          >
            <GitBranch size={15} className="shrink-0" />
            <span className="truncate">
              {value?.branch ??
                (value?.head.oid ? value.head.oid.slice(0, 8) : t(($) => $.common.git))}
              {value?.upstream ? ` · ${value.upstream}` : ""}
            </span>
          </button>
          {!!value?.ahead && (
            <span className="text-xs">↑{value.ahead.toLocaleString(i18n.resolvedLanguage)}</span>
          )}
          {!!value?.behind && (
            <span className="text-xs">↓{value.behind.toLocaleString(i18n.resolvedLanguage)}</span>
          )}
          <RemoteActions
            target={actionTarget}
            actions={actions}
            active={visible && enabled}
            head={value?.head}
          />
        </div>
        {view !== "history" &&
          renderHeader(view === "changes" ? target : undefined, () => selectTarget())}
        {!!(state.error || state.notice) && (
          <div
            role={state.error ? "alert" : "status"}
            className="border-b border-border px-4 py-2 text-xs text-destructive"
          >
            {state.error ? (
              <ErrorNotice error={state.error} />
            ) : (
              t(($) => $.git.selectionExpired, { count: state.notice })
            )}
          </div>
        )}
        <GitFeedback
          actions={actions}
          target={actionTarget}
          onLocate={onLocate}
          onTerminal={() =>
            navigateWorkspace({ deviceId: device.id, workspaceId: workspace.id }, "terminal")
          }
        />
        {value?.operation && (
          <OperationBar
            operation={value.operation}
            target={actionTarget}
            actions={actions}
            disabled={!enabled}
            onTerminal={() =>
              navigateWorkspace({ deviceId: device.id, workspaceId: workspace.id }, "terminal")
            }
          />
        )}
      </ToolHeader>
      {historyVisited && (
        <div className={view === "history" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
          <HistoryView
            deviceId={device.id}
            workspaceId={workspace.id}
            repoId={repo.id}
            active={visible && enabled && view === "history"}
            visible={visible && view === "history"}
            refreshKey={refresh}
            renderHeader={renderHeader}
            onBranch={(oid) => {
              if (!disabled) setBranchStart(oid);
            }}
          />
        </div>
      )}
      {view === "branches" && (
        <BranchesView
          deviceId={device.id}
          workspaceId={workspace.id}
          repoId={repo.id}
          active={visible && enabled}
          actions={actions}
          refreshKey={refresh}
        />
      )}
      <div className={view === "changes" ? "flex min-h-0 flex-1" : "hidden"}>
        <ToolSidebar visible={visible && view === "changes" && (!mobile || !target)}>
          <aside
            className="flex min-h-0 w-full flex-col border-border min-[960px]:w-80 min-[960px]:shrink-0 min-[960px]:border-r"
            aria-label={t(($) => $.git.changeList)}
          >
            <div className="scroll-area min-h-0 flex-1 overflow-auto">
              {!value && state.busy && (
                <p role="status" className="px-4 py-3 text-xs text-muted-foreground">
                  {t(($) => $.common.reading)}
                </p>
              )}
              {(
                [
                  ["conflict", t(($) => $.git.conflicts)],
                  ["staged", t(($) => $.git.stagedChanges)],
                  ["worktree", t(($) => $.git.worktreeChanges)],
                ] as const
              ).map(([side, label]) => {
                if (!value) return null;
                const entries = value.entries.filter((entry) => inSide(entry, side));
                const chosen = entries.filter(
                  (entry): entry is GitEntry & { path: string } =>
                    entry.path !== undefined &&
                    selected.some((item) => item.path === entry.path && item.side === side),
                );
                if (side === "conflict" && !entries.length) return null;
                return (
                  <div key={side}>
                    <div className="flex items-center gap-2 bg-muted/65 px-3 py-2 text-xs">
                      <ChevronDown size={13} />
                      {label}
                      <span className="ml-auto">
                        {(side === "staged" ? value.stagedCount : entries.length).toLocaleString(
                          i18n.resolvedLanguage,
                        )}
                      </span>
                      {!!chosen.length && (
                        <>
                          <IconButton
                            label={
                              side === "staged"
                                ? t(($) => $.git.unstageSelected)
                                : t(($) => $.git.stageSelected)
                            }
                            disabled={
                              disabled ||
                              (side !== "staged" && chosen.some((entry) => !stageable(entry)))
                            }
                            onClick={() =>
                              indexAction(
                                chosen.flatMap((entry) =>
                                  side === "staged" && entry.indexStatus === "R" && entry.oldPath
                                    ? [entry.path, entry.oldPath]
                                    : [entry.path],
                                ),
                                side === "staged" ? "unstage" : "stage",
                              )
                            }
                          >
                            {side === "staged" ? <Minus /> : <Plus />}
                          </IconButton>
                          <IconButton
                            label={
                              side !== "worktree"
                                ? t(($) => $.git.discardSelectedAll)
                                : t(($) => $.git.discardSelectedWorktree)
                            }
                            disabled={disabled || chosen.some((entry) => !discardable(entry))}
                            onClick={() =>
                              setDiscarding({
                                paths: chosen.map((entry) => entry.path),
                                scope: side !== "worktree" ? "all" : "worktree",
                              })
                            }
                          >
                            <Undo2 />
                          </IconButton>
                        </>
                      )}
                    </div>
                    {entries.map((entry) =>
                      entry.path === undefined ? (
                        <div
                          key={`invalid:${entry.pathError}`}
                          className="border-b border-border/50 px-3 py-2 text-xs break-all text-muted-foreground"
                        >
                          <span className="mr-2 font-mono">
                            {side === "staged" ? entry.indexStatus : entry.worktreeStatus}
                          </span>
                          {t(($) => $.git.invalidPath, { path: entry.pathError })}
                        </div>
                      ) : (
                        <div
                          key={`path:${entry.path}`}
                          className={`flex min-h-8 items-center gap-1 border-b border-border/50 px-2 max-[959px]:min-h-11 ${target?.path === entry.path && (target.side === side || side === "conflict") ? "bg-primary-soft" : ""}`}
                        >
                          <label className="flex min-h-8 items-center justify-center max-[959px]:min-h-11 max-[959px]:min-w-11">
                            <input
                              type="checkbox"
                              aria-label={t(($) => $.git.selectNamed, {
                                area: label,
                                path: entry.path,
                              })}
                              checked={selected.some(
                                (item) => item.side === side && item.path === entry.path,
                              )}
                              onChange={() => select(entry, side)}
                            />
                          </label>
                          <span
                            className={`w-3 shrink-0 font-mono text-xs ${side === "staged" ? "text-green-700" : "text-amber-700"}`}
                          >
                            {side === "staged" ? entry.indexStatus : entry.worktreeStatus}
                          </span>
                          <button
                            title={entry.path}
                            onClick={() =>
                              side === "conflict"
                                ? onFile(entry.path)
                                : selectTarget({
                                    path: entry.path,
                                    side: side === "staged" ? "staged" : "worktree",
                                  })
                            }
                            className="flex min-h-8 min-w-0 flex-1 items-center gap-2 text-left text-xs max-[959px]:min-h-11"
                          >
                            <GitFilePath path={entry.path} stacked />
                            {entry.submodule && (
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {t(($) =>
                                  entry.submodule!.commitChanged
                                    ? entry.submodule!.trackedDirty ||
                                      entry.submodule!.untrackedDirty
                                      ? $.git.submodulePointerDirty
                                      : $.git.submodulePointer
                                    : entry.submodule!.trackedDirty ||
                                        entry.submodule!.untrackedDirty
                                      ? $.git.submoduleDirty
                                      : $.git.submodule,
                                )}
                              </span>
                            )}
                          </button>
                          <RowActions
                            entry={entry}
                            side={side}
                            disabled={disabled}
                            onIndex={indexAction}
                            onDiscard={(paths, scope) => setDiscarding({ paths, scope })}
                            onFile={() => onFile(entry.path)}
                          />
                        </div>
                      ),
                    )}
                    {!entries.length && (
                      <p className="px-8 py-3 text-xs text-muted-foreground">
                        {t(($) => $.git.noChanges)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex min-h-10 shrink-0 items-center gap-1 border-t border-border px-3 text-xs text-muted-foreground">
              <span className="mr-auto">
                {value && (
                  <>
                    {value.entries.length
                      ? `${(value.offset + 1).toLocaleString(i18n.resolvedLanguage)}–${(value.offset + value.entries.length).toLocaleString(i18n.resolvedLanguage)}`
                      : "0"}{" "}
                    / {value.totalCount.toLocaleString(i18n.resolvedLanguage)}
                  </>
                )}
              </span>
              <IconButton
                label={t(($) => $.git.previousPage)}
                disabled={!value?.offset || state.busy}
                onClick={state.previous}
              >
                <ChevronLeft />
              </IconButton>
              <IconButton
                label={t(($) => $.git.nextPage)}
                disabled={value?.nextOffset === undefined || state.busy}
                onClick={state.next}
              >
                <ChevronRight />
              </IconButton>
            </div>
            <CommitBox
              target={actionTarget}
              actions={actions}
              status={value}
              disabled={disabled}
              mobile={mobile}
            />
          </aside>
        </ToolSidebar>
        {target ? (
          <DiffView
            key={JSON.stringify(target)}
            deviceId={device.id}
            workspaceId={workspace.id}
            repoId={repo.id}
            target={target}
            refreshKey={diffRefresh}
          />
        ) : (
          !mobile && (
            <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-muted-foreground">
              {t(($) => $.git.selectChange)}
            </div>
          )
        )}
      </div>
      {discarding && (
        <DiscardDialog
          target={actionTarget}
          {...discarding}
          actions={actions}
          onLocate={onLocate}
          onClose={() => setDiscarding(undefined)}
        />
      )}
      {branchStart && (
        <BranchDialog
          target={actionTarget}
          actions={actions}
          startOid={branchStart}
          onClose={() => setBranchStart(undefined)}
        />
      )}
    </>
  );
}
