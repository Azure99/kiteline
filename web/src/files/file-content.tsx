import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, RefreshCw } from "lucide-react";
import type { BrowserEvent } from "@kiteline/shared/protocol";
import { ErrorNotice } from "../components/error-notice";
import { IconButton } from "../components/icon-button";
import { ApiError } from "../lib/api";
import { currentRoute, isWorkspaceRoute, updateWorkspaceQuery } from "../lib/navigation";
import { showDraft } from "./navigation";
import { parentPath } from "./use-browser";
import { downloadFile, readContent, type DiskImage, type FileTarget } from "./content";
import type { DraftStore } from "./drafts";
import { ImagePreview } from "./image-preview";

export function FileContent({
  target,
  store,
  active,
}: {
  target: FileTarget & { deviceName: string; workspaceName: string };
  store: DraftStore;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [image, setImage] = useState<DiskImage>();
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const { deviceId, workspaceId, path, deviceName, workspaceName } = target;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const target = { deviceId, workspaceId, path, deviceName, workspaceName };
    if (store.find(target)) return;
    let channelId: string | undefined, failure: ApiError | undefined;
    const failed = (event: Event) => {
      const message = (event as CustomEvent<BrowserEvent>).detail;
      if (message.type === "channel.failed" && message.channelId === channelId) {
        failure = new ApiError(
          message.error.code,
          message.error.message,
          "failed",
          message.error.details,
        );
        setError(failure);
      }
    };
    window.addEventListener("kiteline:event", failed);
    setBusy(true);
    setError(undefined);
    void readContent(target, controller.signal, (id) => {
      channelId = id;
    })
      .then((content) => {
        if (controller.signal.aborted) return;
        const route = currentRoute();
        if (!isWorkspaceRoute(route, target) || route.tool !== "files" || route.query.file !== path)
          return;
        if (content.kind === "text") {
          const actual = { ...target, path: content.value.target.path };
          const draft = store.open(actual, content.value);
          showDraft(draft, true);
        } else {
          setImage(content.value);
          const actual = content.value.meta.targetPath!;
          if (actual !== path)
            updateWorkspaceQuery(target, { file: actual, folder: parentPath(actual) }, true);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(failure ?? reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      window.removeEventListener("kiteline:event", failed);
    };
  }, [deviceId, workspaceId, path, deviceName, workspaceName, active, attempt, store]);
  const reload = () => setAttempt((value) => value + 1);
  return (
    <>
      {!!error && (
        <div role="alert" className="break-words px-3 py-2 text-sm text-destructive">
          <ErrorNotice error={error} />
        </div>
      )}
      {image ? (
        <ImagePreview
          image={image}
          target={target}
          disabled={!active}
          reloading={busy}
          onReload={reload}
        />
      ) : (
        <>
          <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-3">
            <span className="min-w-0 flex-1 truncate text-xs" title={path}>
              {path}
            </span>
            <IconButton
              label={t(($) => $.common.retry)}
              disabled={!active || busy}
              onClick={reload}
            >
              <RefreshCw />
            </IconButton>
            <IconButton
              label={t(($) => $.files.downloadFile)}
              disabled={!active}
              onClick={() => downloadFile(target)}
            >
              <Download />
            </IconButton>
          </div>
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {active
              ? busy
                ? t(($) => $.common.reading)
                : t(($) => $.files.noText)
              : t(($) => $.common.deviceOffline)}
          </p>
        </>
      )}
    </>
  );
}
