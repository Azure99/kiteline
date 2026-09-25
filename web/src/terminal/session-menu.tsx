import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  Columns2,
  Copy,
  Maximize2,
  MoreHorizontal,
  Pencil,
  Plus,
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
import { groupFor, type TerminalLayout } from "./groups";

export type SessionCommand = "rename" | "end" | "copy" | "redraw" | "larger" | "smaller" | "close";
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
  onMove(id: string, target?: string, before?: string): void;
  onSplit(): void;
  onDirection(direction: "horizontal" | "vertical"): void;
  onSettings?(): void;
}) {
  const { t } = useTranslation();

  const group = id ? groupFor(layout, id) : undefined;
  const index = group && id ? group.members.indexOf(id) : -1;
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
                <MenuItem disabled={disabled} onClick={onSplit}>
                  <Plus />
                  {t(($) => $.terminal.createSplit)}
                </MenuItem>
                <MenuItem disabled={!group || group.members.length < 2} onClick={() => onMove(id)}>
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
                  onClick={() => onMove(id, group!.id, group!.members[index - 1])}
                >
                  <ArrowUp />
                  {t(($) => $.terminal.moveEarlier)}
                </MenuItem>
                <MenuItem
                  disabled={!group || index === group.members.length - 1}
                  onClick={() => onMove(id, group!.id, group!.members[index + 2])}
                >
                  <ArrowDown />
                  {t(($) => $.terminal.moveLater)}
                </MenuItem>
                <MenuItem
                  disabled={!group || group.members.length < 2}
                  onClick={() => onDirection("horizontal")}
                >
                  <Columns2 />
                  {t(($) => $.terminal.horizontal)}
                </MenuItem>
                <MenuItem
                  disabled={!group || group.members.length < 2}
                  onClick={() => onDirection("vertical")}
                >
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
                <MenuItem onClick={() => onCommand("copy", id)}>
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
