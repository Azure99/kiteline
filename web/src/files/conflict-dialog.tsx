import { useTranslation } from "react-i18next";
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
import { childPath, parentPath } from "./paths";

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
  const { t } = useTranslation();

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
          <DialogTitle>{t(($) => $.files.targetExists)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 overflow-auto p-4">
          <p className="break-all text-sm">{target}</p>
          {inspection.entry.kind === "symlink" && (
            <div className="space-y-1 text-sm">
              <p className="break-all">
                {t(($) => $.files.linkTarget, { path: inspection.entry.linkTarget ?? "" })}
              </p>
              <p>{t(($) => $.files.replaceLink)}</p>
            </div>
          )}
          <label className="block space-y-1 text-sm">
            <span>{t(($) => $.files.keepBothPath)}</span>
            <Textarea
              aria-label={t(($) => $.files.keepBothPath)}
              rows={2}
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          {inspection.suggestedName && (
            <Button variant="ghost" onClick={() => setPath(suggested)}>
              {t(($) => $.files.suggestName)}
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t(($) => $.common.cancel)}
          </Button>
          <Button
            variant="outline"
            disabled={directory || inspection.entry.kind === "directory"}
            onClick={() => onChoose(inspection.entry.path!, inspection.targetVersion)}
          >
            {t(($) => $.files.replace)}
          </Button>
          <Button disabled={!path || path === target} onClick={() => onChoose(path)}>
            {t(($) => $.files.keepBoth)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
