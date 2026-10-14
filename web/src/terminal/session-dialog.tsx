import { useTranslation } from "react-i18next";
import { useState } from "react";
import { limits, type Device, type Session, type Workspace } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { RemoteAttach } from "../cli/remote-attach";

export interface SessionAction {
  kind: "rename" | "end" | "attach";
  session: Session;
}
export function SessionDialog({
  action,
  busy,
  device,
  workspace,
  onCliSetup,
  onClose,
  onChange,
}: {
  action: SessionAction;
  busy: boolean;
  device: Device;
  workspace: Workspace;
  onCliSetup(): void;
  onClose(): void;
  onChange(kind: "rename" | "end", id: string, name: string): Promise<boolean>;
}) {
  const { t } = useTranslation();

  const { kind } = action;
  const [name, setName] = useState(action.session.name);
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
            {kind === "rename"
              ? t(($) => $.terminal.rename)
              : kind === "attach"
                ? t(($) => $.terminal.cliAttach)
                : t(($) => $.terminal.endSession)}
          </DialogTitle>
        </DialogHeader>
        {kind === "rename" ? (
          <Input
            aria-label={t(($) => $.terminal.name)}
            value={name}
            maxLength={limits.nameLength}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        ) : kind === "attach" ? (
          <RemoteAttach
            device={device}
            workspace={workspace}
            session={action.session}
            onSetup={() => {
              onClose();
              onCliSetup();
            }}
          />
        ) : (
          <p className="break-words">
            {t(($) => $.terminal.endConfirm, { name: action.session.name })}
          </p>
        )}
        {kind !== "attach" && (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t(($) => $.common.cancel)}
            </Button>
            <Button
              variant={kind === "end" ? "destructive" : "default"}
              disabled={busy || (kind === "rename" && !name.trim())}
              onClick={() => {
                void onChange(kind, action.session.id, name).then((done) => {
                  if (done) onClose();
                });
              }}
            >
              {kind === "rename" ? t(($) => $.common.save) : t(($) => $.terminal.end)}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
