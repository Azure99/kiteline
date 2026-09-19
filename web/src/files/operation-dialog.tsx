import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Copy, FolderInput, Trash2 } from "lucide-react";
import type {
  CopyItem,
  Entry,
  FileInspection,
  FileItemResult,
  FileProgress,
  RpcArguments,
} from "@kiteline/shared/protocol";
import { api, ApiError, rpc, rpcReply } from "../lib/api";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { childPath, formatBytes } from "./use-browser";
import { FileConflictDialog } from "./conflict-dialog";

export interface FileAction {
  kind: "copy" | "move" | "delete";
  entries: Entry[];
}
interface Row {
  entry: Entry;
  targetPath: string;
  collision: CopyItem["collision"];
  version?: string;
  result?: FileItemResult;
  skipped?: boolean;
}
export function FileOperationDialog({
  deviceId,
  workspaceId,
  action,
  folder,
  onClose,
  onResult,
}: {
  deviceId: string;
  workspaceId: string;
  action: FileAction;
  folder: string;
  onClose: () => void;
  onResult: (items: FileItemResult[]) => void;
}) {
  const { t } = useTranslation();

  const [rows, setRows] = useState<Row[]>(() =>
    action.entries.map((entry) => ({
      entry,
      targetPath: childPath(folder, entry.name),
      collision: "error",
    })),
  );
  const [directory, setDirectory] = useState(folder);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<FileProgress>();
  const [error, setError] = useState<unknown>();
  const [invalid, setInvalid] = useState(false);
  const [conflict, setConflict] = useState<{
    row: Row;
    inspection: FileInspection;
  }>();
  const [conflictBusy, setConflictBusy] = useState(false);
  const current = useRef<{ id: string; controller: AbortController }>(undefined);
  const alive = useRef(true);
  const edited = useRef(false);
  useEffect(() => {
    alive.current = true;
    const update = (event: Event) => {
      const message = (
        event as CustomEvent<FileProgress & { type: string; deviceId: string; id: string }>
      ).detail;
      if (
        message.type === "request.progress" &&
        message.deviceId === deviceId &&
        message.id === current.current?.id
      )
        setProgress(message);
    };
    window.addEventListener("kiteline:event", update);
    return () => {
      alive.current = false;
      current.current?.controller.abort();
      window.removeEventListener("kiteline:event", update);
    };
  }, [deviceId]);
  useEffect(() => {
    if (action.kind !== "copy") return;
    let stopped = false;
    void (async () => {
      for (const entry of action.entries) {
        const initial = childPath(folder, entry.name);
        if (initial !== entry.path || stopped || edited.current) continue;
        try {
          const inspected = await rpc(deviceId, "files.inspect", {
            workspaceId,
            path: initial,
            suggestCopyName: true,
          });
          if (!stopped && !edited.current && !current.current && inspected.suggestedName)
            setRows((old) =>
              old.map((row) =>
                row.entry.path === entry.path && row.targetPath === initial && !row.result
                  ? { ...row, targetPath: childPath(folder, inspected.suggestedName!) }
                  : row,
              ),
            );
        } catch {
          /* A suggestion is optional; execution still checks the actual destination. */
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [action, deviceId, workspaceId, folder]);
  const editable = (row: Row) => !row.skipped && (!row.result || row.result.outcome === "failed");
  const pending = rows.filter(editable);
  function updateRow(row: Row, values: Partial<Row>) {
    edited.current = true;
    setRows((old) => old.map((item) => (item === row ? { ...item, ...values } : item)));
  }
  async function run() {
    if (!pending.length || busy) return;
    if (
      action.kind !== "delete" &&
      pending.some(
        (row) =>
          !row.targetPath ||
          row.targetPath.startsWith("/") ||
          row.targetPath.split("/").some((part) => part === ".."),
      )
    ) {
      setError(undefined);
      setInvalid(true);
      return;
    }
    const submitted = pending.map((row) => ({ ...row }));
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    current.current = request;
    setBusy(true);
    setCancelling(false);
    setError(undefined);
    setInvalid(false);
    setProgress({ phase: "queued" });
    try {
      const params = {
        workspaceId,
        items: submitted.map((row) => ({
          path: row.entry.path!,
          targetPath: row.targetPath,
          collision: row.collision,
          expectedTargetVersion: row.version,
        })),
      };
      const operation: RpcArguments<"files.copy" | "files.move" | "files.delete"> =
        action.kind === "delete"
          ? [
              "files.delete",
              { workspaceId, paths: submitted.map((row) => row.entry.path!) },
              request.controller.signal,
            ]
          : action.kind === "copy"
            ? ["files.copy", params, request.controller.signal]
            : ["files.move", params, request.controller.signal];
      const reply = await rpcReply(deviceId, request.id, operation);
      if (!alive.current) return;
      const result =
        reply.result?.items ??
        submitted.map((row) => ({
          path: row.entry.path!,
          targetPath: row.targetPath,
          outcome: reply.outcome,
          ...(reply.outcome !== "succeeded" ? { error: reply.error } : {}),
        }));
      setRows((old) =>
        old.map((row) => {
          const item = result.find((item) => item.path === row.entry.path);
          return item ? { ...row, result: item } : row;
        }),
      );
      onResult(result);
      if (reply.outcome !== "succeeded")
        setError(
          new ApiError(
            reply.error.code,
            reply.error.message,
            reply.outcome,
            reply.error.details,
            reply.result,
          ),
        );
    } catch (reason) {
      if (!alive.current) return;
      setError(reason);
      const result: FileItemResult[] = submitted.map((row) => ({
        path: row.entry.path!,
        targetPath: row.targetPath,
        outcome: reason instanceof ApiError && reason.outcome !== "unknown" ? "failed" : "unknown",
      }));
      setRows((old) =>
        old.map((row) => ({
          ...row,
          result: result.find((item) => item.path === row.entry.path) ?? row.result,
        })),
      );
      onResult(result);
    } finally {
      if (current.current === request) current.current = undefined;
      if (alive.current) {
        setBusy(false);
        setCancelling(false);
      }
    }
  }
  async function inspect(row: Row) {
    edited.current = true;
    setConflictBusy(true);
    setError(undefined);
    setInvalid(false);
    try {
      const inspection = await rpc(deviceId, "files.inspect", {
        workspaceId,
        path: row.targetPath,
        suggestCopyName: true,
      });
      if (alive.current)
        setConflict({
          row,
          inspection,
        });
    } catch (reason) {
      if (alive.current) setError(reason);
    } finally {
      if (alive.current) setConflictBusy(false);
    }
  }
  const Icon = action.kind === "copy" ? Copy : action.kind === "move" ? FolderInput : Trash2;
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                ($) =>
                  action.kind === "copy"
                    ? $.files.copyCount
                    : action.kind === "move"
                      ? $.files.moveCount
                      : $.files.deleteCount,
                { count: rows.length },
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="scroll-area min-h-0 space-y-3 overflow-auto p-4">
            {action.kind === "delete" ? (
              <p className="text-sm">
                {t(($) =>
                  rows.some((row) => row.entry.kind === "directory")
                    ? $.files.deleteSelectedMounted
                    : $.files.deleteSelected,
                )}
              </p>
            ) : (
              <label className="block space-y-1 text-sm">
                <span>{t(($) => $.files.targetDirectory)}</span>
                <Textarea
                  aria-label={t(($) => $.files.targetDirectory)}
                  rows={1}
                  value={directory}
                  disabled={busy || conflictBusy}
                  onChange={(event) => {
                    const path = event.target.value;
                    edited.current = true;
                    setDirectory(path);
                    setRows((old) =>
                      old.map((row) =>
                        editable(row)
                          ? {
                              ...row,
                              targetPath: childPath(path || ".", row.entry.name),
                              collision: "error",
                              version: undefined,
                            }
                          : row,
                      ),
                    );
                  }}
                />
              </label>
            )}
            {rows.map((row) => (
              <div
                key={row.entry.path}
                className="space-y-2 border-b border-border py-2 last:border-b-0"
              >
                <p className="break-all whitespace-pre-wrap text-sm">{row.entry.path}</p>
                {action.kind !== "delete" && (
                  <Textarea
                    aria-label={t(($) => $.files.targetNamed, {
                      path: row.entry.path ?? row.entry.name,
                    })}
                    rows={1}
                    value={row.targetPath}
                    disabled={busy || conflictBusy || !editable(row)}
                    onChange={(event) =>
                      updateRow(row, {
                        targetPath: event.target.value,
                        collision: "error",
                        version: undefined,
                      })
                    }
                  />
                )}
                {row.result && (
                  <div className="space-y-1 text-xs">
                    <p
                      className={
                        row.result.outcome === "succeeded"
                          ? "text-muted-foreground"
                          : "text-destructive"
                      }
                    >
                      {t(($) => $.files[row.result!.outcome])}
                    </p>
                    {!!row.result.completedItems && (
                      <p>
                        {t(($) => $.files.completedItems, { count: row.result.completedItems })}
                      </p>
                    )}
                    {row.result.error && !row.result.failures?.length && (
                      <ErrorNotice
                        error={
                          new ApiError(
                            row.result.error.code,
                            row.result.error.message,
                            row.result.outcome,
                            row.result.error.details,
                          )
                        }
                      />
                    )}
                    {row.result.failures?.map((failure, index) => (
                      <div key={index} className="break-all text-muted-foreground">
                        {failure.path}:{" "}
                        <ErrorNotice
                          error={
                            new ApiError(
                              failure.error.code,
                              failure.error.message,
                              "failed",
                              failure.error.details,
                            )
                          }
                        />
                      </div>
                    ))}
                    {row.result.truncated && <p>{t(($) => $.files.errorsOmitted)}</p>}
                  </div>
                )}
                {row.skipped && (
                  <p className="text-xs text-muted-foreground">{t(($) => $.common.skipped)}</p>
                )}
                {!busy && editable(row) && action.kind !== "delete" && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={conflictBusy}
                      onClick={() => void inspect(row)}
                    >
                      {t(($) => $.files.resolveConflict)}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={conflictBusy}
                      onClick={() => updateRow(row, { skipped: true })}
                    >
                      {t(($) => $.common.skip)}
                    </Button>
                  </div>
                )}
                {row.collision === "replace" && editable(row) && (
                  <p className="text-xs text-destructive">{t(($) => $.files.replaceConfirmed)}</p>
                )}
              </div>
            ))}
            {progress && busy && (
              <div role="status" className="space-y-1 text-xs text-muted-foreground">
                <p>
                  {progress.phase === "queued"
                    ? t(($) => $.common.queued)
                    : t(($) => $.files.completedItems, { count: progress.completedItems ?? 0 })}
                  {!!progress.bytes && ` · ${formatBytes(progress.bytes)}`}
                </p>
                <p className="truncate">{progress.currentPath}</p>
              </div>
            )}
            {invalid && (
              <p role="alert" className="text-sm text-destructive">
                {t(($) => $.files.targetPathRequired)}
              </p>
            )}
            {!!error && (
              <div role="alert" className="break-words text-sm text-destructive">
                <ErrorNotice error={error} />
              </div>
            )}
          </div>
          <DialogFooter>
            {busy ? (
              <Button
                variant="outline"
                disabled={cancelling}
                onClick={() => {
                  const request = current.current;
                  if (!request) return;
                  setCancelling(true);
                  void api(`/api/devices/${deviceId}/requests/${request.id}`, {
                    method: "DELETE",
                  }).catch((reason: unknown) => {
                    if (alive.current) {
                      setError(reason);
                      setCancelling(false);
                    }
                  });
                }}
              >
                {cancelling ? t(($) => $.common.cancelling) : t(($) => $.common.cancelOperation)}
              </Button>
            ) : (
              <Button variant="outline" onClick={onClose}>
                {t(($) => $.common.close)}
              </Button>
            )}
            {!busy && !!pending.length && (
              <Button
                variant={action.kind === "delete" ? "destructive" : "default"}
                disabled={conflictBusy}
                onClick={() => void run()}
              >
                <Icon />
                {rows.some((row) => row.result)
                  ? t(($) => $.files.retryIncomplete)
                  : t(($) => $.common[action.kind])}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {conflict && (
        <FileConflictDialog
          target={conflict.row.targetPath}
          inspection={conflict.inspection}
          directory={conflict.row.entry.kind === "directory"}
          onClose={() => setConflict(undefined)}
          onChoose={(targetPath, version) => {
            updateRow(conflict.row, {
              targetPath,
              collision: version ? "replace" : "error",
              version,
            });
            setConflict(undefined);
          }}
        />
      )}
    </>
  );
}
