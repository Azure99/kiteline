import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Download, Maximize, RefreshCw, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { IconButton } from "../components/icon-button";
import { downloadFile, type DiskImage, type FileTarget } from "./content";
import { formatBytes } from "./format";

export function ImagePreview({
  image,
  target,
  disabled,
  reloading,
  onReload,
}: {
  image: DiskImage;
  target: FileTarget;
  disabled: boolean;
  reloading: boolean;
  onReload(): void;
}) {
  const { t, i18n } = useTranslation();

  const [url, setUrl] = useState<string>();
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [naturalWidth, setNaturalWidth] = useState<number>();
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const element = useRef<HTMLImageElement>(null);
  const scale = () =>
    zoom === "fit"
      ? (element.current?.getBoundingClientRect().width ?? 1) / (element.current?.naturalWidth || 1)
      : zoom;
  const { path } = target;
  useEffect(() => {
    const url = URL.createObjectURL(image.blob);
    setUrl(url);
    setDecodeFailed(false);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  return (
    <>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border px-3">
        <span
          className="min-w-16 flex-1 truncate text-xs max-desk:basis-full max-desk:py-2"
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
          disabled={typeof zoom === "number" && zoom <= 0.00001}
          onClick={() => setZoom(scale() / 1.5)}
        >
          <ZoomOut />
        </IconButton>
        <IconButton
          label={t(($) => $.files.zoomIn)}
          disabled={typeof zoom === "number" && zoom >= 8}
          onClick={() => setZoom(Math.min(8, scale() * 1.5))}
        >
          <ZoomIn />
        </IconButton>
        <IconButton
          label={t(($) => $.files.reloadImage)}
          disabled={disabled || reloading}
          onClick={onReload}
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
      {decodeFailed && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {t(($) => $.files.imageDecodeFailed)}
        </p>
      )}
      <div className="scroll-area min-h-0 flex-1 overflow-auto p-3">
        {url && (
          <div
            className={
              zoom === "fit"
                ? "flex size-full items-center justify-center"
                : "min-h-full min-w-full"
            }
          >
            <img
              ref={element}
              src={url}
              alt={path}
              onLoad={(event) => setNaturalWidth(event.currentTarget.naturalWidth)}
              onError={() => setDecodeFailed(true)}
              className={
                zoom === "fit" ? "max-h-full max-w-full object-contain" : "mx-auto block max-w-none"
              }
              style={
                zoom === "fit"
                  ? undefined
                  : {
                      width: (naturalWidth ?? image.meta.width!) * zoom,
                      height: "auto",
                    }
              }
            />
          </div>
        )}
      </div>
      <div className="flex min-h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-muted-foreground">
        {image.meta.width?.toLocaleString(i18n.resolvedLanguage)} ×{" "}
        {image.meta.height?.toLocaleString(i18n.resolvedLanguage)} · {formatBytes(image.meta.size)}{" "}
        {typeof zoom === "number" && `· ${Math.round(zoom * 100)}%`}
      </div>
    </>
  );
}
