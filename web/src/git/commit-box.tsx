import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Check } from "lucide-react";
import type { GitStatus } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { type GitActions, type GitTarget, useGitMessage } from "./actions";

export function CommitBox({
  target,
  actions,
  status,
  disabled,
  mobile,
}: {
  target: GitTarget;
  actions: GitActions;
  status?: GitStatus;
  disabled: boolean;
  mobile: boolean;
}) {
  const { t } = useTranslation();

  const message = useGitMessage(actions, target);
  const [open, setOpen] = useState(false);
  const available =
    !disabled && !!status?.stagedCount && !status.hasConflicts && !!status.indexToken;
  const submit = () => {
    if (!available || !message.trim() || !status?.indexToken) return;
    void actions.run(target, "git.commit", {
      message,
      indexToken: status.indexToken,
    });
    setOpen(false);
  };
  const input = (
    <Textarea
      aria-label={t(($) => $.git.commitMessage)}
      placeholder={t(($) => $.git.commitMessage)}
      rows={3}
      autoFocus={!mobile}
      value={message}
      onChange={(event) => actions.message(target, event.target.value)}
    />
  );
  const button = (
    <Button disabled={!available || !message.trim()} onClick={submit}>
      <Check />
      {t(($) => $.git.commit)}
    </Button>
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {mobile ? (
        <div className="shrink-0 border-t border-border p-2">
          <Button className="w-full" disabled={!available} onClick={() => setOpen(true)}>
            <Check />
            {t(($) => $.git.commit)}
          </Button>
        </div>
      ) : (
        <div className="flex min-h-11 shrink-0 items-center gap-1 border-t border-border p-1.5">
          <DialogTrigger
            render={
              <Button
                variant="outline"
                className="min-w-0 flex-1 justify-start"
                aria-label={t(($) => $.git.commitMessage)}
                title={message || t(($) => $.git.commitMessage)}
              />
            }
          >
            <span className={`truncate ${message ? "" : "text-muted-foreground"}`}>
              {message || t(($) => $.git.commitMessage)}
            </span>
          </DialogTrigger>
          {button}
        </div>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(($) => $.git.commit)}</DialogTitle>
        </DialogHeader>
        <div className="p-4">{input}</div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t(($) => $.common.cancel)}
          </Button>
          {button}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
