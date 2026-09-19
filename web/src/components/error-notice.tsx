import { useTranslation } from "react-i18next";
import { ApiError, errorMessage } from "../lib/api";

export function ErrorNotice({ error, context }: { error: unknown; context?: "login" }) {
  useTranslation();
  return (
    <>
      {errorMessage(error, context)}
      <ErrorDetails error={error} />
    </>
  );
}

export function ErrorDetails({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (
    !(error instanceof ApiError) ||
    (error.details === undefined && error.outcome === undefined && error.result === undefined)
  )
    return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer">{t(($) => $.common.details)}</summary>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">
        {JSON.stringify(
          {
            code: error.code,
            message: error.message,
            outcome: error.outcome,
            details: error.details,
            result: error.result,
          },
          null,
          2,
        )}
      </pre>
    </details>
  );
}
