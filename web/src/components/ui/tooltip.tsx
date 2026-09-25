import { Tooltip as Primitive } from "@base-ui/react/tooltip";

export const TooltipProvider = Primitive.Provider;
export const Tooltip = Primitive.Root;
export const TooltipTrigger = Primitive.Trigger;
export function TooltipContent({ children, ...props }: Primitive.Popup.Props) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner sideOffset={5} className="z-60">
        <Primitive.Popup
          className="tooltip-content max-w-xs rounded bg-foreground px-2 py-1 text-xs text-background shadow"
          {...props}
        >
          {children}
        </Primitive.Popup>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
