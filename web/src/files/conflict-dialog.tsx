import { useState } from "react";
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
import { childPath, parentPath } from "./use-browser";

export function FileConflictDialog({
  target,
  inspection,
  directory = false,
  onClose,
  onChoose,
}: {
  target: string;
  inspection: FileInspection;
  directory?: boolean;
  onClose: () => void;
  onChoose: (path: string, version?: string) => void;
}) {
  const suggested = inspection.suggestedName
    ? childPath(parentPath(target), inspection.suggestedName)
    : target;
  const [path, setPath] = useState(suggested);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>目标已存在</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 overflow-auto p-4">
          <p className="break-all text-sm">{target}</p>
          {inspection.entry.kind === "symlink" && (
            <div className="space-y-1 text-sm">
              <p className="break-all">链接目标：{inspection.entry.linkTarget}</p>
              <p>替换将移除符号链接，原目标文件不变。</p>
            </div>
          )}
          <label className="block space-y-1 text-sm">
            <span>保留两份的路径</span>
            <Textarea
              aria-label="保留两份的路径"
              rows={2}
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          {inspection.suggestedName && (
            <Button variant="ghost" onClick={() => setPath(suggested)}>
              使用建议名称
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="outline"
            disabled={directory || inspection.entry.kind === "directory"}
            onClick={() => onChoose(target, inspection.targetVersion)}
          >
            替换
          </Button>
          <Button disabled={!path || path === target} onClick={() => onChoose(path)}>
            保留两份
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
