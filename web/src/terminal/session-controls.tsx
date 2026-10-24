import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { Check, ChevronDown, Plus, RefreshCw, SquareTerminal } from "lucide-react";
import type { Session, Shortcut } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { members, type TerminalGroup } from "./groups";
import { ShortcutIcon } from "./shortcut-icon";

export function SessionPicker({
  sessions,
  selected,
  groups = [],
  retained = [],
  name,
  refreshDisabled,
  onRefresh,
  onSelect,
  objectMenu,
  showLabel = false,
  showName = false,
}: {
  sessions: Session[];
  selected?: string;
  groups?: TerminalGroup[];
  retained?: string[];
  name(id: string): string;
  refreshDisabled: boolean;
  onRefresh(): void;
  onSelect(id: string): void;
  objectMenu(id: string): ReactNode;
  showLabel?: boolean;
  showName?: boolean;
}) {
  const { t } = useTranslation();
  const available = new Set([...sessions.map((session) => session.id), ...retained]);
  const grouped = new Set(groups.flatMap(members));
  const other = [...available].filter((id) => !grouped.has(id));
  const label = t(($) => $.terminal.selectSession);
  function item(id: string) {
    const session = sessions.find((value) => value.id === id);
    return (
      <div key={id} className="session-picker-row" role="none">
        <MenuItem aria-current={id === selected ? "true" : undefined} onClick={() => onSelect(id)}>
          <SquareTerminal />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="max-w-60 truncate" title={name(id)}>
              {name(id)}
            </span>
          </span>
          {(!session || session.state === "starting") && (
            <span className="text-xs text-muted-foreground">
              {session ? t(($) => $.terminal.starting) : t(($) => $.terminal.ended)}
            </span>
          )}
          {id === selected && <Check />}
        </MenuItem>
        {objectMenu(id)}
      </div>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          showLabel ? (
            <Button variant="outline" aria-label={label} />
          ) : showName ? (
            <Button variant="ghost" className="min-w-0 max-w-[45%] shrink" aria-label={label} />
          ) : (
            <IconButton label={label} />
          )
        }
      >
        <SquareTerminal />
        {showLabel && label}
        {!showLabel && showName && (
          <>
            <span className="truncate">
              {selected ? name(selected) : t(($) => $.common.terminal)}
            </span>
            <ChevronDown />
          </>
        )}
      </MenuTrigger>
      <MenuContent>
        {groups.map((group, index) => (
          <div
            key={group.id}
            role="group"
            aria-label={t(($) => $.terminal.group, { number: index + 1 })}
          >
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {t(($) => $.terminal.group, { number: index + 1 })}
            </p>
            {members(group)
              .filter((id) => available.has(id))
              .map(item)}
          </div>
        ))}
        {other.length > 0 && groups.length > 0 && <div className="my-1 border-t border-border" />}
        {other.map(item)}
        {!available.size && <MenuItem disabled>{t(($) => $.terminal.noSessions)}</MenuItem>}
        <div className="my-1 border-t border-border" />
        <MenuItem disabled={refreshDisabled} onClick={onRefresh}>
          <RefreshCw />
          {t(($) => $.terminal.refreshSessions)}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
export function NewSessionButtons({
  shortcuts,
  disabled,
  onCreate,
  showLabel = false,
}: {
  shortcuts: Shortcut[];
  disabled: boolean;
  onCreate(shortcutId?: string): void;
  showLabel?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant={showLabel ? "outline" : "ghost"}
            size={showLabel ? "default" : "icon"}
            aria-label={t(($) => $.terminal.new)}
            disabled={disabled}
          />
        }
      >
        <Plus />
        {showLabel && t(($) => $.terminal.new)}
      </MenuTrigger>
      <MenuContent>
        <MenuItem onClick={() => onCreate()}>
          <SquareTerminal />
          Shell
        </MenuItem>
        {shortcuts.map((shortcut) => (
          <MenuItem key={shortcut.id} onClick={() => onCreate(shortcut.id)}>
            <ShortcutIcon icon={shortcut.icon} />
            {shortcut.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
