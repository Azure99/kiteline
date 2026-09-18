import { useEffect, useRef, useState } from "react";
import { Copy, X, ExternalLink } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import { TouchSelection, type SelectionHandles } from "./touch-selection";
import { IconButton } from "../components/icon-button";
import { errorMessage } from "../lib/api";
import { deviceServiceLink } from "../lib/device-service";

export function TouchControls({
  terminal,
  deviceId,
  onError,
}: {
  terminal: Terminal;
  deviceId: string;
  onError: (message: string) => void;
}) {
  const [handles, setHandles] = useState<SelectionHandles>();
  const selection = useRef<TouchSelection>(undefined);
  const layer = useRef<HTMLDivElement>(null);
  const service = handles ? deviceServiceLink(terminal.getSelection(), deviceId) : undefined;
  const halfWidth = service ? 68 : 50;
  useEffect(() => {
    const current = new TouchSelection(terminal, setHandles);
    selection.current = current;
    return () => {
      current.dispose();
      selection.current = undefined;
      setHandles(undefined);
    };
  }, [terminal]);
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
                  aria-label={side === "start" ? "选区起点" : "选区终点"}
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
              label="复制所选文本"
              onClick={() =>
                void navigator.clipboard
                  .writeText(terminal.getSelection())
                  .catch((error: unknown) => onError(errorMessage(error)))
              }
            >
              <Copy />
            </IconButton>
            <IconButton label="取消选择" onClick={() => selection.current?.cancel()}>
              <X />
            </IconButton>
            {service && (
              <IconButton
                label={`访问设备端口 · ${deviceId}:${service.port}`}
                onClick={() => window.open(service.url, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink />
              </IconButton>
            )}
          </div>
        </>
      )}
    </div>
  );
}
