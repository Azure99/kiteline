import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Device, Workspace } from "@kiteline/shared/protocol";
import { api, post, rpc } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

export type DeviceAction =
  | { type: "rename" | "revoke"; device: Device }
  | { type: "workspace-rename" | "workspace-remove"; device: Device; workspace: Workspace };
export function DeviceActionDialog({
  action,
  onDone,
}: {
  action: DeviceAction;
  onDone: () => void;
}) {
  const { t } = useTranslation();

  const renaming = action.type === "rename" || action.type === "workspace-rename";
  const target = "workspace" in action ? action.workspace : action.device;
  const [name, setName] = useState(target.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const title = {
    rename: t(($) => $.devices.renameDevice),
    revoke: t(($) => $.devices.revokeDevice),
    "workspace-rename": t(($) => $.devices.renameWorkspace),
    "workspace-remove": t(($) => $.devices.removeWorkspace),
  }[action.type];
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (action.type === "rename")
        await api(`/api/devices/${action.device.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name }),
        });
      else if (action.type === "revoke") await post(`/api/devices/${action.device.id}/revoke`);
      else if (action.type === "workspace-rename")
        await rpc(action.device.id, "workspaces.rename", {
          workspaceId: action.workspace.id,
          name,
        });
      else if (action.type === "workspace-remove")
        await rpc(action.device.id, "workspaces.remove", { workspaceId: action.workspace.id });
      if (mounted.current) onDone();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogContent>
      <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 overflow-auto p-5">
          {renaming ? (
            <label className="block space-y-2">
              <span>{t(($) => $.common.name)}</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={256}
                autoFocus
              />
            </label>
          ) : (
            <>
              <p className="break-all font-medium">{target.name}</p>
              <p className="text-sm text-muted-foreground">
                {action.type === "revoke"
                  ? t(($) => $.devices.revokeHint)
                  : t(($) => $.devices.removeHint)}
              </p>
            </>
          )}
          {!!error && (
            <div role="alert" className="text-sm text-destructive">
              <ErrorNotice error={error} />
            </div>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t(($) => $.common.cancel)}
          </DialogClose>
          <Button type="submit" variant={renaming ? "default" : "destructive"} disabled={busy}>
            {busy
              ? t(($) => $.auth.processing)
              : renaming
                ? t(($) => $.common.save)
                : action.type === "revoke"
                  ? t(($) => $.devices.revoke)
                  : t(($) => $.devices.remove)}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
