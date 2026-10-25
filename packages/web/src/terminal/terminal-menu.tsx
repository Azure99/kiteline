import { useTranslation } from "react-i18next";
import {
  Columns2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RefreshCw,
  Rows2,
  Search,
  Settings,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { members, type SplitDirection, type TerminalGroup } from "./groups";

export function TerminalMenu({
  id,
  targetName,
  targetTitle,
  group,
  hasDisplay,
  canRedraw,
  mutationDisabled,
  mobile,
  onCommand,
  onSplit,
  onMaximize,
  onDirection,
  onSearch,
  onSettings,
}: {
  id?: string;
  targetName?: string;
  targetTitle?: string;
  group?: TerminalGroup;
  hasDisplay: boolean;
  canRedraw: boolean;
  mutationDisabled: boolean;
  mobile: boolean;
  onCommand(command: "redraw" | "larger" | "smaller", id: string): void;
  onSplit(direction: SplitDirection): void;
  onMaximize(): void;
  onDirection(direction: SplitDirection): void;
  onSearch(): void;
  onSettings(): void;
}) {
  const { t } = useTranslation();
  const multiple = !!group && members(group).length > 1;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={t(($) => $.terminal.regionActions)} />
        }
      >
        <MoreHorizontal />
      </MenuTrigger>
      <MenuContent>
        {targetName && (
          <div
            className="max-w-64 truncate px-2 py-1 text-xs text-muted-foreground"
            title={targetName}
          >
            {targetName}
          </div>
        )}
        {targetTitle && (
          <div className="max-w-64 whitespace-normal break-words px-2 pb-1 text-xs text-muted-foreground">
            {targetTitle}
          </div>
        )}
        <MenuItem disabled={!hasDisplay} onClick={onSearch}>
          <Search />
          {t(($) => $.terminal.search)}
        </MenuItem>
        {id && hasDisplay && (
          <>
            <MenuItem onClick={() => onCommand("larger", id)}>
              <ZoomIn />
              {t(($) => $.terminal.fontLarger)}
            </MenuItem>
            <MenuItem onClick={() => onCommand("smaller", id)}>
              <ZoomOut />
              {t(($) => $.terminal.fontSmaller)}
            </MenuItem>
            {canRedraw && (
              <MenuItem disabled={mutationDisabled} onClick={() => onCommand("redraw", id)}>
                <RefreshCw />
                {t(($) => $.terminal.redrawProgram)}
              </MenuItem>
            )}
          </>
        )}
        {!mobile && id && group && (
          <>
            <div className="my-1 border-t border-border" />
            <MenuItem disabled={mutationDisabled} onClick={() => onSplit("horizontal")}>
              <Columns2 />
              {t(($) => $.terminal.splitRight)}
            </MenuItem>
            <MenuItem disabled={mutationDisabled} onClick={() => onSplit("vertical")}>
              <Rows2 />
              {t(($) => $.terminal.splitDown)}
            </MenuItem>
            <MenuItem disabled={!multiple} onClick={onMaximize}>
              {group.maximized ? <Minimize2 /> : <Maximize2 />}
              {group.maximized ? t(($) => $.terminal.restoreSplit) : t(($) => $.terminal.maximize)}
            </MenuItem>
            <MenuItem disabled={!multiple} onClick={() => onDirection("horizontal")}>
              <Columns2 />
              {t(($) => $.terminal.horizontal)}
            </MenuItem>
            <MenuItem disabled={!multiple} onClick={() => onDirection("vertical")}>
              <Rows2 />
              {t(($) => $.terminal.vertical)}
            </MenuItem>
          </>
        )}
        <div className="my-1 border-t border-border" />
        <MenuItem onClick={onSettings}>
          <Settings />
          {t(($) => $.terminal.settings)}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
