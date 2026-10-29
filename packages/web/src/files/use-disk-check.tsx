import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { ApiError } from "../lib/api";
import type { DiskText } from "./content";
import { DiskReader } from "./disk-reader";
import { isDirty, type Draft, type DraftStore } from "./drafts";

interface DiskDialog {
  disk?: DiskText;
  showDiskText: boolean;
  error?: unknown;
}

export function useDraftDiskCheck({
  store,
  draft,
  unavailable,
}: {
  store: DraftStore;
  draft: Draft;
  unavailable?: string;
}) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<DiskDialog>();
  const generation = useRef(0);
  useLayoutEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const busy = draft.operation?.kind;
  const available = !!(draft.path || draft.unknownSave);
  const disabled = !!busy || !!unavailable || !available;

  function close() {
    generation.current++;
    setDialog(undefined);
  }

  async function check(intent: "inspect" | "resolve-conflict" = "inspect") {
    const resolvingConflict = intent === "resolve-conflict";
    const requestGeneration = ++generation.current;
    const previous = dialog;
    const showDiskText = previous?.showDiskText ?? !resolvingConflict;
    if (resolvingConflict || previous) setDialog({ showDiskText });
    const result = await store.check(draft);
    if (requestGeneration !== generation.current || !store.has(draft)) return;

    switch (result.kind) {
      case "ignored":
        setDialog(previous);
        return;
      case "confirmed-save":
        close();
        return;
      case "read": {
        const changed = result.disk.meta.revision !== draft.revision;
        if (resolvingConflict || result.unconfirmedSave || changed) {
          setDialog({ disk: result.disk, showDiskText });
        } else {
          close();
        }
        return;
      }
      case "failed":
        if (resolvingConflict || previous) {
          setDialog({ showDiskText, error: result.error });
        } else {
          close();
        }
    }
  }

  async function save() {
    const requestGeneration = generation.current;
    const result = await store.save(draft);
    if (requestGeneration !== generation.current || !store.has(draft)) return;
    if (result.kind === "saved") close();
    else if (result.kind === "conflict") await check("resolve-conflict");
  }

  async function overwrite() {
    if (!dialog?.disk) return;
    const disk = dialog.disk;
    const requestGeneration = generation.current;
    const result = await store.save(draft, {
      kind: "overwrite",
      path: disk.target.path,
      revision: disk.meta.revision!,
    });
    if (requestGeneration !== generation.current || !store.has(draft)) return;
    if (result.kind === "saved") close();
    else if (result.kind === "conflict" || result.kind === "failed")
      setDialog({ ...dialog, error: result.error });
  }

  function loadDisk() {
    if (!dialog?.disk) return;
    if (isDirty(draft) && !window.confirm(t(($) => $.files.discardLoad))) return;
    try {
      store.replaceSource(draft, dialog.disk);
      close();
    } catch (error) {
      setDialog({ ...dialog, error });
    }
  }

  return {
    save,
    check,
    available,
    disabled,
    dialog: (
      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {dialog && (
          <DialogContent className={dialog.showDiskText ? "max-w-[960px]" : undefined}>
            <DialogHeader>
              <DialogTitle>{t(($) => $.files.diskChanged)}</DialogTitle>
            </DialogHeader>
            <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4">
              <p className="break-all text-xs">{dialog.disk?.target.path ?? draft.path}</p>
              {draft.error instanceof ApiError && draft.error.code === "conflict" && (
                <p className="text-sm">{t(($) => $.files.saveConflict)}</p>
              )}
              {busy === "checking" && <p role="status">{t(($) => $.files.checking)}</p>}
              {dialog.showDiskText && dialog.disk && <DiskReader disk={dialog.disk} />}
              {!!dialog.error && (
                <div role="alert" className="text-sm text-destructive">
                  <ErrorNotice error={dialog.error} />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                {t(($) => $.common.cancel)}
              </Button>
              {!!dialog.error && (
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void check("resolve-conflict")}
                >
                  {t(($) => $.files.checkDisk)}
                </Button>
              )}
              {!dialog.showDiskText && (
                <Button
                  variant="outline"
                  disabled={!dialog.disk}
                  onClick={() => setDialog({ ...dialog, showDiskText: true })}
                >
                  {t(($) => $.files.viewDisk)}
                </Button>
              )}
              {dialog.showDiskText && dialog.disk && (
                <Button variant="outline" disabled={!!busy} onClick={loadDisk}>
                  {t(($) => $.files.loadDisk)}
                </Button>
              )}
              <Button
                disabled={!dialog.disk || !!dialog.error || !store.canSave(draft) || !!unavailable}
                onClick={() => void overwrite()}
              >
                {t(($) => $.files.overwriteVersion)}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    ),
  };
}
