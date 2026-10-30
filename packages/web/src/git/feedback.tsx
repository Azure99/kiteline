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

  const { request, completion } = useGitActivity(actions, target);
  const error = request?.cancelError ?? completion?.error;
  const result = (error instanceof ApiError ? error.result : completion?.result) as
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
    "git.fetch": t(($) => $.git.fetch),
    "git.pull": t(($) => $.git.pull),
    "git.push": t(($) => $.git.push),
  };
  if (!request && !completion) return null;
  if (
    !request &&
    completion?.outcome === "succeeded" &&
    (completion.method === "git.stage" || completion.method === "git.unstage")
  )
    return null;
  const method = request?.method ?? completion?.method;
  const outcome = completion?.outcome;
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
  if (error?.message && !parts.includes(error.message) && error.message !== result?.stderr?.trim())
    parts.unshift(error.message);
  const diagnostic = parts.join("\n");
  let heading: string;
  if (request) {
    heading = t(($) => (request.phase === "queued" ? $.git.actionQueued : $.git.actionRunning), {
      action: actionNames[request.method],
    });
  } else {
    heading = [method && actionNames[method], outcome && outcomeLabels[outcome]]
      .filter(Boolean)
      .join(" · ");
  }
  return (
    <div className="max-h-40 shrink-0 overflow-auto border-b border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role={error ? "alert" : "status"}
          className={`min-w-0 flex-1 break-words ${error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {heading}
        </div>
        {request && (
          <Button
            variant="ghost"
            disabled={request.cancelling}
            onClick={() => void actions.cancel(target)}
          >
            {request.cancelling
              ? t(($) => $.common.cancelling)
              : t(($) => $.common.cancelOperation)}
          </Button>
        )}
        {!!error && (
          <Button variant="ghost" onClick={onTerminal}>
            {t(($) => $.common.terminal)}
          </Button>
        )}
        {!request && (
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
      {error instanceof ApiError && error.details !== undefined && (
        <details className="mt-1">
          <summary className="cursor-pointer py-1">{t(($) => $.common.details)}</summary>
          <pre className="break-words whitespace-pre-wrap">
            {JSON.stringify(
              {
                code: error.code,
                outcome: error.outcome,
                details: error.details,
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
        error={error}
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
