import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Entry } from "@kiteline/shared/protocol";
import { ErrorNotice } from "../components/error-notice";
import { IconButton } from "../components/icon-button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { useCopyFeedback } from "../lib/use-copy-feedback";
import { formatBytes } from "./format";

export function FileDetails({
  entry,
  root,
  onClose,
}: {
  entry: Entry;
  root: string;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const { copy, copied, error } = useCopyFeedback();
  const separator = root.startsWith("/") ? "/" : "\\";
  const path =
    root + (root.endsWith(separator) ? "" : separator) + entry.path!.split("/").join(separator);
  const kind =
    entry.kind === "directory"
      ? t(($) => $.common.directory)
      : entry.kind === "file"
        ? t(($) => $.files.regularFile)
        : entry.kind === "symlink"
          ? t(($) => $.files.symbolicLink)
          : t(($) => $.files.specialFile);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(($) => $.files.details)}</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 overflow-auto p-5 text-sm [&>dt]:text-muted-foreground [&>dd]:min-w-0 [&>dd]:break-all [&>dd]:whitespace-pre-wrap">
          <dt>{t(($) => $.files.path)}</dt>
          <dd>{entry.path ?? entry.name}</dd>
          <dt>{t(($) => $.files.devicePath)}</dt>
          <dd>
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">{path}</span>
              <IconButton
                label={t(($) => $.files.copyDevicePath)}
                className="shrink-0"
                onClick={() => void copy(path)}
              >
                <Copy />
              </IconButton>
            </div>
            {copied === path && (
              <span role="status" className="text-xs text-muted-foreground">
                {t(($) => $.common.copied)}
              </span>
            )}
            {error?.id === path && (
              <div role="alert">
                <ErrorNotice error={error.error} />
              </div>
            )}
          </dd>
          <dt>{t(($) => $.files.type)}</dt>
          <dd>{kind}</dd>
          {entry.kind !== "directory" && (
            <>
              <dt>{t(($) => $.files.size)}</dt>
              <dd>{entry.kind === "symlink" ? "—" : formatBytes(entry.size)}</dd>
            </>
          )}
          {entry.mtime && (
            <>
              <dt>{t(($) => $.files.modified)}</dt>
              <dd>{new Date(entry.mtime).toLocaleString(i18n.resolvedLanguage)}</dd>
            </>
          )}
          {entry.linkTarget !== undefined && (
            <>
              <dt>{t(($) => $.files.linkDestination)}</dt>
              <dd>{entry.linkTarget}</dd>
            </>
          )}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
