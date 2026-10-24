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
  Search,
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
  busy,
  mobile,
  label,
  onCommand,
  onMove,
  onDirection,
  onSettings,
  onSearch,
  searchDisabled,
}: {
  id?: string;
  session?: Session;
  layout: TerminalLayout;
  busy: boolean;
  mobile: boolean;
  label?: string;
  onCommand(command: SessionCommand, id: string): void;
  onMove(id: string, target?: string, position?: MemberPosition): void;
  onDirection(direction: SplitDirection): void;
  onSettings?(): void;
  onSearch?(): void;
  searchDisabled?: boolean;
}) {
  const { t } = useTranslation();

  const group = id ? groupFor(layout, id) : undefined;
  const ids = group ? members(group) : [];
  const index = id ? ids.indexOf(id) : -1;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={label ?? t(($) => $.terminal.actions)} />
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
        {onSearch && (
          <MenuItem disabled={searchDisabled} onClick={onSearch}>
            <Search />
            {t(($) => $.terminal.search)}
          </MenuItem>
        )}
        {id && (
          <>
            {!mobile && (
              <>
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
                <MenuItem disabled={busy} onClick={() => onCommand("rename", id)}>
                  <Pencil />
                  {t(($) => $.common.rename)}
                </MenuItem>
                <MenuItem onClick={() => onCommand("attach", id)}>
                  <Copy />
                  {t(($) => $.terminal.cliAttach)}
                </MenuItem>
              </>
            )}
            <MenuItem onClick={() => onCommand("close", id)}>
              <X />
              {t(($) => $.terminal.closeDisplay)}
            </MenuItem>
            {session && (
              <MenuItem disabled={busy} onClick={() => onCommand("end", id)}>
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
