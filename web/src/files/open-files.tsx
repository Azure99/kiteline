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
              aria-label={`打开的文件 ${drafts.length}`}
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
              <IconButton label={`关闭 ${draft.path}`} onClick={() => store.requestClose(draft)}>
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
              <DialogTitle>保存修改？</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 overflow-auto p-4 text-sm">
              <p className="break-all">{closing.path}</p>
              {draftError(closing) && (
                <p role="alert" className="text-destructive">
                  {draftError(closing)}
                </p>
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
                取消
              </Button>
              <Button variant="outline" onClick={() => store.close(closing)}>
                放弃修改
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
                保存并关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
