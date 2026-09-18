import { Menu as Primitive } from "@base-ui/react/menu";

export const Menu = Primitive.Root;
export const MenuTrigger = Primitive.Trigger;
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
