import { useTranslation } from "react-i18next";
import { Check, CircleX, Terminal } from "lucide-react";
import type { GitOperation } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { type GitActions, type GitTarget, useGitActivity } from "./actions";

export function OperationBar({
  operation,
  target,
  actions,
  disabled,
  onTerminal,
}: {
  operation: GitOperation;
  target: GitTarget;
  actions: GitActions;
  disabled: boolean;
  onTerminal: () => void;
}) {
  const { t } = useTranslation();

  const operationLabels = {
    merge: t(($) => $.git.operationMerge),
    rebase: t(($) => $.git.operationRebase),
    am: t(($) => $.git.operationAm),
    "cherry-pick": t(($) => $.git.operationCherryPick),
    revert: t(($) => $.git.operationRevert),
    unknown: t(($) => $.git.operationUnknown),
  };
  const operationLabel = operationLabels[operation.kind];
  const activity = useGitActivity(actions, target);
  const busy = disabled || !!activity.request;
  const expectedOperation = operation.token
    ? { kind: operation.kind, token: operation.token }
    : undefined;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-warning-soft px-3 py-2 text-xs">
      <div className="min-w-0 flex-1 basis-32">
        <p>{operationLabel}</p>
        {operation.reason && (
          <p className="mt-1 break-words text-muted-foreground">
            {operation.blocked === "conflicts"
              ? t(($) => $.git.resolveAndStageFirst)
              : operation.reason}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        disabled={busy || !operation.token || !operation.canContinue}
        onClick={() => {
          if (expectedOperation) void actions.run(target, "git.continue", { expectedOperation });
        }}
      >
        <Check />
        {t(($) => $.git.continue)}
      </Button>
      <Button
        variant="ghost"
        disabled={busy || !operation.token || !operation.canAbort}
        onClick={() => {
          if (!expectedOperation) return;
          if (window.confirm(t(($) => $.git.abortConfirm, { kind: operationLabel })))
            void actions.run(target, "git.abort", { expectedOperation });
        }}
      >
        <CircleX />
        {t(($) => $.git.abort)}
      </Button>
      <IconButton label={t(($) => $.git.useTerminal)} onClick={onTerminal}>
        <Terminal />
      </IconButton>
    </div>
  );
}
