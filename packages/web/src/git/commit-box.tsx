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
  mobile,
  repoPath,
  offline,
  writing,
  reading,
}: {
  target: GitTarget;
  actions: GitActions;
  status?: GitStatus;
  mobile: boolean;
  repoPath: string;
  offline: boolean;
  writing: boolean;
  reading: boolean;
}) {
  const { t } = useTranslation();

  const message = useGitMessage(actions, target);
  const [open, setOpen] = useState(false);
  let blockedReason: string | undefined;
  if (offline) {
    blockedReason = t(($) => $.common.deviceOffline);
  } else if (writing) {
    blockedReason = t(($) => $.git.commitWriting);
  } else if (reading) {
    blockedReason = t(($) => $.git.commitReading);
  } else if (!status) {
    blockedReason = t(($) => $.git.commitNoStatus);
  } else if (status.hasConflicts) {
    blockedReason = t(($) => $.git.commitConflicts);
  } else if (!status.stagedCount) {
    blockedReason = t(($) => $.git.commitNoStaged);
  }
  const available = blockedReason === undefined;
  const reason = blockedReason ?? (!message.trim() ? t(($) => $.git.commitNoMessage) : undefined);
  const submit = () => {
    if (!status || reason !== undefined) return;
    void actions.run(target, "git.commit", {
      message,
      // Status includes an index token whenever conflicts do not block committing.
      indexToken: status.indexToken!,
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
    <Button disabled={reason !== undefined} onClick={submit}>
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
          {!available && reason && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {reason}
            </p>
          )}
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
        <div className="space-y-3 overflow-auto p-4">
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="break-all">
              {t(($) => $.git.repository)}:{" "}
              {repoPath === "." ? t(($) => $.git.workspaceRoot) : repoPath}
            </p>
            <p className="break-all" title={status?.head.oid ?? undefined}>
              {status?.branch ??
                (status?.head.oid
                  ? t(($) => $.git.detachedAt, { oid: status.head.oid.slice(0, 8) })
                  : t(($) => $.git.commitNoStatus))}
            </p>
            {status && <p>{t(($) => $.git.commitStagedCount, { count: status.stagedCount })}</p>}
          </div>
          {input}
          {reason && (
            <p role="status" className="text-xs text-muted-foreground">
              {reason}
            </p>
          )}
        </div>
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
