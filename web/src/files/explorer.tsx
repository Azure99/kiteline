import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
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
} from "lucide-react";
import type { Entry } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import type { DirectoryPage } from "./use-browser";
import { formatBytes } from "./format";

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
  onAction: (kind: "copy" | "move" | "delete", entry: Entry) => void;
  onDownload: (entry: Entry) => void;
  onMore: (path: string) => void;
  onDetails: (entry: Entry) => void;
}) {
  const { t } = useTranslation();

  const page = pages[path];
  return (
    <div aria-busy={page?.busy}>
      {page?.listing?.entries.items.map((entry, index) => {
        const folder = entry.kind === "directory";
        const Icon = folder ? Folder : entry.kind === "symlink" ? Link : File;
        const open = !!entry.path && expanded.has(entry.path);
        return (
          <div key={entry.path ?? `invalid-${index}`}>
            <div
              className={`flex min-h-8 items-center pr-1 max-desk:min-h-11 ${currentFile === entry.path ? "bg-primary-soft" : "hover:bg-muted"}`}
              style={{ paddingLeft: 8 + depth * 14 }}
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
                <Icon
                  size={16}
                  className={`shrink-0 ${folder ? "text-primary" : "text-muted-foreground"}`}
                />
                <span className="min-w-0 flex-1 truncate whitespace-pre text-sm">{entry.name}</span>
                {(entry.unavailableReason || entry.kind === "file" || entry.kind === "other") && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {entry.unavailableReason
                      ? t(($) => $.files.nameEncoding)
                      : entry.kind === "other"
                        ? t(($) => $.files.specialFile)
                        : formatBytes(entry.size)}
                  </span>
                )}
                {mobile && folder && (
                  <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
                )}
              </button>
              {!!entry.path && (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t(($) => $.files.actionsNamed, { name: entry.name })}
                        disabled={disabled}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </MenuTrigger>
                  <MenuContent>
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
                    <MenuItem disabled={savingWithin(entry.path)} onClick={() => onRename(entry)}>
                      <Pencil />
                      {t(($) => $.common.rename)}
                    </MenuItem>
                    <MenuItem onClick={() => onAction("copy", entry)}>
                      <Copy />
                      {t(($) => $.common.copy)}
                    </MenuItem>
                    <MenuItem
                      disabled={savingWithin(entry.path)}
                      onClick={() => onAction("move", entry)}
                    >
                      <FolderInput />
                      {t(($) => $.common.move)}
                    </MenuItem>
                    <MenuItem
                      disabled={savingWithin(entry.path)}
                      onClick={() => onAction("delete", entry)}
                    >
                      <Trash2 />
                      {t(($) => $.common.delete)}
                    </MenuItem>
                    {entry.kind === "symlink" && (
                      <MenuItem onClick={() => onFolder(entry.path!)}>
                        <Folder />
                        {t(($) => $.files.openLinkDirectory)}
                      </MenuItem>
                    )}
                  </MenuContent>
                </Menu>
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
      {page?.busy && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {t(($) => $.common.reading)}
        </p>
      )}
      {!page?.busy && page?.listing?.entries.items.length === 0 && (
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
    </div>
  );
}
