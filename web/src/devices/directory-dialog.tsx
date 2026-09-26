import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, FolderPlus, RefreshCw } from "lucide-react";
import type { DirectoryListing, Workspace } from "@kiteline/shared/protocol";
import { rpc } from "../lib/api";
import { cursorRpc, releaseCursor } from "../lib/cursors";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
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
  onClose,
}: {
  deviceId: string;
  onAdded: (workspace: Workspace) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const [path, setPath] = useState("/");
  const [input, setInput] = useState("/");
  const [listing, setListing] = useState<DirectoryListing>();
  const [error, setError] = useState<unknown>();
  const [invalid, setInvalid] = useState(false);
  const [reading, setReading] = useState(true);
  const [writing, setWriting] = useState(false);
  const busy = reading || writing;
  const [revision, setRevision] = useState(0);
  const [newName, setNewName] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const mounted = useRef(false);
  const ownedCursor = useRef<string>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void releaseCursor(deviceId, "directory", ownedCursor.current);
    };
  }, [deviceId]);
  useEffect(() => {
    const controller = new AbortController();
    setReading(true);
    setError(undefined);
    setInvalid(false);
    void (async () => {
      if (!cursor) {
        await releaseCursor(deviceId, "directory", ownedCursor.current);
        ownedCursor.current = undefined;
      }
      return cursorRpc(
        deviceId,
        "directories.list",
        { absolutePath: path, cursor },
        controller.signal,
      );
    })()
      .then(
        (result) => {
          if (controller.signal.aborted) {
            void releaseCursor(deviceId, "directory", result.entries.nextCursor);
            return;
          }
          ownedCursor.current = result.entries.nextCursor;
          setListing(result);
          setInput(result.path);
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setError(error);
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
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
    setWriting(true);
    setError(undefined);
    setInvalid(false);
    try {
      const workspace = await rpc(deviceId, "workspaces.add", {
        absolutePath: listing.path,
      });
      if (mounted.current) onAdded(workspace);
    } catch (error) {
      setError(error);
    } finally {
      setWriting(false);
    }
  }
  async function mkdir() {
    if (!listing || !newName || newName.includes("/") || newName === "." || newName === "..") {
      setError(undefined);
      setInvalid(true);
      return;
    }
    setWriting(true);
    setError(undefined);
    setInvalid(false);
    try {
      const result = await rpc(deviceId, "directories.mkdir", {
        absolutePath: `${listing.path.replace(/\/$/, "")}/${newName}`,
      });
      setNewName(undefined);
      go(result.path);
    } catch (error) {
      setError(error);
    } finally {
      setWriting(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !writing) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(($) => $.devices.addWorkspace)}</DialogTitle>
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
              label={t(($) => $.files.parentDirectory)}
              disabled={busy || !listing?.parentPath}
              onClick={() => go(listing!.parentPath!)}
            >
              <ArrowUp />
            </IconButton>
            <Input
              aria-label={t(($) => $.devices.absolutePath)}
              disabled={busy}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              autoComplete="off"
            />
            <IconButton label={t(($) => $.devices.goDirectory)} disabled={busy} type="submit">
              <RefreshCw />
            </IconButton>
            <IconButton
              label={t(($) => $.files.newDirectory)}
              disabled={busy || !listing}
              onClick={() => setNewName("")}
            >
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
                aria-label={t(($) => $.devices.newDirectoryName)}
                disabled={busy}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                autoFocus
              />
              <Button type="submit" disabled={busy}>
                {t(($) => $.devices.new)}
              </Button>
              <Button variant="ghost" disabled={writing} onClick={() => setNewName(undefined)}>
                {t(($) => $.common.cancel)}
              </Button>
            </form>
          )}
          {invalid && (
            <p role="alert" className="text-sm text-destructive">
              {t(($) => $.devices.directoryNameRequired)}
            </p>
          )}
          {!!error && (
            <div role="alert" className="text-sm text-destructive">
              <ErrorNotice error={error} />
            </div>
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
                  <span className="ml-auto text-xs text-destructive">
                    {t(($) => $.files.nameEncoding)}
                  </span>
                )}
                {entry.kind === "symlink" && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t(($) => $.devices.link)}
                  </span>
                )}
              </button>
            ))}
            {busy && (
              <p role="status" className="p-3 text-sm text-muted-foreground">
                {t(($) => $.common.reading)}
              </p>
            )}
            {listing?.entries.items.length === 0 && !busy && (
              <p className="p-3 text-sm text-muted-foreground">
                {t(($) => $.files.emptyDirectory)}
              </p>
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
              {t(($) => $.common.nextPage)}
            </Button>
          )}
        </div>
        <DialogFooter>
          <DialogClose disabled={writing} render={<Button variant="outline" />}>
            {t(($) => $.common.cancel)}
          </DialogClose>
          <Button disabled={busy || !listing || !!error} onClick={() => void add()}>
            {t(($) => $.devices.selectDirectory)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
