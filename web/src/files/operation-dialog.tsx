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
import { api, ApiError, errorMessage, rpc, rpcReply } from "../lib/api";
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
const names = { copy: "复制", move: "移动", delete: "删除" };
const outcomes = {
  succeeded: "已完成",
  failed: "未完成",
  partial: "部分完成",
  unknown: "结果未确认",
};

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
  const [error, setError] = useState("");
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
      setError("请输入 workspace 内的目标路径");
      return;
    }
    const submitted = pending.map((row) => ({ ...row }));
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    current.current = request;
    setBusy(true);
    setCancelling(false);
    setError("");
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
      if (reply.outcome !== "succeeded" && !reply.result?.items.length)
        setError(reply.error.message);
    } catch (reason) {
      if (!alive.current) return;
      setError(errorMessage(reason));
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
    setError("");
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
      if (alive.current) setError(errorMessage(reason));
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
              {names[action.kind]} · {rows.length}
            </DialogTitle>
          </DialogHeader>
          <div className="scroll-area min-h-0 space-y-3 overflow-auto p-4">
            {action.kind === "delete" ? (
              <p className="text-sm">
                永久删除
                {rows.some((row) => row.entry.kind === "directory")
                  ? "，包含目录内挂载的共用数据；挂载点可能保留"
                  : ""}
                ，不提供恢复。
              </p>
            ) : (
              <label className="block space-y-1 text-sm">
                <span>目标目录</span>
                <Textarea
                  aria-label="目标目录"
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
                    aria-label={`目标 ${row.entry.path}`}
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
                      {outcomes[row.result.outcome]}
                      {row.result.completedItems ? ` · ${row.result.completedItems} 项` : ""}
                      {row.result.error && !row.result.failures?.length
                        ? ` · ${row.result.error.message}`
                        : ""}
                    </p>
                    {row.result.failures?.map((failure, index) => (
                      <p key={index} className="break-all text-muted-foreground">
                        {failure.path}: {failure.error.message}
                      </p>
                    ))}
                    {row.result.truncated && <p>更多失败详情已省略</p>}
                  </div>
                )}
                {row.skipped && <p className="text-xs text-muted-foreground">已跳过</p>}
                {!busy && editable(row) && action.kind !== "delete" && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={conflictBusy}
                      onClick={() => void inspect(row)}
                    >
                      同名处理
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={conflictBusy}
                      onClick={() => updateRow(row, { skipped: true })}
                    >
                      跳过
                    </Button>
                  </div>
                )}
                {row.collision === "replace" && editable(row) && (
                  <p className="text-xs text-destructive">已确认替换目标目录项</p>
                )}
              </div>
            ))}
            {progress && busy && (
              <div role="status" className="space-y-1 text-xs text-muted-foreground">
                <p>
                  {progress.phase === "queued"
                    ? "等待执行"
                    : `已处理 ${progress.completedItems ?? 0} 项${progress.bytes ? ` · ${formatBytes(progress.bytes)}` : ""}`}
                </p>
                <p className="truncate">{progress.currentPath}</p>
              </div>
            )}
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
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
                      setError(errorMessage(reason));
                      setCancelling(false);
                    }
                  });
                }}
              >
                {cancelling ? "正在取消" : "取消操作"}
              </Button>
            ) : (
              <Button variant="outline" onClick={onClose}>
                关闭
              </Button>
            )}
            {!busy && !!pending.length && (
              <Button
                variant={action.kind === "delete" ? "destructive" : "default"}
                disabled={conflictBusy}
                onClick={() => void run()}
              >
                <Icon />
                {rows.some((row) => row.result) ? "重试未完成项" : names[action.kind]}
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
