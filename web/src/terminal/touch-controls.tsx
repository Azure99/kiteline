import { useTranslation } from "react-i18next";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Copy, X, ExternalLink } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import { TouchSelection, type SelectionHandles } from "./touch-selection";
import { IconButton } from "../components/icon-button";
import { deviceServiceLink } from "../lib/device-service";
import { ErrorNotice } from "../components/error-notice";
import { copyText } from "../lib/clipboard";

export function TouchControls({
  terminal,
  deviceId,
  onTap,
}: {
  terminal: Terminal;
  deviceId: string;
  onTap: () => void;
}) {
  const { t } = useTranslation();

  const [handles, setHandles] = useState<SelectionHandles>();
  const [copying, setCopying] = useState(false);
  const [notice, setNotice] = useState<{ kind: "copied" } | { kind: "error"; error: unknown }>();
  const selection = useRef<TouchSelection>(undefined);
  const layer = useRef<HTMLDivElement>(null);
  const service = handles ? deviceServiceLink(terminal.getSelection(), deviceId) : undefined;
  const halfWidth = service ? 68 : 50;
  const tapped = useEffectEvent(onTap);
  useEffect(() => {
    const current = new TouchSelection(terminal, setHandles, tapped);
    selection.current = current;
    return () => {
      current.dispose();
      selection.current = undefined;
      setHandles(undefined);
      setNotice(undefined);
      setCopying(false);
    };
  }, [terminal]);
  useEffect(() => {
    if (notice?.kind !== "copied") return;
    const timer = setTimeout(() => setNotice(undefined), 1600);
    return () => clearTimeout(timer);
  }, [notice]);
  async function copy() {
    const current = selection.current;
    const text = terminal.getSelection();
    if (!current || !text || copying) return;
    const revision = current.revision;
    setCopying(true);
    try {
      await copyText(text);
      if (selection.current !== current) return;
      if (current.revision === revision) current.cancel();
      setNotice({ kind: "copied" });
    } catch (error) {
      if (selection.current === current) setNotice({ kind: "error", error });
    } finally {
      if (selection.current === current) setCopying(false);
    }
  }
  return (
    <div
      ref={layer}
      className="pointer-events-none absolute inset-0"
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          selection.current?.moveDrag({ x: event.clientX, y: event.clientY - 12 });
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        selection.current?.stopDrag(true);
      }}
      onPointerCancel={() => selection.current?.stopDrag(true)}
      onLostPointerCapture={() => selection.current?.stopDrag(true)}
    >
      {handles && (
        <>
          {(["start", "end"] as const).map((side) => {
            const point = handles[side];
            return (
              point && (
                <button
                  key={side}
                  aria-label={
                    side === "start"
                      ? t(($) => $.terminal.selectionStart)
                      : t(($) => $.terminal.selectionEnd)
                  }
                  className="terminal-selection-handle pointer-events-auto"
                  style={{
                    left: Math.max(0, Math.min(window.innerWidth - 44, point.x - 22)),
                    top: point.y - 4,
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    layer.current!.setPointerCapture(event.pointerId);
                    selection.current?.startDrag(side, { x: event.clientX, y: event.clientY - 12 });
                  }}
                >
                  <span />
                </button>
              )
            );
          })}
          <div
            className="terminal-selection-menu pointer-events-auto flex rounded border border-border bg-background text-foreground shadow-md"
            style={{
              left: Math.max(halfWidth, Math.min(window.innerWidth - halfWidth, handles.menu.x)),
              top: handles.menu.y,
            }}
            onPointerDown={(event) => event.preventDefault()}
          >
            <IconButton
              label={t(($) => $.terminal.copySelected)}
              disabled={copying}
              onClick={() => void copy()}
            >
              <Copy />
            </IconButton>
            <IconButton
              label={t(($) => $.terminal.cancelSelection)}
              onClick={() => selection.current?.cancel()}
            >
              <X />
            </IconButton>
            {service && (
              <IconButton
                label={t(($) => $.devices.openService, { device: deviceId, port: service.port })}
                onClick={() => window.open(service.url, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink />
              </IconButton>
            )}
          </div>
        </>
      )}
      {notice && (
        <div
          role={notice.kind === "copied" ? "status" : "alert"}
          className="absolute bottom-3 left-1/2 z-30 flex max-h-[50%] max-w-[calc(100%_-_24px)] items-start gap-2 overflow-auto rounded border border-border bg-background px-3 py-2 text-sm text-foreground shadow-md [transform:translateX(-50%)]"
          onPointerDown={(event) => event.preventDefault()}
        >
          {notice.kind === "copied" ? (
            t(($) => $.common.copied)
          ) : (
            <>
              <div className="pointer-events-auto min-w-0 break-words">
                <ErrorNotice error={notice.error} />
              </div>
              <IconButton
                className="pointer-events-auto"
                label={t(($) => $.common.dismiss)}
                onClick={() => setNotice(undefined)}
              >
                <X />
              </IconButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}
