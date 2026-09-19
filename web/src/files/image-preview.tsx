import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Download, Maximize, RefreshCw, Scan, ZoomIn, ZoomOut } from "lucide-react";
import type { KitelineError, FileMeta } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { ApiError } from "../lib/api";
import { downloadFile, readImage, type FileTarget } from "./content";
import { formatBytes } from "./use-browser";

export function ImagePreview({ target, disabled }: { target: FileTarget; disabled: boolean }) {
  const { t, i18n } = useTranslation();

  const [image, setImage] = useState<{ url: string; meta: FileMeta }>();
  const [error, setError] = useState<unknown>();
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [attempt, setAttempt] = useState(0);
  const element = useRef<HTMLImageElement>(null);
  const scale = () =>
    zoom === "fit"
      ? (element.current?.getBoundingClientRect().width ?? 1) / (element.current?.naturalWidth || 1)
      : zoom;
  const { deviceId, workspaceId, path } = target;
  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController();
    let url: string | undefined, channelId: string | undefined, failure: ApiError | undefined;
    const failed = (event: Event) => {
      const message = (
        event as CustomEvent<{ type: string; channelId: string; error: KitelineError }>
      ).detail;
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
    void readImage({ deviceId, workspaceId, path }, controller.signal, (id) => {
      channelId = id;
    })
      .then(({ blob, meta }) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setError(undefined);
        setDecodeFailed(false);
        setImage({ url, meta });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(failure ?? reason);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      window.removeEventListener("kiteline:event", failed);
    };
  }, [deviceId, workspaceId, path, disabled, attempt]);
  return (
    <>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border px-3">
        <span
          className="min-w-16 flex-1 truncate text-xs max-[959px]:basis-full max-[959px]:py-2"
          title={path}
        >
          {path}
        </span>
        <IconButton label={t(($) => $.files.fitImage)} onClick={() => setZoom("fit")}>
          <Maximize />
        </IconButton>
        <IconButton label={t(($) => $.files.actualImage)} onClick={() => setZoom(1)}>
          <Scan />
        </IconButton>
        <IconButton
          label={t(($) => $.files.zoomOut)}
          disabled={!image || (typeof zoom === "number" && zoom <= 0.00001)}
          onClick={() => setZoom(scale() / 1.5)}
        >
          <ZoomOut />
        </IconButton>
        <IconButton
          label={t(($) => $.files.zoomIn)}
          disabled={!image || (typeof zoom === "number" && zoom >= 8)}
          onClick={() => setZoom(Math.min(8, scale() * 1.5))}
        >
          <ZoomIn />
        </IconButton>
        <IconButton
          label={t(($) => $.files.reloadImage)}
          disabled={disabled}
          onClick={() => {
            setError(undefined);
            setDecodeFailed(false);
            setImage(undefined);
            setAttempt((value) => value + 1);
          }}
        >
          <RefreshCw />
        </IconButton>
        <IconButton
          label={t(($) => $.files.downloadFile)}
          disabled={disabled}
          onClick={() => downloadFile(target)}
        >
          <Download />
        </IconButton>
      </div>
      {!!error && (
        <div role="alert" className="break-words px-3 py-2 text-sm text-destructive">
          <ErrorNotice error={error} />
        </div>
      )}
      {decodeFailed && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {t(($) => $.files.imageDecodeFailed)}
        </p>
      )}
      <div className="scroll-area min-h-0 flex-1 overflow-auto p-3">
        {image ? (
          <div
            className={
              zoom === "fit"
                ? "flex size-full items-center justify-center"
                : "min-h-full min-w-full"
            }
          >
            <img
              ref={element}
              src={image.url}
              alt={path}
              onError={() => setDecodeFailed(true)}
              className={
                zoom === "fit" ? "max-h-full max-w-full object-contain" : "mx-auto block max-w-none"
              }
              style={
                zoom === "fit"
                  ? undefined
                  : {
                      width: (element.current?.naturalWidth || image.meta.width!) * zoom,
                      height: "auto",
                    }
              }
            />
          </div>
        ) : (
          !error && (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              {disabled ? t(($) => $.common.deviceOffline) : t(($) => $.files.readingImage)}
            </p>
          )
        )}
      </div>
      {image && (
        <div className="flex min-h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-muted-foreground">
          {image.meta.width?.toLocaleString(i18n.resolvedLanguage)} ×{" "}
          {image.meta.height?.toLocaleString(i18n.resolvedLanguage)} ·{" "}
          {formatBytes(image.meta.size)}{" "}
          {typeof zoom === "number" && `· ${Math.round(zoom * 100)}%`}
        </div>
      )}
    </>
  );
}
