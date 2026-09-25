import { useTranslation } from "react-i18next";
import { useState, type DragEvent } from "react";
import { Check, ChevronDown, Plus, RefreshCw, SquareTerminal } from "lucide-react";
import type { Session, Shortcut } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import type { TerminalGroup } from "./groups";

export function SessionPicker({
  sessions,
  selected,
  uncertain,
  dock,
  groups = [],
  retained = [],
  name,
  iconOnly = false,
  refreshDisabled,
  onRefresh,
  onDragStart,
  onDragEnd,
  onSelect,
}: {
  sessions: Session[];
  selected?: string;
  uncertain: boolean;
  dock: boolean;
  groups?: TerminalGroup[];
  retained?: string[];
  name(id: string): string;
  iconOnly?: boolean;
  refreshDisabled: boolean;
  onRefresh(): void;
  onDragStart?(event: DragEvent): void;
  onDragEnd?(): void;
  onSelect(id: string): void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const available = new Set([...sessions.map((session) => session.id), ...retained]);
  const grouped = new Set(groups.flatMap((group) => group.members));
  const other = [...available].filter((id) => !grouped.has(id));
  const label = dock ? t(($) => $.terminal.selectDock) : t(($) => $.terminal.selectSession);
  function item(id: string) {
    const session = sessions.find((value) => value.id === id);
    return (
      <MenuItem key={id} onClick={() => onSelect(id)}>
        <SquareTerminal />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="max-w-60 truncate" title={name(id)}>
            {name(id)}
          </span>
          {uncertain && session && (
            <span className="text-xs text-muted-foreground">
              {new Date(session.createdAt).toLocaleString(i18n.resolvedLanguage)}
            </span>
          )}
        </span>
        {(!session || session.state === "starting") && (
          <span className="text-xs text-muted-foreground">
            {session ? t(($) => $.terminal.starting) : t(($) => $.terminal.ended)}
          </span>
        )}
        {id === selected && <Check />}
      </MenuItem>
    );
  }

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          iconOnly ? (
            <IconButton label={label} />
          ) : (
            <Button
              variant="ghost"
              className="min-w-0 max-w-64 shrink"
              aria-label={label}
              draggable={!!onDragStart}
              onDragStart={(event) => {
                setOpen(false);
                onDragStart?.(event);
              }}
              onDragEnd={onDragEnd}
            />
          )
        }
      >
        <SquareTerminal />
        {!iconOnly && (
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
            {(groups.length > 1 || group.members.length > 1) && (
              <div className="px-2 py-1 text-xs text-muted-foreground">
                {t(($) => $.terminal.group, { number: index + 1 })}
              </div>
            )}
            {group.members.filter((id) => available.has(id)).map(item)}
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
  dock,
  disabled,
  onCreate,
  showLabel = false,
}: {
  shortcuts: Shortcut[];
  dock: boolean;
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
            aria-label={dock ? t(($) => $.terminal.newDock) : t(($) => $.terminal.new)}
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
            {shortcut.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
