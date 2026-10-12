import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {draft.path ? t(($) => $.files.saveAs) : t(($) => $.common.save)}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError(undefined);
            const submitted = ++generation.current;
            void store.save(draft, path, null).then((saved) => {
              if (submitted !== generation.current || !store.has(draft)) return;
              if (saved) onSaved();
              else
                setError(
                  draft.error ?? draft.observationError ?? new Error("The file could not be saved"),
                );
            });
          }}
          className="flex min-h-0 flex-col"
        >
          <div className="space-y-3 overflow-auto p-4">
            <Textarea
              aria-label={t(($) => $.files.savePath)}
              autoCapitalize="none"
              rows={2}
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
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
