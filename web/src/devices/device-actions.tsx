import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Device, Workspace } from "@kiteline/shared/protocol";
import { api, errorMessage, post, rpc } from "../lib/api";
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
  const renaming = action.type === "rename" || action.type === "workspace-rename";
  const target = "workspace" in action ? action.workspace : action.device;
  const [name, setName] = useState(target.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const title = {
    rename: "重命名设备",
    revoke: "撤销设备",
    "workspace-rename": "重命名 workspace",
    "workspace-remove": "移除 workspace",
  }[action.type];
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (action.type === "rename")
        await api(`/api/devices/${action.device.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name }),
        });
      else if (action.type === "revoke") await post(`/api/devices/${action.device.id}/revoke`);
      else if ("workspace" in action)
        await rpc(
          action.device.id,
          action.type === "workspace-rename" ? "workspaces.rename" : "workspaces.remove",
          { workspaceId: action.workspace.id, name },
        );
      if (mounted.current) onDone();
    } catch (error) {
      setError(errorMessage(error));
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
              <span>名称</span>
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
                  ? "将断开设备访问，重新接入需要再次绑定。设备上的任务继续运行。"
                  : "仅移除登记，设备上的目录和文件保留。"}
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
          <Button type="submit" variant={renaming ? "default" : "destructive"} disabled={busy}>
            {busy ? "正在处理" : renaming ? "保存" : action.type === "revoke" ? "撤销" : "移除"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
