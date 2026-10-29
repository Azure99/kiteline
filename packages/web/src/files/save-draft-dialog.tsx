import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import { Button } from "../components/ui/button";
import { PathField } from "./path-field";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import type { Draft, DraftStore } from "./drafts";

export function SaveDraftDialog({
  store,
  draft,
  onClose,
  onSaved,
}: {
  store: DraftStore;
  draft: Draft;
  onClose(): void;
  onSaved(): void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState(() => {
    if (draft.path) return draft.path;
    const { folder } = draft.untitled!;
    return folder === "." ? "" : folder + "/";
  });
  const [error, setError] = useState<unknown>();
  const generation = useRef(0);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function close() {
    generation.current++;
    onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        initialFocus={() => {
          const input = field.current!;
          if (!draft.path) input.setSelectionRange(input.value.length, input.value.length);
          return input;
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {draft.path ? t(($) => $.files.saveAs) : t(($) => $.common.save)}
          </DialogTitle>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {draft.deviceName} / {draft.workspaceName}
          </p>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!store.canSave(draft)) return;
            setError(undefined);
            const submitted = ++generation.current;
            void store.save(draft, { kind: "create", path }).then((result) => {
              if (submitted !== generation.current || !store.has(draft)) return;
              if (result.kind === "saved") onSaved();
              else if (result.kind === "conflict" || result.kind === "failed")
                setError(result.error);
            });
          }}
          className="flex min-h-0 flex-col"
        >
          <div className="space-y-3 overflow-auto p-4">
            <label className="block space-y-1 text-sm">
              <span>{t(($) => $.files.savePath)}</span>
              <PathField
                ref={field}
                aria-label={t(($) => $.files.savePath)}
                rows={2}
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            {!!error && (
              <div role="alert" className="text-sm text-destructive">
                <ErrorNotice error={error} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t(($) => $.common.cancel)}
            </Button>
            <Button type="submit" disabled={!store.canSave(draft)}>
              {draft.path ? t(($) => $.files.saveCopy) : t(($) => $.common.save)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
