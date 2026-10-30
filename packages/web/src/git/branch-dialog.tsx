import { useTranslation } from "react-i18next";
import { useState } from "react";
import { GitBranch } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ErrorNotice } from "../components/error-notice";
import { ApiError } from "../lib/api";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { type GitActions, type GitTarget, useGitActivity } from "./actions";

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
  const [attempted, setAttempted] = useState(false);
  const activity = useGitActivity(actions, target);
  const error = activity.request?.cancelError ?? activity.completion?.error;
  async function create() {
    if (!name.trim() || activity.request) return;
    setAttempted(true);
    const completion = await actions.run(target, "git.branch.create", {
      name: name.trim(),
      startOid,
      switch: switchTo,
    });
    if (!completion) return;
    if (
      completion.outcome === "failed" &&
      completion.error instanceof ApiError &&
      completion.error.code === "invalid_argument"
    ) {
      return;
    }
    onClose();
  }
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
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="space-y-3 overflow-auto p-4">
            <label className="block space-y-1 text-sm">
              <span>{t(($) => $.git.branchName)}</span>
              <Input
                autoFocus
                value={name}
                disabled={!!activity.request}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {startOid && (
              <p className="break-all font-mono text-xs text-muted-foreground">{startOid}</p>
            )}
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={switchTo}
                disabled={!!activity.request}
                onChange={(event) => setSwitchTo(event.target.checked)}
              />
              {t(($) => $.git.switchAfterCreate)}
            </label>
            {attempted && error && (
              <div role="alert" className="break-words text-sm text-destructive">
                <ErrorNotice error={error} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t(($) => $.common.cancel)}
            </Button>
            <Button type="submit" disabled={!name.trim() || !!activity.request}>
              <GitBranch />
              {t(($) => $.common.create)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
