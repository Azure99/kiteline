import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { errorMessage, rpc } from "../lib/api";
import { useMobile } from "../lib/use-mobile";
import { showDraft, type DraftStore } from "../files/drafts";
import { DiffView, type DiffTarget } from "./diff-view";
import { inSide, selectionOf, type ChangeSide } from "./selection";
import { useGitStatus } from "./use-status";
import { HistoryView } from "./history-view";
import { BranchesView } from "./branches-view";
import { ApiError } from "../lib/api";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";
import { navigate, useRoute, workspacePath } from "../lib/navigation";
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
  const route = useRoute();
  const requestedRepo = route.tool === "git" ? route.query.get("repo") : null;
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState<string | undefined>(requestedRepo ?? undefined);
  useEffect(() => {
    if (requestedRepo) setRepoId(requestedRepo);
  }, [requestedRepo]);
  const [scan, setScan] = useState<RepoDiscovery>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
    setError("");
    try {
      const read = (scanCursor?: string) =>
        rpc(
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
      if (controller.signal.aborted) return;
      scanCursor.current = found.scanCursor;
      for (const repo of found.repos) scanned.current.set(repo.id, repo);
      setRepos((old) => {
        const entries = new Map((found.complete ? [] : old).map((item) => [item.id, item]));
        for (const repo of scanned.current.values()) entries.set(repo.id, repo);
        const next = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
        setRepoId((selected) => selected ?? next.find((item) => item.available)?.id ?? next[0]?.id);
        return next;
      });
      setScan(found);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof ApiError && error.code === "conflict") scanCursor.current = undefined;
        setError(errorMessage(error));
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
      scanCursor.current = undefined;
    };
  }, [enabled, discover]);
  useWorkspaceRefresh(device.id, workspace.id, enabled, "repos", discover);
  const selectedRepoId = requestedRepo ?? repoId;
  const repo = repos.find((item) => item.id === selectedRepoId);
  const activeRepoId = repo?.id;
  useEffect(() => {
    if (route.tool !== "git" || requestedRepo || !activeRepoId) return;
    const query = new URLSearchParams(location.search);
    query.set("repo", activeRepoId);
    navigate(location.pathname + `?${query}`, true);
  }, [route.tool, requestedRepo, activeRepoId]);
  function chooseRepo(id: string) {
    setRepoId(id);
    const query = new URLSearchParams(location.search);
    query.set("repo", id);
    navigate(location.pathname + `?${query}`);
  }
  function openFile(path: string) {
    if (!repo) return;
    showDraft(
      store.open({
        deviceId: device.id,
        workspaceId: workspace.id,
        deviceName: device.name,
        workspaceName: workspace.name,
        path: repo.path === "." ? path : `${repo.path}/${path}`,
      }),
    );
  }
  function locateFile(path: string) {
    if (!repo) return;
    const full = repo.path === "." ? path : `${repo.path}/${path}`;
    navigate(
      workspacePath(device.id, workspace.id, "files") +
        "?" +
        new URLSearchParams({ folder: parentPath(full), reveal: full }),
    );
  }
  const picker = (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" className="min-w-0 max-w-[55%] shrink" />}>
        <FolderGit2 />
        <span className="min-w-0 truncate">
          {repo?.path === "." ? workspace.name : (repo?.path ?? "仓库")}
        </span>
        <ChevronDown />
      </MenuTrigger>
      <MenuContent>
        {repos.map((item) => (
          <MenuItem key={item.id} onClick={() => chooseRepo(item.id)}>
            <span className="min-w-0 break-all">
              {item.path === "." ? workspace.name : item.path}
              {item.linked ? " · worktree" : ""}
              {!item.available ? " · 裸仓库" : ""}
            </span>
          </MenuItem>
        ))}
        <MenuItem disabled={!enabled || busy} onClick={() => void discover()}>
          <RefreshCw />
          重新发现仓库
        </MenuItem>
      </MenuContent>
    </Menu>
  );
  return (
    <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {!repo?.available && (
        <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          {picker}
        </div>
      )}
      {!enabled && (
        <p role="status" className="border-b border-border px-4 py-2 text-xs">
          设备{device.status === "revoked" ? "已撤销" : "离线"}
        </p>
      )}
      {(!!error || !!scan?.issues.length) && (
        <div className="max-h-36 shrink-0 overflow-auto border-b border-border px-4 py-2 text-xs text-destructive">
          {error && <p role="alert">{error}</p>}
          {scan?.issues.map((item, i) => (
            <p key={i} className="break-all">
              {item.path}：{item.error.message}
            </p>
          ))}
        </div>
      )}
      {scan && !scan.complete && (
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-1 text-xs">
          <span>仓库扫描未完成</span>
          <Button variant="ghost" disabled={!enabled || busy} onClick={() => void discover()}>
            继续扫描
          </Button>
        </div>
      )}
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
            ? "正在发现仓库"
            : repo
              ? "裸仓库不支持工作树操作"
              : selectedRepoId
                ? scan?.complete
                  ? "所选仓库不存在或已不可用"
                  : "尚未发现所选仓库"
                : "没有发现 Git 仓库"}
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
  const mobile = useMobile();
  const state = useGitStatus(device.id, workspace.id, repo.id, visible && enabled);
  const [target, setTarget] = useState<DiffTarget>();
  const [view, setView] = useState<"changes" | "history" | "branches">("changes");
  const { value, selected, setSelected } = state;
  const actionTarget = { deviceId: device.id, workspaceId: workspace.id, repoId: repo.id };
  const activity = useGitActivity(actions, actionTarget);
  const [discarding, setDiscarding] = useState<{ paths: string[]; scope: DiscardScope }>();
  const [branchStart, setBranchStart] = useState<string>();
  const disabled = !enabled || !!activity.request;
  const { load } = state;
  useEffect(() => {
    if (visible && enabled && activity.revision) void load();
  }, [activity.revision, visible, enabled, load]);
  function indexAction(paths: string[], kind: "stage" | "unstage") {
    if (kind === "stage" && !confirmDiskVersion(store, actionTarget, repo.path, paths)) return;
    const params = { paths: [...new Set(paths)] };
    if (kind === "stage") void actions.run(actionTarget, "git.stage", params, "暂存");
    else void actions.run(actionTarget, "git.unstage", params, "取消暂存");
  }
  const select = (entry: GitEntry, side: ChangeSide) => {
    const item = selectionOf(entry, side);
    setSelected((old) =>
      old.some((x) => x.path === item.path && x.side === side)
        ? old.filter((x) => x.path !== item.path || x.side !== side)
        : [...old, item],
    );
  };
  return (
    <>
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        {picker}
        <button
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-xs max-[959px]:min-h-11"
          title={value?.head.oid ?? undefined}
          onClick={() => setView("branches")}
        >
          <GitBranch size={15} className="shrink-0" />
          <span className="truncate">
            {value?.branch ?? (value?.head.oid ? value.head.oid.slice(0, 8) : "Git")}
            {value?.upstream ? ` · ${value.upstream}` : ""}
          </span>
        </button>
        {!!value?.ahead && <span className="text-xs">↑{value.ahead}</span>}
        {!!value?.behind && <span className="text-xs">↓{value.behind}</span>}
        <RemoteActions
          target={actionTarget}
          actions={actions}
          active={visible && enabled}
          head={value?.head}
        />
      </div>
      <div
        role="tablist"
        aria-label="Git 视图"
        className="flex min-h-9 shrink-0 items-center gap-4 border-b border-border px-4 text-xs"
      >
        {(
          [
            ["changes", "变化"],
            ["history", "历史"],
            ["branches", "分支"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={`flex min-h-9 items-center justify-center gap-2 border-b-2 px-1 max-[959px]:min-h-11 max-[959px]:min-w-11 ${view === id ? "border-primary text-primary" : "border-transparent"}`}
          >
            {label}
            {id === "changes" && (
              <span className="rounded bg-muted px-1.5">{value?.totalCount ?? 0}</span>
            )}
          </button>
        ))}
        <span className="ml-auto hidden text-muted-foreground min-[960px]:block">
          {state.busy ? "正在读取" : ""}
        </span>
        <IconButton
          label="刷新 Git 状态"
          disabled={!enabled || state.busy}
          onClick={() => void state.load()}
        >
          <RefreshCw />
        </IconButton>
      </div>
      {(state.error || state.notice) && (
        <p
          role={state.error ? "alert" : "status"}
          className="border-b border-border px-4 py-2 text-xs text-destructive"
        >
          {state.error || state.notice}
        </p>
      )}
      <GitFeedback
        actions={actions}
        target={actionTarget}
        onLocate={onLocate}
        onTerminal={() => navigate(workspacePath(device.id, workspace.id))}
      />
      {value?.operation && (
        <OperationBar
          operation={value.operation}
          target={actionTarget}
          actions={actions}
          disabled={!enabled}
          onTerminal={() => navigate(workspacePath(device.id, workspace.id))}
        />
      )}
      {view === "history" && (
        <HistoryView
          deviceId={device.id}
          workspaceId={workspace.id}
          repoId={repo.id}
          active={visible && enabled}
          onFile={onFile}
          onBranch={(oid) => {
            if (!disabled) setBranchStart(oid);
          }}
        />
      )}
      {view === "branches" && (
        <BranchesView
          deviceId={device.id}
          workspaceId={workspace.id}
          repoId={repo.id}
          active={visible && enabled}
          actions={actions}
          headOid={value?.head.oid}
        />
      )}
      <div className={view === "changes" ? "flex min-h-0 flex-1" : "hidden"}>
        {(!mobile || !target) && (
          <aside
            className="flex min-h-0 w-full flex-col border-border min-[960px]:w-80 min-[960px]:shrink-0 min-[960px]:border-r"
            aria-label="Git 变化列表"
          >
            <div className="scroll-area min-h-0 flex-1 overflow-auto">
              {(
                [
                  ["conflict", "冲突"],
                  ["staged", "暂存的更改"],
                  ["worktree", "更改"],
                ] as const
              ).map(([side, label]) => {
                const entries = value?.entries.filter((entry) => inSide(entry, side)) ?? [];
                const chosen = entries.filter((entry) =>
                  selected.some((item) => item.path === entry.path && item.side === side),
                );
                if (side === "conflict" && !entries.length) return null;
                return (
                  <div key={side}>
                    <div className="flex items-center gap-2 bg-muted/65 px-3 py-2 text-xs">
                      <ChevronDown size={13} />
                      {label}
                      <span className="ml-auto">
                        {side === "staged" ? (value?.stagedCount ?? 0) : entries.length}
                      </span>
                      {!!chosen.length && (
                        <>
                          <IconButton
                            label={side === "staged" ? "取消暂存所选文件" : "暂存所选文件"}
                            disabled={
                              disabled ||
                              (side !== "staged" && chosen.some((entry) => !stageable(entry)))
                            }
                            onClick={() =>
                              indexAction(
                                chosen.flatMap((entry) =>
                                  side === "staged" && entry.oldPath
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
                                ? "丢弃所选文件全部更改"
                                : "丢弃所选文件未暂存更改"
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
                    {entries.map((entry) => (
                      <div
                        key={entry.path}
                        className={`flex min-h-11 items-center gap-2 border-b border-border/50 px-3 ${target?.path === entry.path && (target.side === side || side === "conflict") ? "bg-primary-soft" : ""}`}
                      >
                        <label className="flex min-h-11 items-center justify-center max-[959px]:min-w-11">
                          <input
                            type="checkbox"
                            aria-label={`选择${label} ${entry.path}`}
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
                              : setTarget({
                                  path: entry.path,
                                  oldPath: entry.oldPath,
                                  side: side === "staged" ? "staged" : "worktree",
                                })
                          }
                          className="min-h-11 min-w-0 flex-1 py-2 text-left text-xs"
                        >
                          <span className="block truncate">
                            {entry.path.split("/").at(-1) || entry.path}
                          </span>
                          {entry.path.includes("/") && (
                            <span className="block truncate text-[10px] text-muted-foreground">
                              {entry.path}
                            </span>
                          )}
                          {entry.submodule && (
                            <span className="block text-[10px] text-muted-foreground">
                              子模块{entry.submodule.commitChanged ? " · 指针变化" : ""}
                              {entry.submodule.trackedDirty || entry.submodule.untrackedDirty
                                ? " · 内部修改"
                                : ""}
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
                    ))}
                    {!entries.length && (
                      <p className="px-8 py-3 text-xs text-muted-foreground">暂无更改</p>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex min-h-10 shrink-0 items-center gap-1 border-t border-border px-3 text-xs text-muted-foreground">
              <span className="mr-auto">
                {value?.entries.length
                  ? `${value.offset + 1}–${value.offset + value.entries.length}`
                  : "0"}{" "}
                / {value?.totalCount ?? 0}
              </span>
              <IconButton
                label="Git 上一页"
                disabled={!value?.offset || state.busy}
                onClick={state.previous}
              >
                <ChevronLeft />
              </IconButton>
              <IconButton
                label="Git 下一页"
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
        )}
        {target ? (
          <DiffView
            key={JSON.stringify(target)}
            deviceId={device.id}
            workspaceId={workspace.id}
            repoId={repo.id}
            target={target}
            refreshKey={value}
            onBack={() => setTarget(undefined)}
            onFile={() => onFile(target.path)}
          />
        ) : (
          !mobile && (
            <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-muted-foreground">
              选择变化
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
