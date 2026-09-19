import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import { Files, Circle, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { draftError, isDirty, showDraft, useDrafts, type DraftStore } from "./drafts";

export function OpenFiles({ store }: { store: DraftStore }) {
  const { t } = useTranslation();

  const drafts = useDrafts(store);
  const closing = drafts.find((item) => item.id === store.closing);
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={t(($) => $.files.openCount, { count: drafts.length })}
              disabled={!drafts.length}
            />
          }
        >
          <Files />
        </MenuTrigger>
        <MenuContent>
          {drafts.map((draft) => (
            <div key={draft.id} className="flex items-center">
              <MenuItem onClick={() => showDraft(draft)}>
                <span className="min-w-0 max-w-64 truncate" title={draft.path}>
                  {draft.deviceName} / {draft.workspaceName} / {draft.path}
                </span>
                {isDirty(draft) && <Circle size={7} fill="currentColor" />}
              </MenuItem>
              <IconButton
                label={t(($) => $.common.closeNamed, { name: draft.path })}
                onClick={() => store.requestClose(draft)}
              >
                <X />
              </IconButton>
            </div>
          ))}
        </MenuContent>
      </Menu>
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
              <Button variant="outline" onClick={() => store.close(closing)}>
                {t(($) => $.files.discardChanges)}
              </Button>
              <Button
                disabled={!store.canSave(closing)}
                onClick={() => {
                  void store.save(closing).then((saved) => {
                    if (saved && store.closing === closing.id && !isDirty(closing))
                      store.close(closing);
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
