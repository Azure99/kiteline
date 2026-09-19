import { useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, FolderPlus, RefreshCw } from "lucide-react";
import type { DirectoryListing, Workspace } from "@kiteline/shared/protocol";
import { errorMessage, rpc } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { IconButton } from "../components/icon-button";

export function DirectoryDialog({
  deviceId,
  onAdded,
}: {
  deviceId: string;
  onAdded: (workspace: Workspace) => void;
}) {
  const [path, setPath] = useState("/");
  const [input, setInput] = useState("/");
  const [listing, setListing] = useState<DirectoryListing>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const [newName, setNewName] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    void rpc(deviceId, "directories.list", { absolutePath: path, cursor }, controller.signal)
      .then(
        (result) => {
          setListing(result);
          setInput(result.path);
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(error));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [deviceId, path, cursor, revision]);
  function go(value: string) {
    setListing(undefined);
    setCursor(undefined);
    setPath(value);
    setRevision((r) => r + 1);
  }
  async function add() {
    if (!listing) return;
    setBusy(true);
    setError("");
    try {
      const workspace = await rpc(deviceId, "workspaces.add", {
        absolutePath: listing.path,
      });
      if (mounted.current) onAdded(workspace);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function mkdir() {
    if (!listing || !newName || newName.includes("/") || newName === "." || newName === "..") {
      setError("请输入单个目录名称");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await rpc(deviceId, "directories.mkdir", {
        absolutePath: `${listing.path.replace(/\/$/, "")}/${newName}`,
      });
      setNewName(undefined);
      go(result.path);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>添加 workspace</DialogTitle>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            go(input);
          }}
        >
          <IconButton
            label="上级目录"
            disabled={busy || !listing?.parentPath}
            onClick={() => go(listing!.parentPath!)}
          >
            <ArrowUp />
          </IconButton>
          <Input
            aria-label="绝对目录路径"
            disabled={busy}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            autoComplete="off"
          />
          <IconButton label="转到目录" disabled={busy} type="submit">
            <RefreshCw />
          </IconButton>
          <IconButton label="新建目录" disabled={busy || !listing} onClick={() => setNewName("")}>
            <FolderPlus />
          </IconButton>
        </form>
        {newName !== undefined && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void mkdir();
            }}
          >
            <Input
              aria-label="新目录名称"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              autoFocus
            />
            <Button type="submit" disabled={busy}>
              新建
            </Button>
            <Button variant="ghost" onClick={() => setNewName(undefined)}>
              取消
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="scroll-area min-h-40 flex-1 overflow-auto" aria-busy={busy}>
          {listing?.entries.items.map((entry, index) => (
            <button
              className="flex min-h-9 w-full items-center gap-3 rounded px-2 py-1.5 text-left hover:bg-muted disabled:opacity-50 max-[959px]:min-h-11"
              key={entry.path ?? index}
              disabled={busy || !entry.path || !["directory", "symlink"].includes(entry.kind)}
              onClick={() => go(entry.path!)}
            >
              <Folder size={17} className="shrink-0 text-primary" />
              <span className="min-w-0 break-all">{entry.name}</span>
              {entry.unavailableReason && (
                <span className="ml-auto text-xs text-destructive">名称编码不支持</span>
              )}
              {entry.kind === "symlink" && (
                <span className="ml-auto text-xs text-muted-foreground">链接</span>
              )}
            </button>
          ))}
          {busy && (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              正在读取
            </p>
          )}
          {listing?.entries.items.length === 0 && !busy && (
            <p className="p-3 text-sm text-muted-foreground">空目录</p>
          )}
        </div>
        {listing?.entries.nextCursor && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setCursor(listing.entries.nextCursor);
              setRevision((r) => r + 1);
            }}
          >
            下一页
          </Button>
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
        <Button disabled={busy || !listing || !!error} onClick={() => void add()}>
          选择此目录
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
