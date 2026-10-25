import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import { limits, type Session, type Workspace } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ErrorNotice } from "../components/error-notice";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

export interface SessionAction {
  kind: "rename" | "end";
  session: Session;
}
export function SessionDialog({
  action,
  identity,
  mutationDisabled,
  busy,
  error,
  workspace,
  onClose,
  onChange,
}: {
  action: SessionAction;
  identity: string;
  mutationDisabled: boolean;
  busy: boolean;
  error?: unknown;
  workspace: Workspace;
  onClose(): void;
  onChange(kind: "rename" | "end", id: string, name: string): Promise<boolean>;
}) {
  const { t } = useTranslation();

  const { kind } = action;
  const [name, setName] = useState(action.session.name);
  const initiallySelected = useRef(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "rename" ? t(($) => $.terminal.rename) : t(($) => $.terminal.endSession)}
          </DialogTitle>
          <p className="mt-2 text-xs break-all text-muted-foreground">
            {workspace.name} / {identity}
          </p>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void onChange(kind, action.session.id, name).then((done) => {
              if (done) onClose();
            });
          }}
        >
          <div className="scroll-area min-h-0 space-y-3 overflow-auto p-5">
            {kind === "rename" ? (
              <Input
                aria-label={t(($) => $.terminal.name)}
                value={name}
                maxLength={limits.nameLength}
                onChange={(event) => setName(event.target.value)}
                onFocus={(event) => {
                  if (initiallySelected.current) return;
                  initiallySelected.current = true;
                  event.currentTarget.select();
                }}
                autoFocus
              />
            ) : (
              <p className="break-words">
                {t(($) => $.terminal.endConfirm, { name: action.session.name })}
              </p>
            )}
            {!!error && (
              <div role="alert" className="break-words text-sm text-destructive">
                <ErrorNotice error={error} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t(($) => $.common.cancel)}
            </Button>
            <Button
              variant={kind === "end" ? "destructive" : "default"}
              disabled={mutationDisabled || (kind === "rename" && !name.trim())}
              type="submit"
            >
              {kind === "rename" ? t(($) => $.common.save) : t(($) => $.terminal.end)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
