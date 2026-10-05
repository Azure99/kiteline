import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  Columns2,
  Copy,
  Maximize2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Rows2,
  Settings,
  Split,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Session } from "@kiteline/shared/protocol";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { Button } from "../components/ui/button";
import {
  groupFor,
  members,
  type MemberPosition,
  type SplitDirection,
  type TerminalLayout,
} from "./groups";

export type SessionCommand =
  | "rename"
  | "end"
  | "attach"
  | "redraw"
  | "larger"
  | "smaller"
  | "close";
export function SessionMenu({
  id,
  session,
  layout,
  mobile,
  dock,
  disabled,
  label,
  onCommand,
  onMove,
  onSplit,
  onDirection,
  onSettings,
}: {
  id?: string;
  session?: Session;
  layout: TerminalLayout;
  mobile: boolean;
  dock?: boolean;
  disabled: boolean;
  label?: string;
  onCommand(command: SessionCommand, id: string): void;
  onMove(id: string, target?: string, position?: MemberPosition): void;
  onSplit(direction: SplitDirection): void;
  onDirection(direction: SplitDirection): void;
  onSettings?(): void;
}) {
  const { t } = useTranslation();

  const group = id ? groupFor(layout, id) : undefined;
  const ids = group ? members(group) : [];
  const index = id ? ids.indexOf(id) : -1;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              label ?? (dock ? t(($) => $.terminal.dockActions) : t(($) => $.terminal.actions))
            }
          />
        }
      >
        <MoreHorizontal />
      </MenuTrigger>
      <MenuContent>
        {onSettings && (
          <MenuItem onClick={onSettings}>
            <Settings />
            {t(($) => $.terminal.settings)}
          </MenuItem>
        )}
        {id && (
          <>
            {!dock && !mobile && (
              <>
                <MenuItem disabled={disabled} onClick={() => onSplit("horizontal")}>
                  <Columns2 />
                  {t(($) => $.terminal.splitRight)}
                </MenuItem>
                <MenuItem disabled={disabled} onClick={() => onSplit("vertical")}>
                  <Rows2 />
                  {t(($) => $.terminal.splitDown)}
                </MenuItem>
                <MenuItem disabled={ids.length < 2} onClick={() => onMove(id)}>
                  <Split />
                  {t(($) => $.terminal.separateGroup)}
                </MenuItem>
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
                <MenuItem
                  disabled={index <= 0}
                  onClick={() => onMove(id, group!.id, { anchor: ids[index - 1]!, side: "before" })}
                >
                  <ArrowUp />
                  {t(($) => $.terminal.moveEarlier)}
                </MenuItem>
                <MenuItem
                  disabled={!group || index === ids.length - 1}
                  onClick={() => onMove(id, group!.id, { anchor: ids[index + 1]!, side: "after" })}
                >
                  <ArrowDown />
                  {t(($) => $.terminal.moveLater)}
                </MenuItem>
                <MenuItem disabled={ids.length < 2} onClick={() => onDirection("horizontal")}>
                  <Columns2 />
                  {t(($) => $.terminal.horizontal)}
                </MenuItem>
                <MenuItem disabled={ids.length < 2} onClick={() => onDirection("vertical")}>
                  <Rows2 />
                  {t(($) => $.terminal.vertical)}
                </MenuItem>
                <div className="my-1 border-t border-border" />
              </>
            )}
            {session && (
              <>
                <MenuItem onClick={() => onCommand("redraw", id)}>
                  <RefreshCw />
                  {t(($) => $.terminal.redrawProgram)}
                </MenuItem>
              </>
            )}
            <MenuItem onClick={() => onCommand("larger", id)}>
              <ZoomIn />
              {t(($) => $.terminal.fontLarger)}
            </MenuItem>
            <MenuItem onClick={() => onCommand("smaller", id)}>
              <ZoomOut />
              {t(($) => $.terminal.fontSmaller)}
            </MenuItem>
            {session && (
              <>
                <MenuItem onClick={() => onCommand("rename", id)}>
                  <Pencil />
                  {t(($) => $.common.rename)}
                </MenuItem>
                <MenuItem onClick={() => onCommand("attach", id)}>
                  <Copy />
                  {t(($) => $.terminal.localCommand)}
                </MenuItem>
              </>
            )}
            <MenuItem onClick={() => onCommand("close", id)}>
              <X />
              {t(($) => $.terminal.closeDisplay)}
            </MenuItem>
            {session && (
              <MenuItem onClick={() => onCommand("end", id)}>
                <Trash2 />
                {t(($) => $.terminal.endSession)}
              </MenuItem>
            )}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
