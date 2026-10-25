import { memo, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import { FileIcon } from "../components/file-icon";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Link,
  MoreHorizontal,
  Pencil,
  Copy,
  FolderInput,
  Trash2,
  Download,
  Info,
  Upload,
  FolderPlus,
} from "lucide-react";
import type { Entry } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger, createMenuHandle } from "../components/ui/menu";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/ui/context-menu";
import type { DirectoryPage } from "./use-browser";
import { formatBytes, unavailableEntryLabel } from "./format";

export function FileExplorer({
  path,
  depth = 0,
  pages,
  expanded,
  selected,
  currentFile,
  mobile,
  selecting,
  disabled,
  savingWithin,
  onFolder,
  onOpen,
  onSelect,
  onRename,
  onUpload,
  onNewDirectory,
  onAction,
  onDownload,
  onMore,
  onDetails,
}: {
  path: string;
  depth?: number;
  pages: Record<string, DirectoryPage>;
  expanded: Set<string>;
  selected: Set<string>;
  currentFile?: string;
  mobile: boolean;
  selecting: boolean;
  disabled: boolean;
  savingWithin: (path: string) => boolean;
  onFolder: (path: string) => void;
  onOpen: (entry: Entry) => void;
  onSelect: (path: string) => void;
  onRename: (entry: Entry) => void;
  onUpload: (path: string) => void;
  onNewDirectory: (path: string) => void;
  onAction: (kind: "copy" | "move" | "delete", entry: Entry) => void;
  onDownload: (entry: Entry) => void;
  onMore: (path: string) => void;
  onDetails: (entry: Entry) => void;
}) {
  const { t } = useTranslation();

  const [menuHandle] = useState(() => createMenuHandle<string>());
  const page = pages[path];
  const rowStyle = useMemo(() => ({ paddingLeft: 8 + depth * 14 }), [depth]);
  function menuItems(entry: Entry) {
    return (
      <>
        <p className="max-w-72 break-all px-2 py-1 text-xs text-muted-foreground">{entry.path}</p>
        {entry.kind === "directory" && (
          <>
            <MenuItem onClick={() => onUpload(entry.path!)}>
              <Upload />
              {t(($) => $.files.uploadFiles)}
            </MenuItem>
            <MenuItem onClick={() => onNewDirectory(entry.path!)}>
              <FolderPlus />
              {t(($) => $.files.newDirectory)}
            </MenuItem>
          </>
        )}
        <MenuItem onClick={() => onDetails(entry)}>
          <Info />
          {t(($) => $.files.details)}
        </MenuItem>
        {(entry.kind === "file" || entry.kind === "symlink") && (
          <>
            <MenuItem onClick={() => onDownload(entry)}>
              <Download />
              {t(($) => $.common.download)}
            </MenuItem>
          </>
        )}
        <MenuItem disabled={savingWithin(entry.path!)} onClick={() => onRename(entry)}>
          <Pencil />
          {t(($) => $.common.rename)}
        </MenuItem>
        <MenuItem onClick={() => onAction("copy", entry)}>
          <Copy />
          {t(($) => $.common.copy)}
        </MenuItem>
        <MenuItem disabled={savingWithin(entry.path!)} onClick={() => onAction("move", entry)}>
          <FolderInput />
          {t(($) => $.common.move)}
        </MenuItem>
        <MenuItem disabled={savingWithin(entry.path!)} onClick={() => onAction("delete", entry)}>
          <Trash2 />
          {t(($) => $.common.delete)}
        </MenuItem>
        {entry.kind === "symlink" && (
          <MenuItem onClick={() => onFolder(entry.path!)}>
            <Folder />
            {t(($) => $.files.openLinkDirectory)}
          </MenuItem>
        )}
      </>
    );
  }
  return (
    <div aria-busy={page?.busy}>
      {page?.listing?.entries.items.map((entry, index) => {
        const folder = entry.kind === "directory";
        const Icon = folder ? Folder : entry.kind === "symlink" ? Link : File;
        const open = !!entry.path && expanded.has(entry.path);
        return (
          <div key={entry.path ?? `invalid-${index}`}>
            <div
              data-entry-path={entry.path}
              className={`group flex min-h-8 items-center pr-1 max-desk:min-h-11 ${currentFile === entry.path ? "bg-primary-soft" : "hover:bg-muted"}`}
              style={rowStyle}
            >
              {selecting && (
                <label className="flex size-8 shrink-0 cursor-pointer items-center justify-center max-desk:size-11">
                  <input
                    type="checkbox"
                    aria-label={t(($) => $.files.selectNamed, { name: entry.name })}
                    checked={!!entry.path && selected.has(entry.path)}
                    disabled={!entry.path || disabled}
                    onChange={() => onSelect(entry.path!)}
                    className="size-4 accent-primary"
                  />
                </label>
              )}
              <ContextMenu disabled={!entry.path || disabled}>
                <ContextMenuTrigger
                  render={
                    <button
                      className="flex min-h-8 min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50 max-desk:min-h-11"
                      disabled={!entry.path || disabled}
                      title={entry.linkTarget ? `${entry.name} -> ${entry.linkTarget}` : entry.name}
                      onClick={() => (folder ? onFolder(entry.path!) : onOpen(entry))}
                    >
                      {!mobile &&
                        folder &&
                        (open ? (
                          <ChevronDown size={13} className="shrink-0" />
                        ) : (
                          <ChevronRight size={13} className="shrink-0" />
                        ))}
                      {entry.kind === "file" ? (
                        <FileIcon path={entry.name} />
                      ) : (
                        <Icon
                          size={16}
                          className={`shrink-0 ${folder ? "text-primary" : "text-muted-foreground"}`}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate whitespace-pre text-sm">
                        {entry.name}
                      </span>
                      {(entry.unavailableReason ||
                        entry.kind === "file" ||
                        entry.kind === "other") && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {entry.unavailableReason
                            ? unavailableEntryLabel(entry.unavailableReason)
                            : entry.kind === "other"
                              ? t(($) => $.files.specialFile)
                              : formatBytes(entry.size)}
                        </span>
                      )}
                      {mobile && folder && (
                        <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  }
                />
                <ContextMenuContent>{entry.path && menuItems(entry)}</ContextMenuContent>
              </ContextMenu>

              {!!entry.path && (
                <EntryMenuTrigger
                  handle={menuHandle}
                  path={entry.path}
                  name={entry.name}
                  t={t}
                  disabled={disabled}
                />
              )}
            </div>
            {!mobile && (folder || entry.kind === "symlink") && open && (
              <FileExplorer
                {...{
                  pages,
                  expanded,
                  selected,
                  currentFile,
                  mobile,
                  selecting,
                  disabled,
                  savingWithin,
                  onFolder,
                  onOpen,
                  onSelect,
                  onRename,
                  onUpload,
                  onNewDirectory,
                  onAction,
                  onDownload,
                  onMore,
                  onDetails,
                }}
                path={entry.path!}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
      {!!page?.error && (
        <div role="alert" className="break-words px-3 py-2 text-xs text-destructive">
          <ErrorNotice error={page.error} />
        </div>
      )}
      {page?.busy && !page.listing && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {t(($) => $.common.reading)}
        </p>
      )}
      {page?.listing?.entries.items.length === 0 && (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          {t(($) => $.files.emptyDirectory)}
        </p>
      )}
      {page?.listing?.entries.nextCursor && (
        <Button
          variant="ghost"
          className="w-full"
          disabled={page.busy || disabled}
          onClick={() => onMore(path)}
        >
          {t(($) => $.common.more)}
        </Button>
      )}
      <Menu handle={menuHandle}>
        {({ payload }) => {
          const entry = page?.listing?.entries.items.find((item) => item.path === payload);
          return (
            <MenuContent>
              {entry?.path ? (
                menuItems(entry)
              ) : payload ? (
                <CloseMissingMenu handle={menuHandle} />
              ) : null}
            </MenuContent>
          );
        }}
      </Menu>
    </div>
  );
}

const EntryMenuTrigger = memo(function EntryMenuTrigger({
  handle,
  path,
  name,
  t,
  disabled,
}: {
  handle: ReturnType<typeof createMenuHandle<string>>;
  path: string;
  name: string;
  t: TFunction;
  disabled: boolean;
}) {
  return (
    <MenuTrigger
      handle={handle}
      payload={path}
      render={
        <Button
          variant="ghost"
          size="icon"
          className="row-more"
          aria-label={t(($) => $.files.actionsNamed, { name })}
          disabled={disabled}
        />
      }
    >
      <MoreHorizontal />
    </MenuTrigger>
  );
});

function CloseMissingMenu({ handle }: { handle: ReturnType<typeof createMenuHandle<string>> }) {
  useEffect(() => {
    handle.close();
  }, [handle]);
  return null;
}
