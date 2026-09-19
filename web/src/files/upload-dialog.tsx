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
import { ApiError, errorMessage, rpc } from "../lib/api";
import { FileConflictDialog } from "./conflict-dialog";
import { uploadFile } from "./content";
import { childPath, formatBytes } from "./use-browser";

interface UploadRow {
  id: number;
  file: File;
  path: string;
  version?: string;
  sent: number;
  status: "pending" | "sending" | "succeeded" | "failed" | "unknown" | "skipped";
  error?: string;
  collision?: boolean;
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
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{ row: UploadRow; inspection: FileInspection }>();
  const active = useRef<AbortController>(undefined);
  const stop = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current = true;
      active.current?.abort();
    };
  }, []);
  const editable = (row: UploadRow) => row.status === "pending" || row.status === "failed";
  const update = (id: number, values: Partial<UploadRow>) => {
    if (alive.current)
      setRows((old) => old.map((row) => (row.id === id ? { ...row, ...values } : row)));
  };
  async function run() {
    const selected = rows.filter(editable);
    if (
      selected.some(
        (row) => !row.path || row.path.startsWith("/") || row.path.split("/").includes(".."),
      )
    ) {
      setError("请输入 workspace 内的目标路径");
      return;
    }
    setBusy(true);
    setError("");
    setCancelled(false);
    stop.current = false;
    for (const row of selected) {
      if (stop.current) break;
      const controller = new AbortController();
      active.current = controller;
      update(row.id, { status: "sending", sent: 0, error: undefined, collision: false });
      try {
        await uploadFile(
          { deviceId, workspaceId, path: row.path },
          row.file,
          row.version,
          controller.signal,
          (sent) => update(row.id, { sent }),
        );
        update(row.id, { status: "succeeded" });
        if (alive.current) onWritten(row.path);
      } catch (reason) {
        update(row.id, {
          status: reason instanceof ApiError && reason.outcome === "unknown" ? "unknown" : "failed",
          error:
            controller.signal.aborted && !(reason instanceof ApiError)
              ? "已取消"
              : errorMessage(reason),
          collision: reason instanceof ApiError && reason.code === "conflict",
        });
      } finally {
        active.current = undefined;
      }
    }
    if (alive.current) setBusy(false);
  }
  async function inspect(row: UploadRow) {
    setChecking(true);
    setError("");
    try {
      const inspection = await rpc(deviceId, "files.inspect", {
        workspaceId,
        path: row.path,
        suggestCopyName: true,
      });
      if (alive.current) setConflict({ row, inspection });
    } catch (reason) {
      if (alive.current) setError(errorMessage(reason));
    } finally {
      if (alive.current) setChecking(false);
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
            <DialogTitle>上传 · {rows.length}</DialogTitle>
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
                  aria-label={`上传目标 ${row.file.name}`}
                  rows={1}
                  value={row.path}
                  disabled={busy || checking || !editable(row)}
                  onChange={(event) =>
                    update(row.id, {
                      path: event.target.value,
                      version: undefined,
                      collision: false,
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
                        : "等待设备完成"}
                    </p>
                  </div>
                )}
                {row.status === "succeeded" && (
                  <p className="text-xs text-muted-foreground">已上传</p>
                )}
                {row.status === "skipped" && (
                  <p className="text-xs text-muted-foreground">已跳过</p>
                )}
                {row.version && editable(row) && (
                  <p className="text-xs text-destructive">已确认替换目标目录项</p>
                )}
                {row.error && (
                  <p role="alert" className="break-words text-xs text-destructive">
                    {row.error}
                  </p>
                )}
                {row.status === "unknown" && (
                  <p className="text-xs text-muted-foreground">先核对目标文件，再决定后续操作。</p>
                )}
                {!busy && editable(row) && (
                  <div className="flex gap-2">
                    <Button variant="outline" disabled={checking} onClick={() => void inspect(row)}>
                      同名处理
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={checking}
                      onClick={() => update(row.id, { status: "skipped" })}
                    >
                      跳过
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            {busy ? (
              <>
                <Button variant="outline" onClick={onHide}>
                  收起
                </Button>
                <Button
                  variant="outline"
                  disabled={cancelled}
                  onClick={() => {
                    stop.current = true;
                    setCancelled(true);
                    active.current?.abort();
                  }}
                >
                  {cancelled ? "正在取消" : "取消上传"}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={onClose}>
                关闭
              </Button>
            )}
            {!busy && rows.some(editable) && (
              <Button disabled={checking} onClick={() => void run()}>
                <Upload />
                上传
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
            update(conflict.row.id, { path, version, error: undefined, collision: false });
            setConflict(undefined);
          }}
        />
      )}
    </>
  );
}
