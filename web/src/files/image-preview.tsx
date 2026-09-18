import { useEffect, useRef, useState } from "react";
import { Download, Maximize, RefreshCw, Scan, ZoomIn, ZoomOut } from "lucide-react";
import type { KitelineError, FileMeta } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { errorMessage } from "../lib/api";
import { downloadFile, readImage, type FileTarget } from "./content";
import { formatBytes } from "./use-browser";

export function ImagePreview({ target, disabled }: { target: FileTarget; disabled: boolean }) {
  const [image, setImage] = useState<{ url: string; meta: FileMeta }>();
  const [error, setError] = useState("");
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
    let url: string | undefined, channelId: string | undefined, failure: string | undefined;
    const failed = (event: Event) => {
      const message = (
        event as CustomEvent<{ type: string; channelId: string; error: KitelineError }>
      ).detail;
      if (message.type === "channel.failed" && message.channelId === channelId) {
        failure = message.error.message;
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
        setError("");
        setImage({ url, meta });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(failure ?? errorMessage(reason));
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
        <IconButton label="适合屏幕" onClick={() => setZoom("fit")}>
          <Maximize />
        </IconButton>
        <IconButton label="实际尺寸" onClick={() => setZoom(1)}>
          <Scan />
        </IconButton>
        <IconButton
          label="缩小图片"
          disabled={!image || (typeof zoom === "number" && zoom <= 0.00001)}
          onClick={() => setZoom(scale() / 1.5)}
        >
          <ZoomOut />
        </IconButton>
        <IconButton
          label="放大图片"
          disabled={!image || (typeof zoom === "number" && zoom >= 8)}
          onClick={() => setZoom(Math.min(8, scale() * 1.5))}
        >
          <ZoomIn />
        </IconButton>
        <IconButton
          label="重新读取图片"
          disabled={disabled}
          onClick={() => {
            setError("");
            setImage(undefined);
            setAttempt((value) => value + 1);
          }}
        >
          <RefreshCw />
        </IconButton>
        <IconButton label="下载文件" disabled={disabled} onClick={() => downloadFile(target)}>
          <Download />
        </IconButton>
      </div>
      {error && (
        <p role="alert" className="break-words px-3 py-2 text-sm text-destructive">
          {error}
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
              onError={() => setError("图片解码失败，可下载原文件")}
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
              {disabled ? "设备离线" : "正在读取图片"}
            </p>
          )
        )}
      </div>
      {image && (
        <div className="flex min-h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-muted-foreground">
          {image.meta.width} × {image.meta.height} · {formatBytes(image.meta.size)}{" "}
          {typeof zoom === "number" && `· ${Math.round(zoom * 100)}%`}
        </div>
      )}
    </>
  );
}
