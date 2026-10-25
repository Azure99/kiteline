import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import { Button } from "../components/ui/button";
import { useCopyFeedback } from "../lib/use-copy-feedback";

export function CliCommand({ command, label }: { command: string; label: string }) {
  const { t } = useTranslation();
  const { copied, copy, error } = useCopyFeedback();
  return (
    <div className="space-y-2">
      <pre
        aria-label={label}
        className="max-w-full overflow-x-auto whitespace-pre-wrap rounded border border-input bg-background p-3 font-mono text-xs"
      >
        <code>{command}</code>
      </pre>
      <Button variant="outline" onClick={() => void copy(command)}>
        <Copy />
        {copied === command ? t(($) => $.common.copied) : t(($) => $.cliSetup.copyCommand)}
      </Button>
      {error?.id === command && <ErrorNotice error={error.error} />}
    </div>
  );
}

export function CliLogin({ command }: { command: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p>{t(($) => $.cliSetup.loginHint)}</p>
      <CliCommand command={command} label={t(($) => $.cliSetup.loginCommand)} />
    </div>
  );
}
