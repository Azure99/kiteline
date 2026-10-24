import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Dialog } from "@base-ui/react/dialog";

export function EdgePanel({
  id,
  side,
  mobile,
  open,
  onClose,
  returnFocus,
  label,
  className,
  children,
  desktopWidth,
  onDesktopWidthChange,
}: {
  id: string;
  side: "left" | "right";
  mobile: boolean;
  open: boolean;
  onClose(): void;
  returnFocus: RefObject<HTMLElement | null> | (() => HTMLElement | null);
  label: string;
  className: string;
  children: ReactNode;
  desktopWidth?: number;
  onDesktopWidthChange(width: number): void;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div className="contents" ref={setHost} />
      <Dialog.Root
        open={open}
        modal={mobile}
        disablePointerDismissal={!mobile}
        onOpenChange={(value, eventDetails) => {
          if (value) return;
          if (mobile) onClose();
          else {
            eventDetails.cancel();
            eventDetails.allowPropagation();
          }
        }}
      >
        {host && (
          <Dialog.Portal container={host} keepMounted className="contents">
            {mobile && <Dialog.Backdrop className="edge-panel-backdrop" />}
            <Dialog.Popup
              id={id}
              render={<aside />}
              role={mobile ? "dialog" : "complementary"}
              aria-label={label}
              {...(!mobile ? { hidden: !open } : {})}
              initialFocus={mobile ? undefined : false}
              finalFocus={
                mobile
                  ? () => {
                      const target =
                        typeof returnFocus === "function" ? returnFocus() : returnFocus.current;
                      const active = document.activeElement;
                      if (
                        document.querySelector('.edge-panel[data-mobile="true"][data-open]') ||
                        (active &&
                          active !== document.body &&
                          !document.getElementById(id)?.contains(active))
                      )
                        return false;
                      if (target?.tabIndex === -1) {
                        target.focus({ preventScroll: true });
                        return false;
                      }
                      return target;
                    }
                  : false
              }
              className={`${className} edge-panel`}
              style={
                {
                  "--edge-width": desktopWidth === undefined ? undefined : `${desktopWidth}px`,
                } as CSSProperties
              }
              data-edge={side}
              data-mobile={mobile}
            >
              {children}
              {!mobile && open && (
                <WidthHandle
                  side={side}
                  label={label}
                  requestedWidth={desktopWidth}
                  onChange={onDesktopWidthChange}
                />
              )}
            </Dialog.Popup>
          </Dialog.Portal>
        )}
      </Dialog.Root>
    </>
  );
}

function WidthHandle({
  side,
  label,
  requestedWidth,
  onChange,
}: {
  side: "left" | "right";
  label: string;
  requestedWidth?: number;
  onChange(width: number): void;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number }>(undefined);
  const [size, setSize] = useState({ current: 0, min: 0, max: 0 });
  const measure = useCallback(() => {
    const panel = handle.current!.closest<HTMLElement>(".edge-panel")!;
    const other = document.querySelector<HTMLElement>(
      '.edge-panel[data-mobile="false"][data-edge="' +
        (side === "left" ? "right" : "left") +
        '"]:not([hidden])',
    );
    const main = document.getElementById("workbench-main")!;
    const style = getComputedStyle(panel);
    const min = parseFloat(style.minWidth);
    return {
      current: panel.getBoundingClientRect().width,
      min,
      max: Math.max(
        min,
        Math.min(
          parseFloat(style.maxWidth),
          innerWidth -
            (other?.getBoundingClientRect().width ?? 0) -
            parseFloat(getComputedStyle(main).minWidth),
        ),
      ),
    };
  }, [side]);
  const updateSize = useEffectEvent(() => {
    const next = measure();
    setSize(next);
    if (requestedWidth !== undefined && next.current + 0.5 < requestedWidth) onChange(next.current);
  });
  useLayoutEffect(() => {
    const panel = handle.current!.closest<HTMLElement>(".edge-panel")!;
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(panel);
    observer.observe(document.getElementById("workbench-main")!);
    updateSize();
    return () => observer.disconnect();
  }, [measure]);
  function resize(width: number) {
    const bounds = measure();
    onChange(Math.min(bounds.max, Math.max(bounds.min, width)));
  }
  return (
    <div
      ref={handle}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.round(size.min)}
      aria-valuemax={Math.round(size.max)}
      aria-valuenow={Math.round(size.current)}
      className="edge-width-handle"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = { x: event.clientX, width: measure().current };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        resize(drag.current.width + (event.clientX - drag.current.x) * (side === "left" ? 1 : -1));
      }}
      onPointerUp={() => {
        drag.current = undefined;
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
      }}
      onKeyDown={(event) => {
        const bounds = measure();
        if (event.key === "Home") resize(bounds.min);
        else if (event.key === "End") resize(bounds.max);
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          resize(
            bounds.current + (event.key === "ArrowRight" ? 10 : -10) * (side === "left" ? 1 : -1),
          );
        } else return;
        event.preventDefault();
      }}
    />
  );
}
