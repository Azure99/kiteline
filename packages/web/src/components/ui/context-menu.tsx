import { ContextMenu as Primitive } from "@base-ui/react/context-menu";
import { MenuPopup } from "./menu";

export const ContextMenu = Primitive.Root;
export function ContextMenuTrigger(props: Primitive.Trigger.Props) {
  return <Primitive.Trigger {...props} className="select-none" />;
}
export function ContextMenuContent({
  children,
  finalFocus,
}: {
  children: React.ReactNode;
  finalFocus?: Primitive.Popup.Props["finalFocus"];
}) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner className="z-50">
        <MenuPopup finalFocus={finalFocus}>{children}</MenuPopup>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
