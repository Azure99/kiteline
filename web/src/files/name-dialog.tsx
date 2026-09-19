import { useEffect, useRef, useState } from "react";
import type { Entry } from "@kiteline/shared/protocol";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import { childPath } from "./use-browser";

export type NameAction =
  | { kind: "file" | "directory"; parent: string }
  | { kind: "rename"; entry: Entry };
export function FileNameDialog({
  deviceId,
  workspaceId,
  action,
  rename,
  onClose,
  onDone,
}: {
  deviceId: string;
  workspaceId: string;
  action: NameAction;
  rename: (path: string, name: string) => Promise<{ from: string; to: string }>;
  onClose: () => void;
  onDone: (result: { from?: string; to: string; entry?: Entry }) => void;
}) {
  const [name, setName] = useState(action.kind === "rename" ? action.entry.name : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const title =
    action.kind === "rename" ? "重命名" : action.kind === "file" ? "新建文件" : "新建目录";
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name || name.includes("/") || name === "." || name === "..") {
      setError("请输入单个文件或目录名称");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result =
        action.kind === "rename"
          ? await rename(action.entry.path!, name)
          : await rpc(deviceId, "files.create", {
              workspaceId,
              path: childPath(action.parent, name),
              kind: action.kind,
            }).then((entry) => ({ to: entry.path!, entry }));
      if (alive.current) onDone(result);
    } catch (error) {
      if (alive.current) setError(errorMessage(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          alive.current = false;
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
          <div className="space-y-3 overflow-auto p-4">
            <p className="break-all text-xs text-muted-foreground">
              {action.kind === "rename" ? action.entry.path : action.parent}
            </p>
            <Textarea
              aria-label="名称"
              rows={2}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              disabled={busy}
            />
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "处理中" : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
