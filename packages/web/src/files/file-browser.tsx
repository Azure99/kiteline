import { useTranslation } from "react-i18next";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  FilePlus2,
  FolderPlus,
  ListChecks,
  MoreHorizontal,
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
  currentRoute,
  isWorkspaceRoute,
  updateWorkspaceQuery,
  useRoute,
  type WorkspaceQuery,
  type NavigationOptions,
} from "../lib/navigation";
import { FileExplorer, type FileExplorerActions } from "./explorer";
import { FileDetails } from "./file-details";
import { FileNameDialog, type NameAction } from "./name-dialog";
import { isWithin, movedPath, parentPath } from "./paths";
import { useFileBrowser, type DirectoryReadMode } from "./use-browser";
import type { DraftStore } from "./drafts";
import { renameFile } from "./actions";
import { showDraft } from "./navigation";
import type { FileAction } from "./operation-dialog";
import type { TextLocation } from "./text-editor";
import { downloadFile } from "./content";
import { FileSearch } from "./file-search";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";

export function FileBrowser({
  device,
  workspace,
  browsing,
  contentVisible,
  currentFile,
  onOpenContent,
  onOpenFile,
  observeContent,
  store,
  onUpload,
  onOperation,
  children,
}: {
  device: Device;
  workspace: Workspace;
  browsing: boolean;
  contentVisible: boolean;
  currentFile?: string;
  onOpenContent(): void;
  onOpenFile(path: string, position?: TextLocation, keepSearch?: boolean): void;
  observeContent(signal: AbortSignal): Promise<void>;
  store: DraftStore;
  onUpload(files: File[], folder: string): void;
  onOperation(action: FileAction, folder: string): void;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();

  const visible = browsing || contentVisible;
  const route = useRoute();
  const mobile = useMobile();
  const folder = route.query.folder ?? ".";
  const reveal = route.query.reveal;
  const rootTree = !mobile && !reveal;
  const folderLabel = folder === "." ? workspace.name : folder;
  const [revealError, setRevealError] = useState<unknown>();
  const [expanded, setExpanded] = useState(new Set(["."]));
  const [selected, setSelected] = useState(new Set<string>());
  const [selecting, setSelecting] = useState(false);
  const [action, setAction] = useState<NameAction>();
  const [details, setDetails] = useState<Entry>();
  const [directoryDrop, setDirectoryDrop] = useState(false);
  const [notice, setNotice] = useState<"renamed" | "created">();
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadFolder = useRef(folder);
  const searchRegion = useRef<HTMLElement>(null);
  const list = useRef<HTMLElement>(null);
  const previousFolder = useRef(folder);
  const enabled = device.status === "online";
  const { pages, load, forget } = useFileBrowser(device.id, workspace.id, visible && enabled);
  useEffect(() => {
    const previous = previousFolder.current;
    if (previous === folder) return;
    const returning = mobile && parentPath(previous) === folder;
    const page = pages[folder];
    if (returning && (!page || page.busy)) return;
    previousFolder.current = folder;
    if (!returning) return;
    // The parent URL cannot identify the child just left; use its existing full path once.
    const row = Array.from(
      list.current?.querySelectorAll<HTMLElement>("[data-entry-path]") ?? [],
    ).find((element) => element.dataset.entryPath === previous);
    row?.scrollIntoView({ block: "center" });
  }, [folder, mobile, pages]);
  const initialRoot = browsing && enabled && !mobile && !reveal && pages["."] === undefined;
  useEffect(() => {
    if (initialRoot) void load(".", "refresh");
  }, [initialRoot, load]);
  const searching = route.query.search === true;
  useWorkspaceRefresh(device.id, workspace.id, visible && enabled, async (signal) => {
    await refresh("background", signal);
    if (!signal.aborted) await observeContent(signal);
  });
  useEffect(() => {
    if (!visible || !enabled || folder === ".") return;
    const deviceTarget = { deviceId: device.id, workspaceId: workspace.id };
    let active = true;
    void load(folder, "refresh").then((listing) => {
      if (!active || !listing || listing.path === folder) return;
      setExpanded((old) => new Set([...old].map((path) => movedPath(path, folder, listing.path))));
      const current = currentRoute();
      if (
        current.tool === "files" &&
        isWorkspaceRoute(current, deviceTarget) &&
        current.query.folder === folder
      )
        updateWorkspaceQuery(deviceTarget, { folder: listing.path }, { replace: true });
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
        updateWorkspaceQuery(
          target,
          { reveal: entry.path, folder: parentPath(entry.path) },
          { replace: true },
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setRevealError(error);
      });
    return () => controller.abort();
  }, [visible, enabled, reveal, device.id, device.environment?.os, workspace.id]);
  useEffect(() => {
    const written = (event: WindowEventMap["kiteline:file-written"]) => {
      const target = event.detail;
      if (target.deviceId === device.id && target.workspaceId === workspace.id)
        void load(parentPath(target.path), "refresh");
    };
    window.addEventListener("kiteline:file-written", written);
    return () => {
      window.removeEventListener("kiteline:file-written", written);
    };
  }, [device.id, workspace.id, load]);
  const target = { deviceId: device.id, workspaceId: workspace.id };
  function updateQuery(query: WorkspaceQuery, options: NavigationOptions = {}) {
    updateWorkspaceQuery(target, query, options);
  }
  function enter(path: string) {
    setSelected(new Set());
    updateQuery({
      folder: path,
    });
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(path) && !mobile && path !== ".") next.delete(path);
      else next.add(path);
      return next;
    });
    if (folder === path || path === ".") void load(path, "refresh");
  }
  function chooseUpload(path: string) {
    uploadFolder.current = path;
    fileInput.current?.click();
  }
  function open(entry: Entry) {
    setNotice(undefined);
    onOpenFile(entry.path!);
  }
  function download(path: string) {
    downloadFile({ deviceId: device.id, workspaceId: workspace.id, path });
  }
  async function refresh(mode: Exclude<DirectoryReadMode, "append">, signal?: AbortSignal) {
    for (const path of new Set(mobile ? [folder] : [folder, ...expanded])) {
      if (signal?.aborted) return;
      if (path === "." && initialRoot) continue;
      await load(path, mode);
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
      { replace: true },
    );
    const next = new Set([...expanded].map(nextPath));
    setExpanded(next);
    for (const path of next) if (!expanded.has(path)) void load(path, "refresh");
  }
  const operated = useEffectEvent((event: WindowEventMap["kiteline:files-operated"]) => {
    const { deviceId, workspaceId, kind, items } = event.detail;
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
      updateQuery({ folder }, { replace: true });
    }
    const affected = new Set<string>();
    for (const item of items) {
      affected.add(parentPath(item.path));
      if (item.targetPath) affected.add(parentPath(item.targetPath));
      if (kind !== "copy" && item.outcome !== "succeeded")
        for (const path of mobile ? [folder] : expanded)
          if (isWithin(path, item.path)) affected.add(path);
    }
    for (const path of affected) void load(path, "refresh");
    setSelected(new Set());
  });
  useEffect(() => {
    window.addEventListener("kiteline:files-operated", operated);
    return () => window.removeEventListener("kiteline:files-operated", operated);
  }, []);
  const entries = new Map(
    Object.values(pages)
      .flatMap((page) => page.listing?.entries.items ?? [])
      .map((entry) => [entry.path, entry]),
  );
  const downloadable = [...selected].filter((path) => {
    const entry = entries.get(path);
    return entry?.kind === "file" || entry?.kind === "symlink";
  });
  function selectedAction(kind: FileAction["kind"]) {
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
  const savingWithin = (path: string) => store.savingWithin(device.id, workspace.id, path);
  const explorerActions: FileExplorerActions = {
    savingWithin,
    openFolder: enter,
    openFile: open,
    select(path) {
      setSelected((old) => {
        const next = new Set(old);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    rename: (entry) => setAction({ kind: "rename", entry }),
    upload: chooseUpload,
    newDirectory: (parent) => setAction({ kind: "directory", parent }),
    operate: (kind, entry) => onOperation({ kind, entries: [entry] }, folder),
    download: (entry) => download(entry.path!),
    loadMore: (path) => void load(path, "append"),
    details: setDetails,
  };
  return (
    <div
      className={contentVisible ? "flex min-h-0 flex-1 flex-col" : "hidden"}
      onDragOverCapture={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = enabled ? "copy" : "none";
      }}
      onDropCapture={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        if (!enabled) return;
        if (
          Array.from(event.dataTransfer.items).some((item) => item.webkitGetAsEntry()?.isDirectory)
        ) {
          setDirectoryDrop(true);
          return;
        }
        setDirectoryDrop(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length) onUpload(files, folder);
      }}
    >
      <ToolSidebar visible={searching}>
        <FileSearch
          ref={searchRegion}
          deviceId={device.id}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          active={browsing && searching}
          disabled={!enabled}
          onBack={() => updateQuery({ search: undefined })}
          onOpen={(match, query) => {
            onOpenFile(
              match.path,
              match.line ? { line: match.line, range: match.ranges?.[0], query } : undefined,
              true,
            );
          }}
        />
      </ToolSidebar>
      <ToolHeader>
        <div
          className={
            searching
              ? "hidden"
              : "flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-2"
          }
        >
          <IconButton
            label={t(($) => $.files.parentDirectory)}
            disabled={folder === "."}
            onClick={() => enter(parentPath(folder))}
          >
            <ArrowUp />
          </IconButton>
          <span
            className="min-w-0 flex-1 truncate text-xs"
            title={pages[folder]?.listing?.resolvedPath}
          >
            {folderLabel}
          </span>
          {!mobile && (
            <IconButton
              label={t(($) => $.files.searchFiles)}
              disabled={!enabled}
              onClick={() => updateQuery({ search: true })}
            >
              <Search />
            </IconButton>
          )}
          <IconButton
            label={t(($) => $.files.newFile)}
            disabled={!enabled}
            onClick={() => {
              onOpenContent();
              showDraft(
                store.open({
                  ...target,
                  path: "",
                  folder,
                  deviceName: device.name,
                  workspaceName: workspace.name,
                }),
              );
            }}
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
              if (files.length) onUpload(files, uploadFolder.current);
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
            <MenuContent finalFocus={searching ? searchRegion : undefined}>
              {mobile && (
                <MenuItem disabled={!enabled} onClick={() => updateQuery({ search: true })}>
                  <Search />
                  {t(($) => $.files.searchFiles)}
                </MenuItem>
              )}
              <MenuItem disabled={!enabled} onClick={() => chooseUpload(folder)}>
                <Upload />
                {t(($) => $.files.uploadFiles)}
              </MenuItem>
              <MenuItem
                disabled={!enabled}
                onClick={() => setAction({ kind: "directory", parent: folder })}
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
              <MenuItem disabled={!enabled} onClick={() => void refresh("refresh")}>
                <RefreshCw />
                {t(($) => $.common.refresh)}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        {!searching && reveal && (
          <p className="border-b border-border px-3 py-2 text-xs whitespace-pre-wrap break-all">
            {t(($) => $.files.directoryFile, { path: reveal })}
          </p>
        )}
        {!searching && !!selected.size && (
          <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-3">
            <span className="mr-auto text-xs">
              {selected.size.toLocaleString(i18n.resolvedLanguage)}
            </span>
            <IconButton
              label={t(($) => $.files.downloadSelected)}
              disabled={!enabled || !downloadable.length}
              onClick={() => {
                for (const path of downloadable) download(path);
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
              disabled={!enabled || [...selected].some(savingWithin)}
              onClick={() => selectedAction("move")}
            >
              <FolderInput />
            </IconButton>
            <IconButton
              label={t(($) => $.common.delete)}
              disabled={!enabled || [...selected].some(savingWithin)}
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
            {t(($) => $.files[notice])}
          </p>
        )}
        {!enabled && (
          <p className="border-b border-border px-3 py-2 text-sm text-muted-foreground">
            {t(($) => $.common.deviceOffline)}
          </p>
        )}
        {directoryDrop && (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            {t(($) => $.files.directoryDropUnsupported)}
          </p>
        )}
        {!!revealError && (
          <div role="alert" className="break-words px-3 py-2 text-sm text-destructive">
            <ErrorNotice error={revealError} />
          </div>
        )}
      </ToolHeader>
      <div className="flex min-h-0 flex-1">
        <ToolSidebar visible={!searching}>
          <aside
            ref={list}
            key={mobile ? folder : undefined}
            className="scroll-area min-h-0 w-full flex-1 overflow-auto bg-muted"
            aria-label={t(($) => $.files.list)}
          >
            <FileExplorer
              path={rootTree ? "." : folder}
              {...{ pages, expanded, selected, mobile, selecting }}
              currentFile={currentFile ?? reveal ?? undefined}
              disabled={!enabled}
              actions={explorerActions}
            />
          </aside>
        </ToolSidebar>
        {children}
      </div>
      {details && (
        <FileDetails entry={details} root={workspace.path} onClose={() => setDetails(undefined)} />
      )}
      {action && (
        <FileNameDialog
          deviceId={device.id}
          workspaceId={workspace.id}
          targetOS={device.environment?.os}
          action={action}
          blocked={action.kind === "rename" && savingWithin(action.entry.path!)}
          rename={(path, name) =>
            renameFile(store, { deviceId: device.id, workspaceId: workspace.id, path }, name)
          }
          onClose={() => setAction(undefined)}
          onDone={(result) => {
            setAction(undefined);
            setNotice(result.from ? "renamed" : "created");
            if (result.from) {
              moveViewPaths([{ from: result.from, to: result.to }]);
            }
            void load(parentPath(result.to), "refresh");
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}
