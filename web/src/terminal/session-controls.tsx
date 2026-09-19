import { useTranslation } from "react-i18next";
import { ChevronDown, Plus, SquareTerminal } from "lucide-react";
import type { Session, Shortcut } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";

export function SessionPicker({
  sessions,
  selected,
  uncertain,
  dock,
  onSelect,
}: {
  sessions: Session[];
  selected?: string;
  uncertain: boolean;
  dock: boolean;
  onSelect(id: string): void;
}) {
  const { t, i18n } = useTranslation();

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            className="min-w-0 max-w-64 shrink"
            aria-label={dock ? t(($) => $.terminal.selectDock) : t(($) => $.terminal.selectSession)}
          />
        }
      >
        <SquareTerminal />
        <span className="truncate">
          {sessions.find((session) => session.id === selected)?.name ??
            (selected ? t(($) => $.terminal.ended) : t(($) => $.common.terminal))}
        </span>
        <ChevronDown />
      </MenuTrigger>
      <MenuContent>
        {sessions.map((session) => (
          <MenuItem key={session.id} onClick={() => onSelect(session.id)}>
            <SquareTerminal />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="max-w-60 truncate">{session.name}</span>
              {uncertain && (
                <span className="text-xs text-muted-foreground">
                  {new Date(session.createdAt).toLocaleString(i18n.resolvedLanguage)}
                </span>
              )}
            </span>
            {session.state === "starting" && (
              <span className="text-muted-foreground">{t(($) => $.terminal.starting)}</span>
            )}
          </MenuItem>
        ))}
        {!sessions.length && <MenuItem disabled>{t(($) => $.terminal.noSessions)}</MenuItem>}
      </MenuContent>
    </Menu>
  );
}
export function NewSessionButtons({
  shortcuts,
  dock,
  disabled,
  onCreate,
}: {
  shortcuts: Shortcut[];
  dock: boolean;
  disabled: boolean;
  onCreate(shortcutId?: string): void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <IconButton
        label={dock ? t(($) => $.terminal.newDock) : t(($) => $.terminal.new)}
        disabled={disabled}
        onClick={() => onCreate()}
      >
        <Plus />
      </IconButton>
      {!!shortcuts.length && (
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={t(($) => $.terminal.shortcutMenu)}
                disabled={disabled}
              />
            }
          >
            <ChevronDown />
          </MenuTrigger>
          <MenuContent>
            {shortcuts.map((shortcut) => (
              <MenuItem key={shortcut.id} onClick={() => onCreate(shortcut.id)}>
                {shortcut.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </>
  );
}
