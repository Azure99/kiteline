import { useTranslation } from "react-i18next";
import { useRef, type ReactNode } from "react";
import { Check, ChevronDown, Plus, RefreshCw, SquareTerminal } from "lucide-react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { Session, Shortcut } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { members, type TerminalGroup } from "./groups";
import { ShortcutIcon } from "./shortcut-icon";
import { ReportMark, ReportSummary, type ReceivedReport } from "./reports";

export type SessionPickerVariant = "icon" | "current" | "label";

export function SessionPicker({
  variant,
  sessions,
  selected,
  groups,
  retained,
  reports,
  name,
  refreshDisabled,
  onRefresh,
  onSelect,
  focusOnKeyboard,
  onSelectionComplete,
  objectMenu,
  onShowGroup,
}: {
  variant: SessionPickerVariant;
  sessions: Session[];
  selected?: string;
  groups: TerminalGroup[];
  retained: string[];
  reports: ReadonlyMap<string, ReceivedReport>;
  name(id: string): string;
  refreshDisabled: boolean;
  onRefresh(): void;
  onSelect(id: string, keyboard: boolean): void;
  focusOnKeyboard: boolean;
  onSelectionComplete(): void;
  objectMenu(id: string): ReactNode;
  onShowGroup?(id: string, shown: boolean): void;
}) {
  const { t } = useTranslation();
  const keyboardSelection = useRef(false);
  const available = new Set([...sessions.map((session) => session.id), ...retained]);
  const grouped = new Set(groups.flatMap(members));
  const other = [...available].filter((id) => !grouped.has(id));
  const label = t(($) => $.terminal.selectSession);
  // Another session needs attention even when its tab is not visible.
  const elsewhere = [...reports.keys()].some((id) => id !== selected && available.has(id));
  function item(id: string) {
    const session = sessions.find((value) => value.id === id);
    const report = reports.get(id);
    return (
      <div key={id} className="session-picker-row" role="none">
        <MenuItem
          aria-current={id === selected ? "true" : undefined}
          onClick={(event) => {
            keyboardSelection.current = focusOnKeyboard && event.detail === 0;
            onSelect(id, keyboardSelection.current);
          }}
        >
          <SquareTerminal />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="max-w-60 truncate" title={name(id)}>
              {name(id)}
            </span>
            {report && <ReportSummary report={report} />}
          </span>
          {report && <ReportMark />}
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
    <Menu
      onOpenChange={(open) => {
        if (open) keyboardSelection.current = false;
      }}
      onOpenChangeComplete={(open) => {
        if (!open && keyboardSelection.current) onSelectionComplete();
      }}
    >
      <MenuTrigger
        render={
          variant === "label" ? (
            <Button variant="outline" aria-label={label} />
          ) : variant === "current" ? (
            <Button variant="ghost" className="min-w-0 max-w-[45%] shrink" aria-label={label} />
          ) : (
            <IconButton label={label} className="relative" />
          )
        }
      >
        <SquareTerminal />
        {elsewhere && variant === "icon" && (
          <span className="absolute top-1 right-1 flex">
            <ReportMark />
          </span>
        )}
        {variant === "label" && label}
        {variant === "current" && (
          <>
            <span className="truncate">
              {selected ? name(selected) : t(($) => $.common.terminal)}
            </span>
            {elsewhere && <ReportMark />}
            <ChevronDown />
          </>
        )}
      </MenuTrigger>
      <MenuContent finalFocus={() => !keyboardSelection.current}>
        {groups.map((group, index) => (
          <div
            key={group.id}
            role="group"
            aria-label={t(($) => $.terminal.group, { number: index + 1 })}
          >
            {onShowGroup && (
              <MenuPrimitive.CheckboxItem
                checked={!group.hidden}
                onCheckedChange={(shown) => onShowGroup(group.id, shown)}
                className="flex min-h-8 items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground outline-none data-highlighted:bg-muted"
              >
                <span className="size-4 shrink-0">
                  <MenuPrimitive.CheckboxItemIndicator>
                    <Check size={16} />
                  </MenuPrimitive.CheckboxItemIndicator>
                </span>
                {t(($) => $.terminal.showGroup, { number: index + 1 })}
              </MenuPrimitive.CheckboxItem>
            )}
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
