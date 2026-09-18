import { useState } from "react";
import { GitBranch } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { type GitActions, type GitTarget } from "./actions";

export function BranchDialog({
  target,
  actions,
  startOid,
  onClose,
}: {
  target: GitTarget;
  actions: GitActions;
  startOid?: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [switchTo, setSwitchTo] = useState(true);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建分支</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || actions.get(target).request) return;
            void actions.run(
              target,
              "git.branch.create",
              { name: name.trim(), startOid, switch: switchTo },
              "创建分支",
            );
            onClose();
          }}
        >
          <div className="space-y-3 p-4">
            <label className="block space-y-1 text-sm">
              <span>分支名称</span>
              <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            {startOid && (
              <p className="break-all font-mono text-xs text-muted-foreground">{startOid}</p>
            )}
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={switchTo}
                onChange={(event) => setSwitchTo(event.target.checked)}
              />
              创建后切换
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={!name.trim() || !!actions.get(target).request}>
              <GitBranch />
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
