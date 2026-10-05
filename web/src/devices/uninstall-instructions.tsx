import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { AgentPlatformChoice, type AgentPlatform } from "./agent-platform";
import { IconButton } from "../components/icon-button";
import { ErrorNotice } from "../components/error-notice";
import { useCopyFeedback } from "../lib/use-copy-feedback";

export function UninstallInstructions({ initialPlatform }: { initialPlatform?: AgentPlatform }) {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<AgentPlatform>(initialPlatform ?? "linux");
  const { copied, error, copy, pending } = useCopyFeedback();
  const command =
    platform === "windows"
      ? '& "$PSHOME\\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\\kiteline-agent\\kiteline-agent.ps1" uninstall'
      : "sudo /usr/local/bin/kiteline-agent uninstall";
  return (
    <div className="space-y-3 text-sm">
      <h2 className="font-medium">{t(($) => $.devices.uninstallAgent)}</h2>
      <AgentPlatformChoice value={platform} onChange={setPlatform} />
      <p>{t(($) => $.devices.uninstallStop)}</p>
      {platform === "windows" && <p>{t(($) => $.devices.uninstallWindows)}</p>}
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
          {command}
        </pre>
        <IconButton
          label={copied === command ? t(($) => $.common.copied) : t(($) => $.devices.copyUninstall)}
          disabled={pending}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void copy(command)}
        >
          {copied === command ? <Check /> : <Copy />}
        </IconButton>
      </div>
      <p className="text-muted-foreground">{t(($) => $.devices.uninstallKeepsData)}</p>
      {error?.id === command && (
        <div role="alert" className="break-words text-destructive">
          <ErrorNotice error={error.error} />
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-muted-foreground">
          {t(($) => $.devices.containerDeployment)}
        </summary>
        <p className="mt-2">{t(($) => $.devices.uninstallContainer)}</p>
      </details>
    </div>
  );
}
