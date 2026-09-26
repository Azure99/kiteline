import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { ErrorNotice } from "../components/error-notice";
import { Circle, Copy, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { draftError, isDirty, useDrafts, type DraftStore } from "./drafts";
import { closeDraft, requestCloseDraft, showDraft, syncDraftPath } from "./navigation";
import { useRoute } from "../lib/navigation";
import { copyText } from "../lib/clipboard";

export function OpenFiles({
  store,
  open,
  onOpenChange,
}: {
  store: DraftStore;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const [copyError, setCopyError] = useState<unknown>();
  useEffect(() => {
    if (!open) setCopyError(undefined);
  }, [open]);

  const drafts = useDrafts(store);
  const closing = drafts.find((item) => item.id === store.closing);
  const route = useRoute();
  const selected = drafts.find(
    (draft) =>
      draft.deviceId === route.deviceId &&
      draft.workspaceId === route.workspaceId &&
      draft.id === route.query.draft,
  );
  const selectedPath = selected?.path;
  useEffect(() => {
    if (selected) syncDraftPath(selected);
  }, [selected, selectedPath, route.query.file]);
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.files.openCount, { count: drafts.length })}</DialogTitle>
          </DialogHeader>
          {!!copyError && (
            <div role="alert" className="px-4 text-sm text-destructive">
              <ErrorNotice error={copyError} />
            </div>
          )}
          <div className="scroll-area overflow-auto p-2">
            {drafts.map((draft) => (
              <div key={draft.id} className="flex items-center">
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 justify-start"
                  onClick={() => {
                    onOpenChange(false);
                    showDraft(draft);
                  }}
                >
                  <span
                    className="min-w-0 flex-1 text-left"
                    title={`${draft.deviceName} / ${draft.workspaceName} / ${draft.path}`}
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        {draft.path.slice(draft.path.lastIndexOf("/") + 1)}
                      </span>
                      {draft.path.includes("/") && (
                        <span className="max-w-1/2 truncate text-xs text-muted-foreground">
                          {draft.path.slice(0, draft.path.lastIndexOf("/"))}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {draft.deviceName} / {draft.workspaceName}
                    </span>
                  </span>
                  {isDirty(draft) && <Circle size={7} fill="currentColor" />}
                </Button>
                <IconButton
                  label={t(($) => $.files.copyText)}
                  disabled={!draft.state}
                  onClick={() => {
                    setCopyError(undefined);
                    void copyText(draft.state!.doc.toString()).catch(setCopyError);
                  }}
                >
                  <Copy size={13} />
                </IconButton>
                <IconButton
                  label={t(($) => $.common.closeNamed, { name: draft.path })}
                  onClick={() => requestCloseDraft(store, draft)}
                >
                  <X />
                </IconButton>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!closing}
        onOpenChange={(open) => {
          if (!open) {
            store.closing = undefined;
            store.changed();
          }
        }}
      >
        {closing && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(($) => $.files.saveChanges)}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 overflow-auto p-4 text-sm">
              <p className="break-all">{closing.path}</p>
              {draftError(closing) && (
                <div role="alert" className="text-destructive">
                  <ErrorNotice error={closing.error ?? closing.observationError} />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  store.closing = undefined;
                  store.changed();
                }}
              >
                {t(($) => $.common.cancel)}
              </Button>
              <Button variant="outline" onClick={() => closeDraft(store, closing)}>
                {t(($) => $.files.discardChanges)}
              </Button>
              <Button
                disabled={!store.canSave(closing)}
                onClick={() => {
                  void store.save(closing).then((saved) => {
                    if (saved && store.closing === closing.id && !isDirty(closing))
                      closeDraft(store, closing);
                  });
                }}
              >
                {t(($) => $.files.saveClose)}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
