import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { ApiError } from "../lib/api";
import { type GitActions, type GitTarget, useGitActivity } from "./actions";

export function GitPathDetails({
  error,
  renderBlocked,
}: {
  error: unknown;
  renderBlocked: (path: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const details =
    error instanceof ApiError
      ? (error.details as
          | { blockedPaths?: string[]; invalidPaths?: string[]; truncated?: boolean }
          | undefined)
      : undefined;
  return (
    <>
      {details?.blockedPaths?.map(renderBlocked)}
      {details?.invalidPaths?.map((path) => (
        <p key={path} className="break-all">
          {t(($) => $.git.invalidPath, { path })}
        </p>
      ))}
      {details?.truncated && <p>{t(($) => $.git.moreBlockedPaths)}</p>}
    </>
  );
}

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
  const result = (value.error instanceof ApiError ? value.error.result : value.result) as
    | {
        changedPaths?: string[];
        stdout?: string;
        stderr?: string;
        truncated?: boolean;
        commitOid?: string;
      }
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
  const method = value.request?.method ?? value.lastMethod;
  const outcome = value.completed
    ? "succeeded"
    : value.error instanceof ApiError
      ? value.error.outcome
      : undefined;
  const outcomeLabels = {
    succeeded: t(($) => $.files.succeeded),
    failed: t(($) => $.files.failed),
    partial: t(($) => $.files.partial),
    unknown: t(($) => $.files.unknown),
  };
  const parts = [
    ...new Set([result?.stdout, result?.stderr].filter((part): part is string => !!part)),
  ];
  // Git process errors copy stderr.trim() into message; display the original stderr once.
  if (
    value.error?.message &&
    !parts.includes(value.error.message) &&
    value.error.message !== result?.stderr?.trim()
  )
    parts.unshift(value.error.message);
  const diagnostic = parts.join("\n");
  return (
    <div className="max-h-40 shrink-0 overflow-auto border-b border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role={value.error ? "alert" : "status"}
          className={`min-w-0 flex-1 break-words ${value.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {value.request
            ? t(
                ($) =>
                  value.request!.phase === "queued" ? $.git.actionQueued : $.git.actionRunning,
                { action: actionNames[value.request.method] },
              )
            : [method && actionNames[method], outcome && outcomeLabels[outcome]]
                .filter(Boolean)
                .join(" · ")}
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
        {!value.request && (
          <IconButton label={t(($) => $.common.close)} onClick={() => actions.dismiss(target)}>
            <X />
          </IconButton>
        )}
      </div>
      {result?.commitOid && (
        <p className="mt-1 font-mono" title={result.commitOid}>
          {t(($) => $.git.commitResult)}: {result.commitOid.slice(0, 8)}
        </p>
      )}
      {diagnostic && <pre className="mt-1 break-words whitespace-pre-wrap">{diagnostic}</pre>}
      {result?.truncated && <p>{t(($) => $.git.outputTruncated)}</p>}
      {value.error instanceof ApiError && value.error.details !== undefined && (
        <details className="mt-1">
          <summary className="cursor-pointer py-1">{t(($) => $.common.details)}</summary>
          <pre className="break-words whitespace-pre-wrap">
            {JSON.stringify(
              {
                code: value.error.code,
                outcome: value.error.outcome,
                details: value.error.details,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
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
      <GitPathDetails
        error={value.error}
        renderBlocked={(path) => (
          <button
            key={path}
            className="block min-h-9 max-w-full text-left break-all text-primary"
            onClick={() => onLocate(path)}
          >
            {path}
          </button>
        )}
      />
    </div>
  );
}
