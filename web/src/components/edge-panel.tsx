import { useState, type ReactNode, type RefObject } from "react";
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
              data-edge={side}
              data-mobile={mobile}
            >
              {children}
            </Dialog.Popup>
          </Dialog.Portal>
        )}
      </Dialog.Root>
    </>
  );
}
