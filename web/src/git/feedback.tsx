import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import { Button } from "../components/ui/button";
import { ApiError } from "../lib/api";
import { type GitActions, type GitTarget, useGitActivity } from "./actions";

export function GitFeedback({
  actions,
  target,
  onLocate,
  onTerminal,
}: {
  actions: GitActions;
  target: GitTarget;
  onLocate: (path: string) => void;
  onTerminal: () => void;
}) {
  const { t } = useTranslation();

  const value = useGitActivity(actions, target);
  const details =
    value.error instanceof ApiError
      ? (value.error.details as
          | { blockedPaths?: string[]; invalidPaths?: string[]; truncated?: boolean }
          | undefined)
      : undefined;
  const result = (value.error instanceof ApiError ? value.error.result : value.result) as
    | { changedPaths?: string[]; stdout?: string; stderr?: string; truncated?: boolean }
    | undefined;
  const actionNames = {
    "git.stage": t(($) => $.git.stage),
    "git.unstage": t(($) => $.git.unstage),
    "git.commit": t(($) => $.git.commit),
    "git.discard": t(($) => $.git.discard),
    "git.branch.create": t(($) => $.git.createBranch),
    "git.branch.switch": t(($) => $.git.switchBranch),
    "git.branch.delete": t(($) => $.git.deleteBranch),
    "git.continue": t(($) => $.git.continue),
    "git.abort": t(($) => $.git.abort),
    "git.fetch": "Fetch",
    "git.pull": "Pull",
    "git.push": "Push",
  };
  if (!value.request && !value.error && !value.completed) return null;
  if (
    !value.request &&
    !value.error &&
    (value.completed === "git.stage" || value.completed === "git.unstage")
  )
    return null;
  return (
    <div className="max-h-40 shrink-0 overflow-auto border-b border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role={value.error ? "alert" : "status"}
          className={`min-w-0 flex-1 break-words ${value.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {value.error ? (
            <ErrorNotice error={value.error} />
          ) : value.request ? (
            t(
              ($) => (value.request!.phase === "queued" ? $.git.actionQueued : $.git.actionRunning),
              { action: actionNames[value.request.method] },
            )
          ) : (
            value.completed &&
            t(($) => $.git.actionCompleted, { action: actionNames[value.completed] })
          )}
        </div>
        {value.request && (
          <Button
            variant="ghost"
            disabled={value.request.cancelling}
            onClick={() => void actions.cancel(target)}
          >
            {value.request.cancelling
              ? t(($) => $.common.cancelling)
              : t(($) => $.common.cancelOperation)}
          </Button>
        )}
        {!!value.error && (
          <Button variant="ghost" onClick={onTerminal}>
            {t(($) => $.common.terminal)}
          </Button>
        )}
      </div>
      {!!result?.changedPaths?.length && (
        <div className="mt-1">
          <p>{t(($) => $.git.changedPaths)}</p>
          {result.changedPaths.map((path) => (
            <button
              key={path}
              className="block min-h-9 max-w-full text-left break-all text-primary"
              onClick={() => onLocate(path)}
            >
              {path}
            </button>
          ))}
        </div>
      )}
      {details?.blockedPaths?.map((path) => (
        <button
          key={path}
          className="block min-h-9 max-w-full text-left break-all text-primary"
          onClick={() => onLocate(path)}
        >
          {path}
        </button>
      ))}
      {details?.invalidPaths?.map((path) => (
        <p key={path} className="break-all">
          {t(($) => $.git.invalidPath, { path })}
        </p>
      ))}
      {details?.truncated && <p>{t(($) => $.git.moreBlockedPaths)}</p>}
      {(result?.stdout || result?.stderr) && (
        <details className="mt-1">
          <summary className="cursor-pointer py-1">{t(($) => $.git.output)}</summary>
          <pre className="break-words whitespace-pre-wrap">
            {result.stdout}
            {result.stderr}
          </pre>
          {result.truncated && <p>{t(($) => $.git.outputTruncated)}</p>}
        </details>
      )}
    </div>
  );
}
