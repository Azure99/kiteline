import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Maximize2,
  MoreHorizontal,
  Pencil,
  Split,
  Trash2,
  X,
} from "lucide-react";
import type { Session } from "@kiteline/shared/protocol";
import { MenuItem, MenuPopup } from "../components/ui/menu";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/ui/context-menu";
import { Button } from "../components/ui/button";
import { groupFor, members, type MemberPosition, type TerminalLayout } from "./groups";

export type TerminalCommand =
  | "rename"
  | "end"
  | "attach"
  | "redraw"
  | "larger"
  | "smaller"
  | "close";

export interface SessionMenuProps {
  id: string;
  session?: Session;
  targetName: string;
  targetTitle?: string;
  layout: TerminalLayout;
  mutationDisabled: boolean;
  mobile: boolean;
  canClose: boolean;
  label: string;
  onCommand(command: TerminalCommand, id: string): void;
  onMove(id: string, target?: string, position?: MemberPosition): void;
}

export function SessionObjectMenu({
  children,
  ...props
}: SessionMenuProps & { children: ReactElement }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent>
        <SessionMenuItems {...props} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function SessionSubmenu(props: SessionMenuProps) {
  return (
    <MenuPrimitive.SubmenuRoot>
      <MenuPrimitive.SubmenuTrigger
        nativeButton
        openOnHover={false}
        render={<Button variant="ghost" size="icon" aria-label={props.label} />}
      >
        <MoreHorizontal />
      </MenuPrimitive.SubmenuTrigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner side="right" align="start" sideOffset={4} className="z-50">
          <MenuPopup>
            <SessionMenuItems {...props} />
          </MenuPopup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.SubmenuRoot>
  );
}

function SessionMenuItems({
  id,
  session,
  targetName,
  targetTitle,
  layout,
  mutationDisabled,
  mobile,
  canClose,
  onCommand,
  onMove,
}: SessionMenuProps) {
  const { t } = useTranslation();
  const group = groupFor(layout, id);
  const ids = group ? members(group) : [];
  const index = ids.indexOf(id);
  return (
    <>
      <div className="max-w-64 truncate px-2 py-1 text-xs text-muted-foreground" title={targetName}>
        {targetName}
      </div>
      {targetTitle && (
        <div className="max-w-64 whitespace-normal break-words px-2 pb-1 text-xs text-muted-foreground">
          {targetTitle}
        </div>
      )}
      {session && (
        <>
          <MenuItem disabled={mutationDisabled} onClick={() => onCommand("rename", id)}>
            <Pencil />
            {t(($) => $.common.rename)}
          </MenuItem>
          <MenuItem onClick={() => onCommand("attach", id)}>
            <Copy />
            {t(($) => $.terminal.cliAttach)}
          </MenuItem>
        </>
      )}
      {!mobile && (
        <>
          {group && (
            <MenuItem disabled={ids.length < 2} onClick={() => onMove(id)}>
              <Split />
              {t(($) => $.terminal.separateGroup)}
            </MenuItem>
          )}
          {layout.groups
            .filter((item) => item !== group)
            .map((item) => (
              <MenuItem key={item.id} onClick={() => onMove(id, item.id)}>
                <Maximize2 />
                {t(($) => $.terminal.moveToGroup, {
                  number: layout.groups.indexOf(item) + 1,
                })}
              </MenuItem>
            ))}
          {group && (
            <>
              <MenuItem
                disabled={index <= 0}
                onClick={() => onMove(id, group.id, { anchor: ids[index - 1]!, side: "before" })}
              >
                <ArrowUp />
                {t(($) => $.terminal.moveEarlier)}
              </MenuItem>
              <MenuItem
                disabled={index === ids.length - 1}
                onClick={() => onMove(id, group.id, { anchor: ids[index + 1]!, side: "after" })}
              >
                <ArrowDown />
                {t(($) => $.terminal.moveLater)}
              </MenuItem>
              <div className="my-1 border-t border-border" />
            </>
          )}
        </>
      )}
      {canClose && (
        <MenuItem onClick={() => onCommand("close", id)}>
          <X />
          {t(($) => $.terminal.closeDisplay)}
        </MenuItem>
      )}
      {session && (
        <MenuItem disabled={mutationDisabled} onClick={() => onCommand("end", id)}>
          <Trash2 />
          {t(($) => $.terminal.endSession)}
        </MenuItem>
      )}
    </>
  );
}
