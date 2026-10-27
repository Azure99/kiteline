import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { AgentPlatformChoice, type AgentPlatform } from "./agent-platform";
import { IconButton } from "../components/icon-button";
import { ErrorNotice } from "../components/error-notice";
import { useCopyFeedback } from "../lib/use-copy-feedback";
import { appVersion, type Device } from "@kiteline/shared/protocol";

export function UninstallInstructions({
  initialPlatform,
  release,
}: {
  initialPlatform?: AgentPlatform;
  release?: Device["release"];
}) {
  const { t, i18n } = useTranslation();
  const [platform, setPlatform] = useState<AgentPlatform | undefined>(initialPlatform);
  const [purge, setPurge] = useState(false);
  const supportsPurge = release?.agentVersion === appVersion;
  const { copied, error, copy, pending } = useCopyFeedback();
  const command =
    platform &&
    (platform === "windows"
      ? "powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'kiteline-agent/kiteline-agent.ps1') uninstall"
      : "sudo /usr/local/bin/kiteline-agent uninstall") + (purge ? " --purge" : "");
  return (
    <div className="space-y-3 text-sm">
      <h2 className="font-medium">{t(($) => $.devices.uninstallAgent)}</h2>
      <AgentPlatformChoice value={platform} onChange={setPlatform} />
      <p>{t(($) => $.devices.uninstallStop)}</p>
      {platform === "windows" && <p>{t(($) => $.devices.uninstallWindows)}</p>}
      {supportsPurge && (
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-2 text-xs text-muted-foreground">
            {t(($) => $.devices.uninstallMode)}
          </legend>
          {[false, true].map((value) => (
            <label key={String(value)} className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="uninstall-mode"
                checked={purge === value}
                onChange={() => setPurge(value)}
                className="size-4 accent-primary"
              />
              {value ? t(($) => $.devices.uninstallPurge) : t(($) => $.devices.uninstallKeep)}
            </label>
          ))}
        </fieldset>
      )}
      {command ? (
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
            {command}
          </pre>
          <IconButton
            label={
              copied === command ? t(($) => $.common.copied) : t(($) => $.devices.copyUninstall)
            }
            disabled={pending}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void copy(command)}
          >
            {copied === command ? <Check /> : <Copy />}
          </IconButton>
        </div>
      ) : (
        <p>{t(($) => $.devices.selectPlatform)}</p>
      )}
      <p className="text-muted-foreground">
        {purge ? t(($) => $.devices.uninstallPurgesData) : t(($) => $.devices.uninstallKeepsData)}
      </p>
      {!supportsPurge && <p>{t(($) => $.devices.uninstallUpgrade)}</p>}
      <a
        className="text-primary underline"
        href={`https://github.com/Azure99/kiteline/blob/main/docs/guide/devices${i18n.language.startsWith("zh") ? ".md#卸载" : ".en.md#uninstall"}`}
        target="_blank"
        rel="noreferrer"
      >
        {t(($) => $.devices.uninstallGuide)}
      </a>
      {error && error.id === command && (
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
