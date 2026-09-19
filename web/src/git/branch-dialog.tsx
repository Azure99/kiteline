import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();

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
          <DialogTitle>{t(($) => $.git.createBranch)}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || actions.get(target).request) return;
            void actions.run(target, "git.branch.create", {
              name: name.trim(),
              startOid,
              switch: switchTo,
            });
            onClose();
          }}
        >
          <div className="space-y-3 p-4">
            <label className="block space-y-1 text-sm">
              <span>{t(($) => $.git.branchName)}</span>
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
              {t(($) => $.git.switchAfterCreate)}
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t(($) => $.common.cancel)}
            </Button>
            <Button type="submit" disabled={!name.trim() || !!actions.get(target).request}>
              <GitBranch />
              {t(($) => $.common.create)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
