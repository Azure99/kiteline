import { Dialog as Primitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { useTranslation } from "react-i18next";

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;

export function DialogContent({ className, children, ...props }: Primitive.Popup.Props) {
  const { t } = useTranslation();
  return (
    <Primitive.Portal>
      <Primitive.Backdrop className="dialog-backdrop fixed inset-0 z-40 bg-black/25" />
      <Primitive.Popup
        render={(props, state) => <div {...props} inert={!state.open} />}
        className={cn(
          "dialog-content fixed z-50 flex w-[calc(100%_-_32px)] max-w-[560px] flex-col overflow-hidden rounded-md border border-border bg-background shadow-xl outline-none",
          className,
        )}
        {...props}
      >
        <div className="absolute right-2 top-2">
          <Primitive.Close
            render={<Button variant="ghost" size="icon" aria-label={t(($) => $.common.close)} />}
          >
            <X />
          </Primitive.Close>
        </div>
        {children}
      </Primitive.Popup>
    </Primitive.Portal>
  );
}

export function DialogHeader({ children }: { children: React.ReactNode }) {
  return <div className="shrink-0 border-b border-border px-5 py-4 pr-14">{children}</div>;
}
export function DialogFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
      {children}
    </div>
  );
}
