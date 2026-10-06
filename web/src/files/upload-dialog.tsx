import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { FileInspection } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { ApiError, rpc } from "../lib/api";
import { FileConflictDialog } from "./conflict-dialog";
import { uploadFile } from "./content";
import { childPath } from "./paths";
import { formatBytes } from "./format";

interface UploadRow {
  id: number;
  file: File;
  path: string;
  version?: string;
  sent: number;
  status: "pending" | "sending" | "succeeded" | "failed" | "unknown" | "skipped";
  error?: unknown;
}

interface ActiveUpload {
  controller: AbortController;
  rowId: number;
  cancel?: () => Promise<unknown>;
}

export function UploadDialog({
  deviceId,
  workspaceId,
  folder,
  files,
  open,
  onHide,
  onClose,
  onWritten,
}: {
  deviceId: string;
  workspaceId: string;
  folder: string;
  files: File[];
  open: boolean;
  onHide: () => void;
  onClose: () => void;
  onWritten: (path: string) => void;
}) {
  const { t } = useTranslation();

  const [rows, setRows] = useState<UploadRow[]>(() =>
    files.map((file, id) => ({
      id,
      file,
      path: childPath(folder, file.name),
      sent: 0,
      status: "pending",
    })),
  );
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<unknown>();
  const [conflict, setConflict] = useState<{ row: UploadRow; inspection: FileInspection }>();
  const active = useRef<ActiveUpload>(undefined);
  const stop = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current = true;
      active.current?.controller.abort();
    };
  }, []);
  const editable = (row: UploadRow) => row.status === "pending" || row.status === "failed";
  const update = (id: number, values: Partial<UploadRow>) => {
    setRows((old) => old.map((row) => (row.id === id ? { ...row, ...values } : row)));
  };
  async function run() {
    const selected = rows.filter(editable);
    setBusy(true);
    setError(undefined);
    setCancelled(false);
    stop.current = false;
    for (const row of selected) {
      if (stop.current) break;
      const controller = new AbortController();
      const request: ActiveUpload = { controller, rowId: row.id };
      active.current = request;
      update(row.id, { status: "sending", sent: 0, error: undefined });
      try {
        await uploadFile(
          { deviceId, workspaceId, path: row.path },
          row.file,
          row.version,
          controller.signal,
          (sent) => update(row.id, { sent }),
          (cancel) => {
            request.cancel = cancel;
          },
        );
        update(row.id, { status: "succeeded", error: undefined });
        if (alive.current) onWritten(row.path);
      } catch (reason) {
        update(row.id, {
          status: reason instanceof ApiError && reason.outcome === "unknown" ? "unknown" : "failed",
          error:
            controller.signal.aborted && !(reason instanceof ApiError)
              ? new ApiError("cancelled", "Upload cancelled", "failed")
              : reason,
        });
      } finally {
        active.current = undefined;
      }
    }
    setBusy(false);
  }
  async function cancel() {
    stop.current = true;
    setCancelled(true);
    const request = active.current;
    if (!request) return;
    update(request.rowId, { error: undefined });
    if (!request.cancel) {
      request.controller.abort();
      return;
    }
    try {
      await request.cancel();
    } catch (reason) {
      if (active.current === request) {
        update(request.rowId, { error: reason });
        setCancelled(false);
      }
    }
  }
  async function inspect(row: UploadRow) {
    setChecking(true);
    setError(undefined);
    try {
      const inspection = await rpc(deviceId, "files.inspect", {
        workspaceId,
        path: row.path,
        suggestCopyName: true,
      });
      setConflict({ row, inspection });
    } catch (reason) {
      setError(reason);
    } finally {
      setChecking(false);
    }
  }
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(open) => {
          if (!open) onHide();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.files.uploadCount, { count: rows.length })}</DialogTitle>
          </DialogHeader>
          <div className="scroll-area min-h-0 space-y-3 overflow-auto p-4">
            {rows.map((row) => (
              <div key={row.id} className="space-y-2 border-b border-border py-2 last:border-0">
                <p className="break-all text-sm">
                  {row.file.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(row.file.size)}
                  </span>
                </p>
                <Textarea
                  aria-label={t(($) => $.files.uploadTarget, { name: row.file.name })}
                  rows={1}
                  value={row.path}
                  disabled={busy || checking || !editable(row)}
                  onChange={(event) =>
                    update(row.id, {
                      path: event.target.value,
                      version: undefined,
                      error: undefined,
                    })
                  }
                />
                {row.status === "sending" && (
                  <div role="status" className="space-y-1 text-xs text-muted-foreground">
                    <progress
                      className="h-1.5 w-full accent-primary"
                      max={row.file.size || 1}
                      value={row.sent}
                    />
                    <p>
                      {row.sent < row.file.size
                        ? `${formatBytes(row.sent)} / ${formatBytes(row.file.size)}`
                        : t(($) => $.files.awaitingUpload)}
                    </p>
                  </div>
                )}
                {row.status === "succeeded" && (
                  <p className="text-xs text-muted-foreground">{t(($) => $.files.uploaded)}</p>
                )}
                {row.status === "skipped" && (
                  <p className="text-xs text-muted-foreground">{t(($) => $.common.skipped)}</p>
                )}
                {row.version && editable(row) && (
                  <p className="text-xs text-destructive">{t(($) => $.files.replaceConfirmed)}</p>
                )}
                {!!row.error && (
                  <div role="alert" className="break-words text-xs text-destructive">
                    <ErrorNotice error={row.error} />
                  </div>
                )}
                {row.status === "unknown" && (
                  <p className="text-xs text-muted-foreground">{t(($) => $.files.checkTarget)}</p>
                )}
                {!busy && editable(row) && (
                  <div className="flex gap-2">
                    <Button variant="outline" disabled={checking} onClick={() => void inspect(row)}>
                      {t(($) => $.files.resolveConflict)}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={checking}
                      onClick={() => update(row.id, { status: "skipped" })}
                    >
                      {t(($) => $.common.skip)}
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {!!error && (
              <div role="alert" className="break-words text-sm text-destructive">
                <ErrorNotice error={error} />
              </div>
            )}
          </div>
          <DialogFooter>
            {busy ? (
              <>
                <Button variant="outline" onClick={onHide}>
                  {t(($) => $.common.collapse)}
                </Button>
                <Button variant="outline" disabled={cancelled} onClick={() => void cancel()}>
                  {cancelled ? t(($) => $.common.cancelling) : t(($) => $.files.cancelUpload)}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={onClose}>
                {t(($) => $.common.close)}
              </Button>
            )}
            {!busy && rows.some(editable) && (
              <Button disabled={checking} onClick={() => void run()}>
                <Upload />
                {t(($) => $.common.upload)}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {conflict && open && (
        <FileConflictDialog
          target={conflict.row.path}
          inspection={conflict.inspection}
          onClose={() => setConflict(undefined)}
          onChoose={(path, version) => {
            update(conflict.row.id, { path, version, error: undefined });
            setConflict(undefined);
          }}
        />
      )}
    </>
  );
}
