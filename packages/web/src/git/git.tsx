import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderGit2,
  GitBranch,
  RefreshCw,
  Terminal,
} from "lucide-react";
import type { Device, DiscardScope, GitEntry, Repo, Workspace } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { useMobile } from "../lib/use-mobile";
import { apiError } from "../lib/api";
import { useCopyFeedback } from "../lib/use-copy-feedback";
import { useDrafts, type DraftStore } from "../files/drafts";
import { hasUnsavedDraft } from "./drafts";
import { showFile } from "../files/navigation";
import { type DiffTarget } from "./diff-view";
import { selectionOf, type ChangeSide } from "./selection";
import { useGitStatus } from "./use-status";
import { HistoryView, type HistorySelection } from "./history-view";
import { BranchesView } from "./branches-view";
import {
  currentRoute,
  isWorkspaceRoute,
  navigateWorkspace,
  updateWorkspaceQuery,
  useRoute,
} from "../lib/navigation";
import { childPath, parentPath } from "../files/paths";
import { type GitActions, useGitActivity } from "./actions";
import { confirmDiskVersion, DiscardDialog } from "./change-actions";
import { GitFeedback } from "./feedback";
import { CommitBox } from "./commit-box";
import { BranchDialog } from "./branch-dialog";
import { RemoteActions } from "./remote-actions";
import { OperationBar } from "./operation-bar";
import { GitViewHeader, type GitView } from "./view-header";
import type { useRepos } from "./use-repos";
import { ChangeSection } from "./change-section";
import { PageFooter } from "./page-footer";

interface GitLayout {
  view: GitView;
  changesOpen: boolean;
  readingView: "history" | "branches";
  readingOpen: boolean;
  ratio?: number;
}

export interface GitBrowseState {
  layout: GitLayout;
  history: HistorySelection;
}

export function GitTool({
  device,
  workspace,
  selected,
  visible,
  store,
  actions,
  onDiff,
  onTerminal,
  activeDiff,
  saved,
  repositories,
}: {
  device: Device;
  workspace: Workspace;
  selected: boolean;
  visible: boolean;
  store: DraftStore;
  actions: GitActions;
  onDiff(repo: Repo, target: DiffTarget): void;
  onTerminal(): void;
  activeDiff?: { repoId: string; target: DiffTarget };
  saved: Map<string, GitBrowseState>;
  repositories: ReturnType<typeof useRepos>;
}) {
  const { t } = useTranslation();

  const route = useRoute();
  const requestedRepo = route.query.repo;
  const enabled = device.status === "online";
  const { repos, scan, busy, error, discover } = repositories;
  const selectedRepoId = requestedRepo ?? repos.find((item) => item.available)?.id ?? repos[0]?.id;
  const repo = repos.find((item) => item.id === selectedRepoId);
  const activeRepoId = repo?.id;
  useEffect(() => {
    if (route.tool !== "git" || requestedRepo || !activeRepoId) return;
    const current = currentRoute();
    const target = { deviceId: device.id, workspaceId: workspace.id };
    if (current.tool === "git" && isWorkspaceRoute(current, target) && !current.query.repo)
      updateWorkspaceQuery(target, { repo: activeRepoId }, { replace: true });
  }, [route.tool, requestedRepo, activeRepoId, device.id, workspace.id]);
  function chooseRepo(id: string) {
    updateWorkspaceQuery({ deviceId: device.id, workspaceId: workspace.id }, { repo: id });
  }
  function openFile(path: string) {
    if (!repo) return;
    showFile({
      deviceId: device.id,
      workspaceId: workspace.id,
      path: childPath(repo.path, path),
    });
  }
  function locateFile(path: string) {
    if (!repo) return;
    const full = childPath(repo.path, path);
    navigateWorkspace({ deviceId: device.id, workspaceId: workspace.id }, "files", {
      folder: parentPath(full),
      reveal: full,
      file: undefined,
      draft: undefined,
      search: undefined,
    });
  }
  const repoLabel = (path: string) => (path === "." ? t(($) => $.git.workspaceRoot) : path);
  const scanComplete = !!scan?.complete && !error && !scan.issues.length;
  const picker = (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            className="min-w-0 max-w-full justify-start px-1 text-xs"
            title={repo ? repoLabel(repo.path) : undefined}
          />
        }
      >
        <FolderGit2 />
        <span className="min-w-0 truncate">
          {repo ? repoLabel(repo.path) : t(($) => $.git.repository)}
        </span>
        <ChevronDown />
      </MenuTrigger>
      <MenuContent>
        {repos.map((item) => (
          <MenuItem
            key={item.id}
            aria-current={item.id === repo?.id ? "true" : undefined}
            onClick={() => chooseRepo(item.id)}
          >
            <Check className={item.id === repo?.id ? "shrink-0" : "shrink-0 invisible"} />
            <span className="min-w-0 break-all">
              {item.available
                ? repoLabel(item.path)
                : t(($) => $.git.bareRepository, {
                    path: repoLabel(item.path),
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
    <div className={selected ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <div className="shrink-0">
        {!repo?.available && (
          <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-2 max-desk:min-h-11">
            {picker}
          </div>
        )}
        {!enabled && (
          <p role="status" className="border-b border-border px-4 py-2 text-xs">
            {t(($) => $.common.deviceOffline)}
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
                {item.path}: <ErrorNotice error={apiError(item.error, "failed")} />
              </div>
            ))}
          </div>
        )}
        {scan && !scan.complete && (
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-1 text-xs">
            <span>
              {enabled && busy ? t(($) => $.git.discovering) : t(($) => $.git.scanIncomplete)}
            </span>
            <Button variant="ghost" disabled={!enabled || busy} onClick={() => void discover()}>
              {t(($) => $.git.continueScan)}
            </Button>
          </div>
        )}
      </div>
      {repo?.available ? (
        <RepoView
          key={repo.id}
          {...{
            device,
            workspace,
            repo,
            visible,
            enabled,
            actions,
            store,
            picker,
            onDiff,
            onTerminal,
            saved,
          }}
          target={activeDiff?.repoId === repo.id ? activeDiff.target : undefined}
          onFile={openFile}
          onLocate={locateFile}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground">
          <p>
            {enabled && (busy || (!scan && !error))
              ? t(($) => $.git.discovering)
              : repo
                ? t(($) => $.git.bareUnsupported)
                : selectedRepoId
                  ? scanComplete
                    ? t(($) => $.git.repoMissing)
                    : t(($) => $.git.repoNotFoundYet)
                  : scanComplete
                    ? t(($) => $.git.noRepositories)
                    : t(($) => $.git.scanIncomplete)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!enabled || busy} onClick={() => void discover()}>
              <RefreshCw />
              {t(($) => $.git.discover)}
            </Button>
            <Button variant="outline" onClick={onTerminal}>
              <Terminal />
              {t(($) => $.git.useTerminal)}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RepoView({
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
  target,
  onDiff,
  onTerminal,
  saved,
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
  target?: DiffTarget;
  onDiff(repo: Repo, target: DiffTarget): void;
  onTerminal(): void;
  saved: Map<string, GitBrowseState>;
}) {
  const { t, i18n } = useTranslation();

  const mobile = useMobile();
  const state = useGitStatus(device.id, workspace.id, repo.id, visible && enabled);
  const [browsing] = useState(() => {
    const value = saved.get(repo.id) ?? {
      layout: {
        view: "changes" as const,
        changesOpen: true,
        readingView: "history" as const,
        readingOpen: true,
      },
      history: {},
    };
    saved.set(repo.id, value);
    return value;
  });
  const [layout, setLayout] = useState(browsing.layout);
  const split = useGroupRef();
  useLayoutEffect(() => {
    if (!mobile && layout.changesOpen && layout.readingOpen)
      split.current?.setLayout({
        "git-changes": layout.ratio ?? 60,
        "git-reading": 100 - (layout.ratio ?? 60),
      });
  }, [mobile, layout.changesOpen, layout.readingOpen, layout.ratio, split]);
  function updateLayout(next: GitLayout) {
    browsing.layout = next;
    setLayout(next);
  }
  const changesVisible = mobile ? layout.view === "changes" : layout.changesOpen;
  const historyVisible = mobile
    ? layout.view === "history"
    : layout.readingOpen && layout.readingView === "history";
  const branchesVisible = mobile
    ? layout.view === "branches"
    : layout.readingOpen && layout.readingView === "branches";
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [branchesRefresh, setBranchesRefresh] = useState(0);
  const selectTarget = (next: DiffTarget) => onDiff(repo, next);
  function selectView(view: GitView) {
    updateLayout({
      ...layout,
      view,
      ...(view === "changes" ? { changesOpen: true } : { readingView: view, readingOpen: true }),
    });
  }
  const { value, selected, setSelected } = state;
  const actionTarget = { deviceId: device.id, workspaceId: workspace.id, repoId: repo.id };
  const activity = useGitActivity(actions, actionTarget);
  const [discarding, setDiscarding] = useState<{ paths: string[]; scope: DiscardScope }>();
  const [branchStart, setBranchStart] = useState<string>();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const drafts = useDrafts(store);
  const disabled = !enabled || !!activity.request;
  const { load } = state;
  useEffect(() => {
    if (visible && enabled && activity.revision)
      void load(undefined, undefined, undefined, false, true);
  }, [activity.revision, visible, enabled, load]);
  async function indexAction(paths: string[], kind: "stage" | "unstage") {
    if (kind === "stage" && !confirmDiskVersion(store, actionTarget, repo.path, paths)) return;
    const params = { paths: [...new Set(paths)] };
    const consumed = selected.filter(
      (item) =>
        paths.includes(item.path) &&
        (kind === "unstage" ? item.side === "staged" : item.side !== "staged"),
    );
    const result = await actions.run(
      actionTarget,
      kind === "stage" ? "git.stage" : "git.unstage",
      params,
    );
    if (result) state.consume(consumed);
  }
  function refreshView(view: GitView) {
    void state.load();
    if (view === "history") setHistoryRefresh((value) => value + 1);
    if (view === "branches") setBranchesRefresh((value) => value + 1);
  }
  const createBranch =
    value?.head.oid && !disabled ? () => setBranchStart(value.head.oid!) : undefined;
  const select = (entry: GitEntry, side: ChangeSide) => {
    if (entry.path === undefined) return;
    const item = selectionOf(entry, side);
    setSelected((old) =>
      old.some((x) => x.path === item.path && x.side === side)
        ? old.filter((x) => x.path !== item.path || x.side !== side)
        : [...old, item],
    );
  };
  const branchLabel =
    value?.branch ?? (value?.head.oid ? value.head.oid.slice(0, 8) : t(($) => $.common.git));
  const counts = (
    <>
      {!!value?.ahead && (
        <span className="shrink-0 text-xs">
          ↑{value.ahead.toLocaleString(i18n.resolvedLanguage)}
        </span>
      )}
      {!!value?.behind && (
        <span className="shrink-0 text-xs">
          ↓{value.behind.toLocaleString(i18n.resolvedLanguage)}
        </span>
      )}
    </>
  );
  return (
    <>
      <div className="shrink-0">
        <div className="flex min-h-10 shrink-0 items-center border-b border-border px-2 max-desk:min-h-11">
          {picker}
        </div>
        <div className="grid min-h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 border-b border-border px-2 max-desk:min-h-11">
          <button
            className="flex min-h-8 min-w-0 flex-col items-start justify-center text-xs max-desk:min-h-11"
            title={[value?.branch, value?.upstream, value?.head.oid].filter(Boolean).join(" · ")}
            onClick={() => selectView("branches")}
          >
            <>
              <span className="flex w-full min-w-0 items-center gap-2 leading-4">
                <GitBranch size={15} className="shrink-0" />
                <span className="min-w-0 truncate">{branchLabel}</span>
              </span>
              {(value?.upstream || value?.ahead || value?.behind) && (
                <span className="flex w-full min-w-0 items-center gap-2 leading-4">
                  {value?.upstream && <span className="min-w-0 truncate">{value.upstream}</span>}
                  {counts}
                </span>
              )}
            </>
          </button>
          <RemoteActions
            target={actionTarget}
            actions={actions}
            active={visible && enabled}
            head={value?.head}
          />
        </div>
        {mobile && (
          <GitViewHeader
            view={layout.view}
            count={value?.totalCount}
            disabled={!enabled}
            onView={selectView}
            onRefresh={() => refreshView(layout.view)}
            onCreateBranch={layout.view === "branches" ? createBranch : undefined}
          />
        )}
        {!!(state.error || state.notice.length) && (
          <div
            role={state.error ? "alert" : "status"}
            className={`border-b border-border px-4 py-2 text-xs ${state.error ? "text-destructive" : "text-muted-foreground"}`}
          >
            {state.error ? (
              <ErrorNotice error={state.error} />
            ) : (
              t(($) => $.git.selectionCleared, { count: state.notice.length })
            )}
          </div>
        )}
        <GitFeedback
          actions={actions}
          target={actionTarget}
          onLocate={onLocate}
          onTerminal={() => setTerminalOpen(true)}
        />
        {value?.operation && (
          <OperationBar
            operation={value.operation}
            target={actionTarget}
            actions={actions}
            disabled={!enabled}
            onTerminal={() => setTerminalOpen(true)}
          />
        )}
      </div>
      <Group
        groupRef={split}
        orientation="vertical"
        disabled={mobile || !layout.changesOpen || !layout.readingOpen}
        className="git-panes min-h-0 flex-1"
        data-mobile={mobile}
        style={
          !mobile && !layout.changesOpen && !layout.readingOpen
            ? { flex: "none", height: 74 }
            : undefined
        }
        onLayoutChanged={(sizes, meta) => {
          if (meta.isUserInteraction && !mobile && layout.changesOpen && layout.readingOpen)
            updateLayout({ ...layout, ratio: sizes["git-changes"] });
        }}
      >
        <Panel
          id="git-changes"
          defaultSize={`${layout.ratio ?? 60}%`}
          minSize={mobile ? 0 : layout.changesOpen ? 96 : 37}
          maxSize={mobile || layout.changesOpen ? "100%" : 37}
          className="flex min-h-0 flex-col"
        >
          <section
            aria-label={t(($) => $.git.changes)}
            className={mobile && !changesVisible ? "hidden" : "flex min-h-0 flex-1 flex-col"}
          >
            {!mobile && (
              <div className="flex min-h-9 shrink-0 items-center border-b border-border bg-muted px-2 text-xs">
                <button
                  className="flex min-h-9 min-w-0 flex-1 items-center gap-1 text-left"
                  aria-expanded={layout.changesOpen}
                  aria-label={t(
                    ($) => (layout.changesOpen ? $.common.collapseNamed : $.common.expandNamed),
                    { name: t(($) => $.git.changes) },
                  )}
                  onClick={() =>
                    updateLayout({ ...layout, view: "changes", changesOpen: !layout.changesOpen })
                  }
                >
                  <span className="flex size-8 shrink-0 items-center justify-center">
                    {layout.changesOpen ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </span>
                  {t(($) => $.git.changes)}
                  {value?.totalCount !== undefined && (
                    <span className="text-muted-foreground">
                      {value.totalCount.toLocaleString(i18n.resolvedLanguage)}
                    </span>
                  )}
                </button>
                {layout.changesOpen && (
                  <IconButton
                    label={t(($) => $.git.refresh)}
                    disabled={!enabled}
                    onClick={() => refreshView("changes")}
                  >
                    <RefreshCw />
                  </IconButton>
                )}
              </div>
            )}
            <div className={changesVisible ? "flex min-h-0 flex-1" : "hidden"}>
              <aside
                className="flex min-h-0 w-full flex-1 flex-col"
                aria-label={t(($) => $.git.changeList)}
              >
                <div className="scroll-area min-h-0 flex-1 overflow-auto">
                  {!value && state.busy && (
                    <p role="status" className="px-4 py-3 text-xs text-muted-foreground">
                      {t(($) => $.common.reading)}
                    </p>
                  )}
                  {value &&
                    (["conflict", "staged", "worktree"] as const).map((side) => (
                      <ChangeSection
                        key={side}
                        status={value}
                        side={side}
                        selected={selected}
                        target={target}
                        disabled={disabled}
                        hasUnsavedDraft={(path) =>
                          hasUnsavedDraft(drafts, actionTarget, repo.path, [path])
                        }
                        onSelect={select}
                        onIndex={indexAction}
                        onDiscard={(paths, scope) => setDiscarding({ paths, scope })}
                        onFile={onFile}
                        onTarget={selectTarget}
                      />
                    ))}
                </div>
                {(!!value?.offset || value?.nextOffset !== undefined) && (
                  <PageFooter
                    summary={
                      value && (
                        <>
                          {value.entries.length
                            ? `${(value.offset + 1).toLocaleString(i18n.resolvedLanguage)}–${(value.offset + value.entries.length).toLocaleString(i18n.resolvedLanguage)}`
                            : "0"}{" "}
                          / {value.totalCount.toLocaleString(i18n.resolvedLanguage)}
                        </>
                      )
                    }
                    previousLabel={t(($) => $.git.previousPage)}
                    previousDisabled={!value?.offset || state.busy}
                    onPrevious={state.previous}
                    nextLabel={t(($) => $.git.nextPage)}
                    nextDisabled={value?.nextOffset === undefined || state.busy}
                    onNext={state.next}
                  />
                )}
                <CommitBox
                  target={actionTarget}
                  actions={actions}
                  status={value}
                  mobile={mobile}
                  repoPath={repo.path}
                  offline={!enabled}
                  writing={!!activity.request}
                  reading={state.busy}
                />
              </aside>
            </div>
          </section>
        </Panel>
        <Separator
          className="split-divider git-divider"
          hidden={mobile || !layout.changesOpen || !layout.readingOpen}
          aria-label={t(($) => $.git.resizeViews)}
        />
        <Panel
          id="git-reading"
          defaultSize={`${100 - (layout.ratio ?? 60)}%`}
          minSize={mobile ? 0 : layout.readingOpen ? 96 : 37}
          maxSize={mobile || layout.readingOpen ? "100%" : 37}
          className="flex min-h-0 flex-col"
        >
          <section
            aria-label={t(($) => $.git.views)}
            className={
              mobile && layout.view === "changes" ? "hidden" : "flex min-h-0 flex-1 flex-col"
            }
          >
            {!mobile && (
              <GitViewHeader
                views={["history", "branches"]}
                view={layout.readingView}
                disabled={!enabled}
                onView={selectView}
                open={layout.readingOpen}
                onToggle={() => updateLayout({ ...layout, readingOpen: !layout.readingOpen })}
                onRefresh={() => refreshView(layout.readingView)}
                onCreateBranch={layout.readingView === "branches" ? createBranch : undefined}
              />
            )}
            <div className={historyVisible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              <HistoryView
                deviceId={device.id}
                workspaceId={workspace.id}
                repoId={repo.id}
                active={visible && enabled && historyVisible}
                visible={visible && historyVisible}
                refreshKey={historyRefresh}
                headOid={value?.head.oid}
                target={target}
                onTarget={selectTarget}
                selection={browsing.history}
                onBranch={(oid) => {
                  if (!disabled) setBranchStart(oid);
                }}
              />
            </div>
            <div className={branchesVisible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              <BranchesView
                deviceId={device.id}
                workspaceId={workspace.id}
                repoId={repo.id}
                active={visible && enabled && branchesVisible}
                actions={actions}
                refreshKey={branchesRefresh}
              />
            </div>
          </section>
        </Panel>
      </Group>
      {discarding && (
        <DiscardDialog
          target={actionTarget}
          {...discarding}
          onDiscard={(review) => {
            const scope = discarding.scope;
            const consumed = selected.filter(
              (item) =>
                review.paths.includes(item.path) && (scope === "all" || item.side === "worktree"),
            );
            void actions
              .run(actionTarget, "git.discard", {
                paths: review.paths,
                scope,
                reviewToken: review.reviewToken,
              })
              .then((result) => {
                if (result) state.consume(consumed);
              });
          }}
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
      <Dialog open={terminalOpen} onOpenChange={setTerminalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.common.terminal)}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-auto p-5">
            <RepoTerminalTarget {...{ device, workspace, repo }} />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t(($) => $.common.cancel)}
            </DialogClose>
            <Button
              onClick={() => {
                setTerminalOpen(false);
                onTerminal();
              }}
            >
              {t(($) => $.git.openWorkspaceTerminal)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RepoTerminalTarget({
  device,
  workspace,
  repo,
}: {
  device: Device;
  workspace: Workspace;
  repo: Repo;
}) {
  const { t } = useTranslation();
  const { copy, copied, error, pending } = useCopyFeedback();
  return (
    <div className="space-y-2 text-xs">
      <p className="break-all text-muted-foreground">
        {device.name} · {workspace.name}
      </p>
      <p className="break-all">
        {t(($) => $.git.terminalTarget, {
          path: repo.path === "." ? t(($) => $.git.workspaceRoot) : repo.path,
        })}
      </p>
      <p className="select-text break-all font-mono whitespace-pre-wrap">{repo.rootPath}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={pending} onClick={() => void copy(repo.rootPath)}>
          <Copy />
          {t(($) => $.git.copyRepositoryPath)}
        </Button>
        {copied === repo.rootPath && (
          <span role="status" className="text-muted-foreground">
            {t(($) => $.common.copied)}
          </span>
        )}
      </div>
      {error?.id === repo.rootPath && (
        <div role="alert">
          <ErrorNotice error={error.error} />
        </div>
      )}
    </div>
  );
}
