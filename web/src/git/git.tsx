import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FolderGit2, GitBranch, RefreshCw } from "lucide-react";
import type { Device, DiscardScope, GitEntry, Repo, Workspace } from "@kiteline/shared/protocol";
import { ToolHeader, ToolSidebar } from "../components/tool-layout";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { ApiError } from "../lib/api";
import { useMobile } from "../lib/use-mobile";
import type { DraftStore } from "../files/drafts";
import { showFile } from "../files/navigation";
import { DiffView, type DiffTarget } from "./diff-view";
import { selectionOf, type ChangeSide } from "./selection";
import { useGitStatus } from "./use-status";
import { HistoryView } from "./history-view";
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
import { useRepos } from "./use-repos";
import { ChangeSection } from "./change-section";
import { PageFooter } from "./page-footer";

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
  const enabled = device.status === "online";
  const { repos, scan, busy, error, discover } = useRepos(device.id, workspace.id, enabled);
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
        <RepoView
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
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-xs max-desk:min-h-11"
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
            className="flex min-h-0 w-full flex-col border-border desk:w-80 desk:shrink-0 desk:border-r"
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
                    onSelect={select}
                    onIndex={indexAction}
                    onDiscard={(paths, scope) => setDiscarding({ paths, scope })}
                    onFile={onFile}
                    onTarget={selectTarget}
                  />
                ))}
            </div>
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
