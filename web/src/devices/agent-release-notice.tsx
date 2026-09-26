import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import type { Device } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { UpgradeDialog } from "./upgrade-dialog";

export function AgentReleaseNotice({ device }: { device: Device }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const release = device.release;
  return (
    <>
      {device.status === "offline" && release && release.agentVersion !== release.serverVersion && (
        <div
          role="alert"
          className="flex h-28 shrink-0 flex-col items-start justify-center gap-2 border-b border-border bg-amber-50 px-4 py-2 text-sm sm:h-16 sm:flex-row sm:items-center"
        >
          <div
            className="w-full min-w-0 text-xs sm:w-auto sm:flex-1"
            title={t(($) => $.devices.versionObserved, {
              time: new Date(release.observedAt).toLocaleString(i18n.resolvedLanguage),
            })}
          >
            <p className="flex gap-1 font-medium">
              <span className="min-w-0 truncate" title={device.name}>
                {device.name}
              </span>
              <span className="shrink-0">· {t(($) => $.devices.versionMismatch)}</span>
            </p>
            <p className="break-words">
              {t(($) => $.devices.lastReportedVersions, {
                agent: release.agentVersion ?? t(($) => $.devices.versionUnknown),
                server: release.serverVersion,
              })}
            </p>
          </div>
          <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
            <Download />
            {t(($) => $.devices.viewUpgrade)}
          </Button>
        </div>
      )}
      {open && (
        <UpgradeDialog deviceName={device.name} trigger={trigger} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
