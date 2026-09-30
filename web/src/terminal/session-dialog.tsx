import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Copy } from "lucide-react";
import type { AgentEnvironment, Session } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { copyText } from "../lib/clipboard";
import { localCommand } from "./local-command";

export interface SessionAction {
  kind: "rename" | "end" | "copy";
  session: Session;
}
export function SessionDialog({
  action,
  busy,
  environment,
  onClose,
  onChange,
}: {
  action: SessionAction;
  busy: boolean;
  environment?: AgentEnvironment;
  onClose(): void;
  onChange(kind: "rename" | "end", id: string, name: string): Promise<boolean>;
}) {
  const { t } = useTranslation();

  const [name, setName] = useState(action.session.name);
  const [copiedCommand, setCopiedCommand] = useState<string>();
  const command = environment && localCommand(environment, action.session.id);
  const [error, setError] = useState<unknown>();
  async function copy() {
    if (!command) return;
    try {
      await copyText(command);
      setCopiedCommand(command);
      setError(undefined);
    } catch (error) {
      setError(error);
    }
  }
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
            {action.kind === "rename"
              ? t(($) => $.terminal.rename)
              : action.kind === "copy"
                ? t(($) => $.terminal.localAttach)
                : t(($) => $.terminal.endSession)}
          </DialogTitle>
        </DialogHeader>
        {action.kind === "rename" ? (
          <Input
            aria-label={t(($) => $.terminal.name)}
            value={name}
            maxLength={256}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        ) : action.kind === "copy" ? (
          <>
            <Input aria-label={t(($) => $.terminal.localCommand)} readOnly value={command ?? ""} />
            <p className="text-sm text-muted-foreground">{t(($) => $.terminal.detachHint)}</p>
            {!environment && <p role="alert">{t(($) => $.devices.environmentUnavailable)}</p>}
          </>
        ) : (
          <p className="break-words">
            {t(($) => $.terminal.endConfirm, { name: action.session.name })}
          </p>
        )}
        {!!error && (
          <div role="alert" className="text-sm text-destructive">
            <ErrorNotice error={error} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {action.kind === "copy" ? t(($) => $.common.close) : t(($) => $.common.cancel)}
          </Button>
          {action.kind === "copy" ? (
            <Button
              disabled={!command}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void copy()}
            >
              <Copy />
              {command && copiedCommand === command
                ? t(($) => $.common.copied)
                : t(($) => $.common.copy)}
            </Button>
          ) : (
            <Button
              variant={action.kind === "end" ? "destructive" : "default"}
              disabled={busy || (action.kind === "rename" && !name.trim())}
              onClick={() => {
                if (action.kind !== "copy")
                  void onChange(action.kind, action.session.id, name).then((done) => {
                    if (done) onClose();
                  });
              }}
            >
              {action.kind === "rename" ? t(($) => $.common.save) : t(($) => $.terminal.end)}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
