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
  Image,
} from "lucide-react";
import type { Entry } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import type { DirectoryPage } from "./use-browser";
import { formatBytes } from "./use-browser";

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
  onFolder,
  onOpen,
  onSelect,
  onRename,
  onAction,
  onDownload,
  onImage,
  onMore,
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
  onFolder: (path: string) => void;
  onOpen: (entry: Entry) => void;
  onSelect: (path: string) => void;
  onRename: (entry: Entry) => void;
  onAction: (kind: "copy" | "move" | "delete", entry: Entry) => void;
  onDownload: (entry: Entry) => void;
  onImage: (entry: Entry) => void;
  onMore: (path: string) => void;
}) {
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
              className={`file-row group flex min-h-11 items-center pr-1 ${currentFile === entry.path ? "bg-primary-soft" : "hover:bg-muted"}`}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {selecting && (
                <label className="flex min-h-11 w-9 shrink-0 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${entry.name}`}
                    checked={!!entry.path && selected.has(entry.path)}
                    disabled={!entry.path || disabled}
                    onChange={() => onSelect(entry.path!)}
                    className="size-4 accent-primary"
                  />
                </label>
              )}
              <button
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-1.5 text-left disabled:opacity-50"
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
                <span className="min-w-0 flex-1">
                  <span className="block truncate whitespace-pre text-sm">{entry.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {entry.unavailableReason
                      ? "名称编码不支持"
                      : folder
                        ? "目录"
                        : entry.kind === "symlink"
                          ? `链接 → ${entry.linkTarget}`
                          : entry.kind === "other"
                            ? "特殊文件"
                            : formatBytes(entry.size)}
                    {entry.mtime && ` · ${new Date(entry.mtime).toLocaleString()}`}
                  </span>
                </span>
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
                        aria-label={`${entry.name} 文件操作`}
                        disabled={disabled}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </MenuTrigger>
                  <MenuContent>
                    {(entry.kind === "file" || entry.kind === "symlink") && (
                      <>
                        <MenuItem onClick={() => onDownload(entry)}>
                          <Download />
                          下载
                        </MenuItem>
                        <MenuItem onClick={() => onImage(entry)}>
                          <Image />
                          图片预览
                        </MenuItem>
                      </>
                    )}
                    <MenuItem onClick={() => onRename(entry)}>
                      <Pencil />
                      重命名
                    </MenuItem>
                    <MenuItem onClick={() => onAction("copy", entry)}>
                      <Copy />
                      复制
                    </MenuItem>
                    <MenuItem onClick={() => onAction("move", entry)}>
                      <FolderInput />
                      移动
                    </MenuItem>
                    <MenuItem onClick={() => onAction("delete", entry)}>
                      <Trash2 />
                      删除
                    </MenuItem>
                    {entry.kind === "symlink" && (
                      <MenuItem onClick={() => onFolder(entry.path!)}>
                        <Folder />
                        进入链接目录
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
                  onFolder,
                  onOpen,
                  onSelect,
                  onRename,
                  onAction,
                  onDownload,
                  onImage,
                  onMore,
                }}
                path={entry.path!}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
      {page?.error && (
        <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">
          {page.error}
        </p>
      )}
      {page?.busy && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          正在读取
        </p>
      )}
      {!page?.busy && page?.listing?.entries.items.length === 0 && (
        <p className="px-3 py-3 text-xs text-muted-foreground">空目录</p>
      )}
      {page?.listing?.entries.nextCursor && (
        <Button
          variant="ghost"
          className="w-full"
          disabled={page.busy || disabled}
          onClick={() => onMore(path)}
        >
          加载更多
        </Button>
      )}
    </div>
  );
}
