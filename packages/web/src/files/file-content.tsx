import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, RefreshCw } from "lucide-react";
import { ErrorNotice } from "../components/error-notice";
import { IconButton } from "../components/icon-button";
import { currentRoute, isWorkspaceRoute } from "../lib/navigation";
import { downloadFile, readContent, type DiskImage, type FileTarget } from "./content";
import type { Draft, DraftStore } from "./drafts";
import { ImagePreview } from "./image-preview";

export function FileContent({
  target,
  store,
  active,
  onResolvePath,
}: {
  target: FileTarget & { deviceName: string; workspaceName: string };
  store: DraftStore;
  active: boolean;
  onResolvePath(requested: string, actual: string, draft?: Draft): void;
}) {
  const { t } = useTranslation();
  const [image, setImage] = useState<DiskImage>();
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const { deviceId, workspaceId, path, deviceName, workspaceName } = target;
  const resolvePath = useEffectEvent(onResolvePath);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const target = { deviceId, workspaceId, path, deviceName, workspaceName };
    if (store.find(target)) return;
    setBusy(true);
    setError(undefined);
    void readContent(target, controller.signal)
      .then((content) => {
        if (controller.signal.aborted) return;
        const route = currentRoute();
        if (!isWorkspaceRoute(route, target)) return;
        if (content.kind === "text") {
          const actual = { ...target, path: content.value.target.path };
          const draft = store.open(actual, content.value);
          resolvePath(path, actual.path, draft);
        } else {
          setImage(content.value);
          const actual = content.value.meta.targetPath!;
          resolvePath(path, actual);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
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
