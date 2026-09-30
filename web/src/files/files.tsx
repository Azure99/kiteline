import { useTranslation } from "react-i18next";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  FilePlus2,
  FolderPlus,
  ListChecks,
  MoreHorizontal,
  PanelLeft,
  RefreshCw,
  Copy,
  FolderInput,
  Trash2,
  Upload,
  Download,
  Search,
} from "lucide-react";
import type { Device, Entry, Workspace } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { ErrorNotice } from "../components/error-notice";
import { rpc } from "../lib/api";
import { ToolHeader, ToolSidebar } from "../components/tool-layout";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { useMobile } from "../lib/use-mobile";
import {
  currentPath,
  currentRoute,
  isWorkspaceRoute,
  updateWorkspaceQuery,
  useRoute,
  type WorkspaceQuery,
} from "../lib/navigation";
import { FileExplorer } from "./explorer";
import { FileDetails } from "./file-details";
import { FileCleanupNotice } from "./cleanup-notice";
import { FileNameDialog, type NameAction } from "./name-dialog";
import { isWithin, movedPath, parentPath, useFileBrowser } from "./use-browser";
import { DraftView } from "./draft-view";
import { useDrafts, type Draft, type DraftStore } from "./drafts";
import { showDraft, showFile } from "./navigation";
import type { FileAction, FileOperationResult } from "./operation-dialog";
import { FileContent } from "./file-content";
import { downloadFile, type FileTarget } from "./content";
import { FileSearch } from "./search-view";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";

export function Files({
  device,
  workspace,
  visible,
  store,
  onUpload,
  onOperation,
}: {
  device: Device;
  workspace: Workspace;
  visible: boolean;
  store: DraftStore;
  onUpload: (files: File[], folder: string) => void;
  onOperation: (action: FileAction, folder: string) => void;
}) {
  const { t, i18n } = useTranslation();

  const route = useRoute();
  const mobile = useMobile();
  const folder = route.query.folder ?? ".";
  const reveal = route.query.reveal;
  const [revealError, setRevealError] = useState<unknown>();
  const [expanded, setExpanded] = useState(new Set(["."]));
  const [selected, setSelected] = useState(new Set<string>());
  const [selecting, setSelecting] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [action, setAction] = useState<NameAction & { origin: string }>();
  const [details, setDetails] = useState<Entry>();
  const [notice, setNotice] = useState<
    { kind: "downloadStarted"; path: string } | { kind: "renamed" | "created" }
  >();
  const fileInput = useRef<HTMLInputElement>(null);
  const enabled = device.status === "online";
  const { pages, load, forget } = useFileBrowser(device.id, workspace.id, visible && enabled);
  const queryFile = route.query.file;
  const queryDraft = route.query.draft;
  const [location, setLocation] = useState<{ path: string; position: Draft["location"] }>();
  const searching = route.query.search === true;
  const drafts = useDrafts(store).filter(
    (item) => item.deviceId === device.id && item.workspaceId === workspace.id,
  );
  const draft =
    drafts.find((item) => item.id === queryDraft) ?? drafts.find((item) => item.path === queryFile);
  useWorkspaceRefresh(device.id, workspace.id, visible && enabled, "files", async (signal) => {
    await refresh(signal, true);
    if (draft && !signal.aborted) await store.observe(draft, signal);
  });
  useEffect(() => {
    if (location && (!visible || searching || queryFile !== location.path)) {
      setLocation(undefined);
      return;
    }
    if (!visible || searching || !draft) return;
    if (location?.path === draft.path) {
      draft.location = location.position;
      store.changed();
      setLocation(undefined);
    }
    if (queryDraft !== draft.id) showDraft(draft, true);
  }, [visible, searching, draft, queryFile, queryDraft, location, store]);
  useEffect(() => {
    if (!visible || !enabled || folder === ".") return;
    const deviceTarget = { deviceId: device.id, workspaceId: workspace.id };
    let active = true;
    void load(folder).then((listing) => {
      if (!active || !listing || listing.path === folder) return;
      setExpanded((old) => new Set([...old].map((path) => movedPath(path, folder, listing.path))));
      const current = currentRoute();
      if (
        current.tool === "files" &&
        isWorkspaceRoute(current, deviceTarget) &&
        current.query.folder === folder
      )
        updateWorkspaceQuery(deviceTarget, { folder: listing.path }, true);
    });
    return () => {
      active = false;
    };
  }, [visible, enabled, folder, load, device.id, workspace.id]);
  useEffect(() => {
    setRevealError(undefined);
    if (!visible || !enabled || !reveal || device.environment?.os !== "macos") return;
    const controller = new AbortController();
    const target = { deviceId: device.id, workspaceId: workspace.id };
    void rpc(
      device.id,
      "files.inspect",
      { workspaceId: workspace.id, path: reveal },
      controller.signal,
    )
      .then(({ entry }) => {
        const current = currentRoute();
        if (
          controller.signal.aborted ||
          !entry.path ||
          entry.path === reveal ||
          !isWorkspaceRoute(current, target) ||
          current.tool !== "files" ||
          current.query.reveal !== reveal
        )
          return;
        updateWorkspaceQuery(target, { reveal: entry.path, folder: parentPath(entry.path) }, true);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setRevealError(error);
      });
    return () => controller.abort();
  }, [visible, enabled, reveal, device.id, device.environment?.os, workspace.id]);
  useEffect(() => {
    if (visible && reveal) setListOpen(true);
  }, [visible, reveal]);
  useEffect(() => {
    const written = (event: Event) => {
      const target = (event as CustomEvent<{ deviceId: string; workspaceId: string; path: string }>)
        .detail;
      if (target.deviceId === device.id && target.workspaceId === workspace.id)
        void load(parentPath(target.path));
    };
    window.addEventListener("kiteline:file-written", written);
    const downloaded = (event: Event) => {
      const target = (event as CustomEvent<FileTarget>).detail;
      if (target.deviceId === device.id && target.workspaceId === workspace.id)
        setNotice({ kind: "downloadStarted", path: target.path });
    };
    window.addEventListener("kiteline:download", downloaded);
    return () => {
      window.removeEventListener("kiteline:file-written", written);
      window.removeEventListener("kiteline:download", downloaded);
    };
  }, [device.id, workspace.id, load]);
  const target = { deviceId: device.id, workspaceId: workspace.id };
  function updateQuery(query: WorkspaceQuery, replace = false) {
    updateWorkspaceQuery(target, query, replace);
  }
  function beginAction(action: NameAction) {
    setAction({ ...action, origin: currentPath() });
  }
  function setFilePath(path?: string) {
    updateQuery({ file: path, draft: undefined });
  }
  function enter(path: string) {
    setSelected(new Set());
    updateQuery({
      folder: path,
      ...(mobile ? { file: undefined, draft: undefined } : {}),
    });
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(path) && !mobile && path !== ".") next.delete(path);
      else next.add(path);
      return next;
    });
    if (folder === path || path === ".") void load(path);
  }
  function open(entry: Entry) {
    setNotice(undefined);
    setLocation(undefined);
    showFile({ ...target, path: entry.path! });
  }
  function download(path: string) {
    downloadFile({ deviceId: device.id, workspaceId: workspace.id, path });
  }
  async function refresh(signal?: AbortSignal, background = false) {
    for (const path of new Set(mobile ? [folder] : [folder, ...expanded])) {
      if (signal?.aborted) return;
      await load(path, false, background);
    }
  }
  function moveViewPaths(moves: { from: string; to: string }[]) {
    if (!moves.length) return;
    const nextPath = (path: string) =>
      moves.reduce((next, move) => movedPath(next, move.from, move.to), path);
    for (const { from } of moves) forget(from);
    const query = currentRoute().query;
    updateQuery(
      {
        folder: nextPath(query.folder ?? "."),
        file: query.file ? nextPath(query.file) : undefined,
        reveal: query.reveal ? nextPath(query.reveal) : undefined,
      },
      true,
    );
    const next = new Set([...expanded].map(nextPath));
    setExpanded(next);
    for (const path of next) if (!expanded.has(path)) void load(path);
  }
  const operated = useEffectEvent((event: Event) => {
    const { deviceId, workspaceId, kind, items } = (event as CustomEvent<FileOperationResult>)
      .detail;
    const route = currentRoute();
    if (deviceId !== device.id || workspaceId !== workspace.id || !isWorkspaceRoute(route, target))
      return;
    const completed = items.filter((item) => item.outcome === "succeeded");
    if (kind === "move")
      moveViewPaths(completed.map((item) => ({ from: item.path, to: item.targetPath! })));
    if (kind === "delete") {
      let folder = route.query.folder ?? ".";
      for (const item of completed) {
        forget(item.path);
        if (isWithin(folder, item.path)) folder = parentPath(item.path);
      }
      updateQuery({ folder }, true);
    }
    const affected = new Set<string>();
    for (const item of items) {
      affected.add(parentPath(item.path));
      if (item.targetPath) affected.add(parentPath(item.targetPath));
      if (kind !== "copy" && item.outcome !== "succeeded")
        for (const path of mobile ? [folder] : expanded)
          if (isWithin(path, item.path)) affected.add(path);
    }
    for (const path of affected) void load(path);
    setSelected(new Set());
  });
  useEffect(() => {
    window.addEventListener("kiteline:files-operated", operated);
    return () => window.removeEventListener("kiteline:files-operated", operated);
  }, []);
  function selectedAction(kind: FileAction["kind"]) {
    const entries = new Map(
      Object.values(pages)
        .flatMap((page) => page.listing?.entries.items ?? [])
        .map((entry) => [entry.path, entry]),
    );
    const paths = [...selected].filter(
      (path) =>
        ![...selected].some(
          (other) =>
            other !== path && entries.get(other)?.kind === "directory" && isWithin(path, other),
        ),
    );
    const chosen = paths.flatMap((path) => (entries.get(path) ? [entries.get(path)!] : []));
    if (chosen.length) onOperation({ kind, entries: chosen }, folder);
  }
  return (
    <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <FileSearch
        deviceId={device.id}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        visible={searching}
        disabled={!enabled}
        onBack={() => updateQuery({ search: undefined })}
        onOpen={(match) => {
          setLocation(
            match.line
              ? {
                  path: match.path,
                  position: { line: match.line, range: match.ranges?.[0] },
                }
              : undefined,
          );
          showFile({ ...target, path: match.path });
        }}
      />
      <ToolHeader visible={visible}>
        <div
          className={
            searching
              ? "hidden"
              : "flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-2"
          }
        >
          {mobile && queryFile ? (
            <IconButton label={t(($) => $.files.backDirectory)} onClick={() => setFilePath()}>
              <ArrowLeft />
            </IconButton>
          ) : (
            <IconButton
              label={t(($) => $.files.parentDirectory)}
              disabled={folder === "."}
              onClick={() => enter(parentPath(folder))}
            >
              <ArrowUp />
            </IconButton>
          )}
          {!mobile && (
            <IconButton
              label={t(($) => $.files.toggleList)}
              onClick={() => setListOpen((open) => !open)}
            >
              <PanelLeft />
            </IconButton>
          )}
          <span
            className="min-w-0 flex-1 truncate text-xs"
            title={pages[folder]?.listing?.resolvedPath}
          >
            {folder === "." ? workspace.name : folder}
          </span>
          <IconButton
            label={t(($) => $.files.searchFiles)}
            disabled={!enabled}
            onClick={() => updateQuery({ search: true })}
          >
            <Search />
          </IconButton>
          <IconButton
            label={t(($) => $.files.newFile)}
            disabled={!enabled}
            onClick={() => beginAction({ kind: "file", parent: folder })}
          >
            <FilePlus2 />
          </IconButton>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            aria-label={t(($) => $.files.uploadPicker)}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length) onUpload(files, folder);
              event.target.value = "";
            }}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon" aria-label={t(($) => $.files.moreActions)} />
              }
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuContent>
              <MenuItem disabled={!enabled} onClick={() => fileInput.current?.click()}>
                <Upload />
                {t(($) => $.files.uploadFiles)}
              </MenuItem>
              <MenuItem
                disabled={!enabled}
                onClick={() => beginAction({ kind: "directory", parent: folder })}
              >
                <FolderPlus />
                {t(($) => $.files.newDirectory)}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setSelecting((value) => !value);
                  setSelected(new Set());
                }}
              >
                <ListChecks />
                {selecting ? t(($) => $.files.finishSelection) : t(($) => $.files.selectFiles)}
              </MenuItem>
              <MenuItem disabled={!enabled} onClick={() => void refresh()}>
                <RefreshCw />
                {t(($) => $.common.refresh)}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        {!searching && !!selected.size && (
          <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-3">
            <span className="mr-auto text-xs">
              {selected.size.toLocaleString(i18n.resolvedLanguage)}
            </span>
            <IconButton
              label={t(($) => $.files.downloadSelected)}
              disabled={!enabled}
              onClick={() => {
                const entries = new Map(
                  Object.values(pages)
                    .flatMap((page) => page.listing?.entries.items ?? [])
                    .map((entry) => [entry.path, entry]),
                );
                for (const path of selected) {
                  const entry = entries.get(path);
                  if (entry?.kind === "file" || entry?.kind === "symlink") download(path);
                }
              }}
            >
              <Download />
            </IconButton>
            <IconButton
              label={t(($) => $.files.copySelected)}
              disabled={!enabled}
              onClick={() => selectedAction("copy")}
            >
              <Copy />
            </IconButton>
            <IconButton
              label={t(($) => $.files.moveSelected)}
              disabled={!enabled}
              onClick={() => selectedAction("move")}
            >
              <FolderInput />
            </IconButton>
            <IconButton
              label={t(($) => $.common.delete)}
              disabled={!enabled}
              onClick={() => selectedAction("delete")}
            >
              <Trash2 />
            </IconButton>
          </div>
        )}
        {!searching && notice && (
          <p
            role="status"
            className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
          >
            {notice.kind === "downloadStarted"
              ? t(($) => $.files.downloadStarted, { path: notice.path })
              : t(($) => $.files[notice.kind])}
          </p>
        )}
        {!enabled && (
          <p className="border-b border-border px-3 py-2 text-sm text-muted-foreground">
            {t(($) => $.common.deviceOffline)}
          </p>
        )}
        <FileCleanupNotice deviceId={device.id} active={visible} />
        {!!revealError && (
          <div role="alert" className="break-words px-3 py-2 text-sm text-destructive">
            <ErrorNotice error={revealError} />
          </div>
        )}
      </ToolHeader>
      <div className={searching ? "hidden" : "flex min-h-0 flex-1"}>
        {(mobile ? !queryFile : listOpen) && (
          <ToolSidebar visible={visible && !searching}>
            <aside
              className="scroll-area w-full overflow-auto border-border bg-muted/25 min-[960px]:w-72 min-[960px]:shrink-0 min-[960px]:border-r"
              aria-label={t(($) => $.files.list)}
            >
              <FileExplorer
                path={mobile || reveal ? folder : "."}
                {...{ pages, expanded, selected, mobile, selecting }}
                currentFile={queryFile ?? reveal ?? undefined}
                disabled={!enabled}
                onFolder={enter}
                onOpen={open}
                onSelect={(path) =>
                  setSelected((old) => {
                    const next = new Set(old);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
                onRename={(entry) => beginAction({ kind: "rename", entry })}
                onAction={(kind, entry) => onOperation({ kind, entries: [entry] }, folder)}
                onDownload={(entry) => download(entry.path!)}
                onMore={(path) => void load(path, true)}
                onDetails={setDetails}
              />
            </aside>
          </ToolSidebar>
        )}
        {(!mobile || queryFile) && (
          <section
            className="flex min-w-0 flex-1 flex-col"
            aria-label={t(($) => $.files.fileContent)}
          >
            {draft ? (
              <DraftView
                key={draft.id}
                store={store}
                draft={draft}
                unavailable={!enabled ? t(($) => $.common.deviceOffline) : undefined}
              />
            ) : queryFile ? (
              <FileContent
                key={queryFile}
                target={{
                  ...target,
                  path: queryFile,
                  deviceName: device.name,
                  workspaceName: workspace.name,
                }}
                store={store}
                active={visible && !searching && enabled}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {t(($) => $.files.selectFiles)}
              </div>
            )}
          </section>
        )}
      </div>
      {details && <FileDetails entry={details} onClose={() => setDetails(undefined)} />}
      {action && (
        <FileNameDialog
          deviceId={device.id}
          workspaceId={workspace.id}
          action={action}
          rename={(path, name) =>
            store.renameFile({ deviceId: device.id, workspaceId: workspace.id, path }, name)
          }
          onClose={() => setAction(undefined)}
          onDone={(result) => {
            setAction(undefined);
            setNotice({ kind: result.from ? "renamed" : "created" });
            if (result.from) {
              moveViewPaths([{ from: result.from, to: result.to }]);
            }
            if (result.entry?.kind === "file" && currentPath() === action.origin)
              open(result.entry);
            void load(parentPath(result.to));
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}
