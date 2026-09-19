import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
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
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { useMobile } from "../lib/use-mobile";
import { navigate, useRoute } from "../lib/navigation";
import { FileExplorer } from "./explorer";
import { FileNameDialog, type NameAction } from "./name-dialog";
import { isWithin, movedPath, parentPath, useFileBrowser } from "./use-browser";
import { DraftView } from "./draft-view";
import { showDraft, useDrafts, type DraftStore } from "./drafts";
import { FileOperationDialog, type FileAction } from "./operation-dialog";
import { ImagePreview } from "./image-preview";
import { downloadFile, type FileTarget } from "./content";
import { FileSearch } from "./search-view";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";

export function Files({
  device,
  workspace,
  visible,
  store,
  onUpload,
}: {
  device: Device;
  workspace: Workspace;
  visible: boolean;
  store: DraftStore;
  onUpload: (files: File[], folder: string) => void;
}) {
  const { t, i18n } = useTranslation();

  const route = useRoute();
  const mobile = useMobile();
  const folder = route.query.get("folder") ?? ".";
  const reveal = route.query.get("reveal");
  const [expanded, setExpanded] = useState(new Set(["."]));
  const [selected, setSelected] = useState(new Set<string>());
  const [selecting, setSelecting] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [action, setAction] = useState<NameAction>();
  const [operation, setOperation] = useState<FileAction>();
  const [notice, setNotice] = useState<
    { kind: "downloadStarted"; path: string } | { kind: "renamed" | "created" }
  >();
  const fileInput = useRef<HTMLInputElement>(null);
  const enabled = device.status === "online";
  const { pages, load, forget } = useFileBrowser(device.id, workspace.id, visible && enabled);
  const queryFile = route.query.get("file");
  const queryDraft = route.query.get("draft");
  const isImage = route.query.get("preview") === "image";
  const searching = route.query.get("search") === "1";
  const drafts = useDrafts(store);
  const draft = drafts.find(
    (item) =>
      item.deviceId === device.id &&
      item.workspaceId === workspace.id &&
      (queryDraft ? item.id === queryDraft : item.path === queryFile),
  );
  useWorkspaceRefresh(device.id, workspace.id, visible && enabled, "files", async (signal) => {
    await refresh(signal, true);
    if (draft && !signal.aborted) await store.observe(draft, signal);
  });
  useEffect(() => {
    if (!visible || !queryFile || !enabled || isImage) return;
    const target = { deviceId: device.id, workspaceId: workspace.id, path: queryFile };
    const existing = store.find(target, queryDraft ?? undefined);
    if (!existing) {
      const opened = store.open({
        ...target,
        deviceName: device.name,
        workspaceName: workspace.name,
      });
      showDraft(opened, true);
    }
  }, [
    visible,
    queryFile,
    queryDraft,
    isImage,
    enabled,
    device.id,
    device.name,
    workspace.id,
    workspace.name,
    store,
  ]);
  useEffect(() => {
    if (visible && enabled && folder !== ".") void load(folder);
  }, [visible, enabled, folder, load]);
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
  function updateQuery(query: URLSearchParams, replace = false) {
    const path = location.pathname + (query.size ? `?${query}` : "");
    if (path !== location.pathname + location.search) navigate(path, replace);
  }
  function setFilePath(path?: string) {
    const query = new URLSearchParams(location.search);
    if (path) query.set("file", path);
    else query.delete("file");
    query.delete("draft");
    query.delete("preview");
    updateQuery(query);
  }
  function enter(path: string) {
    setSelected(new Set());
    const query = new URLSearchParams(location.search);
    if (path === ".") query.delete("folder");
    else query.set("folder", path);
    if (mobile) {
      query.delete("file");
      query.delete("draft");
      query.delete("preview");
    }
    updateQuery(query);
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
    if (/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) {
      preview(entry);
      return;
    }
    showDraft(
      store.open({
        deviceId: device.id,
        workspaceId: workspace.id,
        path: entry.path!,
        deviceName: device.name,
        workspaceName: workspace.name,
      }),
    );
  }
  function preview(entry: Pick<Entry, "path">) {
    setNotice(undefined);
    const query = new URLSearchParams({
      file: entry.path!,
      folder: parentPath(entry.path!),
      preview: "image",
    });
    updateQuery(query);
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
    const query = new URLSearchParams(location.search);
    const nextFolder = nextPath(query.get("folder") ?? ".");
    if (nextFolder === ".") query.delete("folder");
    else query.set("folder", nextFolder);
    const file = query.get("file");
    if (file) query.set("file", nextPath(file));
    updateQuery(query, true);
    const next = new Set([...expanded].map(nextPath));
    setExpanded(next);
    for (const path of next) if (!expanded.has(path)) void load(path);
  }
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
    if (chosen.length) setOperation({ kind, entries: chosen });
  }
  return (
    <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <FileSearch
        deviceId={device.id}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        visible={searching}
        disabled={!enabled}
        onBack={() => {
          const query = new URLSearchParams(location.search);
          query.delete("search");
          updateQuery(query);
        }}
        onOpen={(match) => {
          const target = { deviceId: device.id, workspaceId: workspace.id, path: match.path };
          if (!match.line && !store.find(target) && /\.(png|jpe?g|webp|gif)$/i.test(match.path)) {
            preview(match);
            return;
          }
          const opened = store.open({
            ...target,
            deviceName: device.name,
            workspaceName: workspace.name,
          });
          if (match.line) {
            opened.location = { line: match.line, range: match.ranges?.[0] };
            store.changed();
          }
          showDraft(opened);
        }}
      />
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
          onClick={() => {
            const query = new URLSearchParams(location.search);
            query.set("search", "1");
            updateQuery(query);
          }}
        >
          <Search />
        </IconButton>
        <IconButton
          label={t(($) => $.files.newFile)}
          disabled={!enabled}
          onClick={() => setAction({ kind: "file", parent: folder })}
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
            label={t(($) => $.files.deleteSelected)}
            disabled={!enabled}
            onClick={() => selectedAction("delete")}
          >
            <Trash2 />
          </IconButton>
        </div>
      )}
      {!searching && notice && (
        <p role="status" className="border-b border-border px-3 py-1 text-xs text-muted-foreground">
          {notice.kind === "downloadStarted"
            ? t(($) => $.files.downloadStarted, { path: notice.path })
            : t(($) => $.files[notice.kind])}
        </p>
      )}
      {!enabled && (
        <p className="border-b border-border px-3 py-2 text-sm text-muted-foreground">
          {device.status === "revoked"
            ? t(($) => $.common.deviceRevoked)
            : t(($) => $.common.deviceOffline)}
        </p>
      )}
      <div className={searching ? "hidden" : "flex min-h-0 flex-1"}>
        {(mobile ? !queryFile : listOpen) && (
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
              onRename={(entry) => setAction({ kind: "rename", entry })}
              onAction={(kind, entry) => setOperation({ kind, entries: [entry] })}
              onDownload={(entry) => download(entry.path!)}
              onImage={preview}
              onMore={(path) => void load(path, true)}
            />
          </aside>
        )}
        {(!mobile || queryFile) && (
          <section
            className="flex min-w-0 flex-1 flex-col"
            aria-label={t(($) => $.files.fileContent)}
          >
            {isImage && queryFile ? (
              <ImagePreview
                key={queryFile}
                target={{ deviceId: device.id, workspaceId: workspace.id, path: queryFile }}
                disabled={!enabled}
              />
            ) : draft ? (
              <DraftView
                key={draft.id}
                store={store}
                draft={draft}
                unavailable={
                  !enabled
                    ? device.status === "revoked"
                      ? t(($) => $.common.deviceRevoked)
                      : t(($) => $.common.deviceOffline)
                    : undefined
                }
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {t(($) => $.files.selectFiles)}
              </div>
            )}
          </section>
        )}
      </div>
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
            if (result.entry?.kind === "file") open(result.entry);
            void load(parentPath(result.to));
            setSelected(new Set());
          }}
        />
      )}
      {operation && (
        <FileOperationDialog
          deviceId={device.id}
          workspaceId={workspace.id}
          action={operation}
          folder={folder}
          onClose={() => setOperation(undefined)}
          onResult={(items) => {
            const completed = items.filter((item) => item.outcome === "succeeded");
            if (operation.kind !== "copy")
              for (const item of items)
                if (item.outcome === "partial" || item.outcome === "unknown")
                  void store.checkMissing(device.id, workspace.id, item.path);
            if (operation.kind === "move") {
              for (const item of completed)
                void store.rename(device.id, workspace.id, item.path, item.targetPath!);
              moveViewPaths(completed.map((item) => ({ from: item.path, to: item.targetPath! })));
            }
            if (operation.kind === "delete") {
              const query = new URLSearchParams(location.search);
              for (const item of completed) {
                store.deleted(device.id, workspace.id, item.path);
                forget(item.path);
                if (isWithin(query.get("folder") ?? ".", item.path))
                  query.set("folder", parentPath(item.path));
              }
              updateQuery(query, true);
            }
            const affected = new Set<string>();
            for (const item of items) {
              affected.add(parentPath(item.path));
              if (item.targetPath) affected.add(parentPath(item.targetPath));
              if (operation.kind !== "copy" && item.outcome !== "succeeded")
                for (const path of mobile ? [folder] : expanded)
                  if (isWithin(path, item.path)) affected.add(path);
            }
            for (const path of affected) void load(path);
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}
