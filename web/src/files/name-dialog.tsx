import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import type { Entry } from "@kiteline/shared/protocol";
import { rpc } from "../lib/api";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import { childPath } from "./paths";

export type NameAction =
  | { kind: "file" | "directory"; parent: string }
  | { kind: "rename"; entry: Entry };
export function FileNameDialog({
  deviceId,
  workspaceId,
  action,
  blocked,
  rename,
  onClose,
  onDone,
}: {
  deviceId: string;
  workspaceId: string;
  action: NameAction;
  blocked: boolean;
  rename: (path: string, name: string) => Promise<{ from: string; to: string }>;
  onClose: () => void;
  onDone: (result: { from?: string; to: string; entry?: Entry }) => void;
}) {
  const { t } = useTranslation();

  const input = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState(action.kind === "rename" ? action.entry.name : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [invalid, setInvalid] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const title =
    action.kind === "rename"
      ? t(($) => $.common.rename)
      : action.kind === "file"
        ? t(($) => $.files.newFile)
        : t(($) => $.files.newDirectory);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return;
    if (!name || name.includes("/") || name === "." || name === "..") {
      setError(undefined);
      setInvalid(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    setInvalid(false);
    try {
      const result =
        action.kind === "rename"
          ? await rename(action.entry.path!, name)
          : await rpc(deviceId, "files.create", {
              workspaceId,
              path: childPath(action.parent, name),
              kind: action.kind,
            }).then((entry) => ({ to: entry.path!, entry }));
      if (alive.current) onDone(result);
    } catch (error) {
      if (alive.current) setError(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          alive.current = false;
          onClose();
        }
      }}
    >
      <DialogContent initialFocus={input}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
          <div className="space-y-3 overflow-auto p-4">
            <p className="break-all text-xs text-muted-foreground">
              {action.kind === "rename" ? action.entry.path : action.parent}
            </p>
            <Textarea
              ref={input}
              aria-label={t(($) => $.common.name)}
              rows={2}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
            {invalid && (
              <p role="alert" className="text-sm text-destructive">
                {t(($) => $.files.nameRequired)}
              </p>
            )}
            {!!error && (
              <div role="alert" className="break-words text-sm text-destructive">
                <ErrorNotice error={error} />
              </div>
            )}
            {blocked && (
              <p role="status" className="text-sm">
                {t(($) => $.files.saving)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t(($) => $.common.cancel)}
            </Button>
            <Button type="submit" disabled={busy || blocked}>
              {busy ? t(($) => $.common.processing) : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
