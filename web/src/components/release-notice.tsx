import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { appVersion } from "@kiteline/shared/protocol";
import { useServerVersion, webCompatible } from "../lib/release";
import { Button } from "./ui/button";

export function ReleaseNotice() {
  const { t } = useTranslation();
  const serverVersion = useServerVersion();
  if (webCompatible()) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-amber-50 px-4 py-2 text-sm"
    >
      <p className="min-w-0 flex-1 basis-60 break-words">
        {t(($) => $.release.webMismatch, { web: appVersion, server: serverVersion! })}
      </p>
      <Button variant="outline" onClick={() => location.reload()}>
        <RefreshCw />
        {t(($) => $.release.reload)}
      </Button>
    </div>
  );
}
