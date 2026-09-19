import { Menu as Primitive } from "@base-ui/react/menu";
import { Check } from "lucide-react";

export const Menu = Primitive.Root;
export const MenuTrigger = Primitive.Trigger;
export const MenuRadioGroup = Primitive.RadioGroup;
export function MenuRadioItem({ children, ...props }: Primitive.RadioItem.Props) {
  return (
    <Primitive.RadioItem
      className="flex min-h-8 cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted max-[959px]:min-h-11"
      {...props}
    >
      <span className="size-4 shrink-0">
        <Primitive.RadioItemIndicator>
          <Check size={16} />
        </Primitive.RadioItemIndicator>
      </span>
      {children}
    </Primitive.RadioItem>
  );
}
export function MenuContent({ children }: { children: React.ReactNode }) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner sideOffset={4} align="end" className="z-50">
        <Primitive.Popup className="max-h-[var(--available-height)] min-w-40 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-background p-1 shadow-lg outline-none">
          {children}
        </Primitive.Popup>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
export function MenuItem(props: Primitive.Item.Props) {
  return (
    <Primitive.Item
      className="flex min-h-8 cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-disabled:opacity-40 max-[959px]:min-h-11 [&_svg]:size-4"
      {...props}
    />
  );
}
