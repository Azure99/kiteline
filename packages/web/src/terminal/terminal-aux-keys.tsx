import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Terminal } from "@xterm/xterm";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp } from "lucide-react";
import { IconButton } from "../components/icon-button";
import type { Modifiers } from "./auxiliary-input";

const initialRepeatDelayMs = 400;
const repeatIntervalMs = 80;

export function TerminalAuxKeys({
  terminal,
  paneActive,
  hidden,
  available,
  mobile,
  modifiers,
  onKey,
  onToggleModifier,
}: {
  terminal?: Terminal;
  paneActive: boolean;
  hidden: boolean;
  available: boolean;
  mobile: boolean;
  modifiers: Modifiers;
  onKey(value: string): void;
  onToggleModifier(key: keyof Modifiers): void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current!;
    let timer = 0;
    let held: { id: number; button: HTMLElement; key: string } | undefined;
    const stop = () => {
      clearTimeout(timer);
      held = undefined;
    };
    const repeat = () => {
      if (!held) return;
      onKey(held.key);
      timer = window.setTimeout(repeat, repeatIntervalMs);
    };
    const down = (event: PointerEvent) => {
      const button = (event.target as Element).closest<HTMLElement>("[data-repeat-arrow]");
      if (
        !button ||
        event.pointerType !== "touch" ||
        !event.isPrimary ||
        held ||
        !paneActive ||
        !available
      )
        return;
      event.preventDefault();
      held = { id: event.pointerId, button, key: button.dataset.repeatArrow! };
      onKey(held.key);
      if (mobile) navigator.vibrate?.(10);
      timer = window.setTimeout(repeat, initialRepeatDelayMs);
    };
    const move = (event: PointerEvent) => {
      if (!held || held.id !== event.pointerId) return;
      const box = held.button.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX >= box.right ||
        event.clientY < box.top ||
        event.clientY >= box.bottom
      )
        stop();
    };
    const end = (event: PointerEvent) => {
      if (held?.id === event.pointerId) stop();
    };
    // Cancel the gesture's click even if its terminal is replaced before release.
    const preventArrowDefault = (event: Event) => {
      if ((event.target as Element).closest("[data-repeat-arrow]")) event.preventDefault();
    };
    const visibility = () => {
      if (document.hidden) stop();
    };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
    element.addEventListener("lostpointercapture", end);
    element.addEventListener("touchstart", preventArrowDefault, { passive: false });
    element.addEventListener("contextmenu", preventArrowDefault);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop();
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      element.removeEventListener("lostpointercapture", end);
      element.removeEventListener("touchstart", preventArrowDefault);
      element.removeEventListener("contextmenu", preventArrowDefault);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", visibility);
    };
    // Replacing the display or removing an expanded row also ends its held gesture.
  }, [onKey, mobile, paneActive, available, terminal, expanded]);
  const upperKeys = [
    { value: "Tab", label: "TAB" },
    { value: "/", label: "/" },
    { value: "@", label: "@" },
    { value: "PageUp", label: "PGUP" },
    { value: "ArrowUp", label: t(($) => $.terminal.up), icon: ArrowUp },
    { value: "PageDown", label: "PGDN" },
    { value: "Escape", label: "ESC" },
  ];
  const arrows = [
    { value: "ArrowLeft", label: t(($) => $.terminal.left), icon: ArrowLeft },
    { value: "ArrowDown", label: t(($) => $.terminal.down), icon: ArrowDown },
    { value: "ArrowRight", label: t(($) => $.terminal.right), icon: ArrowRight },
  ];
  const modifierKeys = [
    { value: "shiftKey", label: "SHIFT" },
    { value: "ctrlKey", label: "CTRL" },
    { value: "altKey", label: "ALT" },
  ] as const;
  return (
    <div
      ref={root}
      hidden={hidden}
      className="terminal-aux shrink-0 border-t"
      onPointerDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (
          mobile &&
          event.target instanceof Element &&
          event.target.closest("button:not(:disabled)")
        )
          navigator.vibrate?.(10);
      }}
    >
      {expanded && (
        <div className="terminal-aux-row">
          {upperKeys.map(({ value, label, icon: Glyph }) =>
            Glyph ? (
              <IconButton
                key={value}
                className="aux-key touch-none"
                data-repeat-arrow={value}
                label={label}
                disabled={!available}
                onClick={() => onKey(value)}
              >
                <Glyph />
              </IconButton>
            ) : (
              <button
                key={value}
                className="aux-key"
                disabled={!available}
                onClick={() => onKey(value)}
              >
                {label}
              </button>
            ),
          )}
        </div>
      )}
      <div className="terminal-aux-row">
        {modifierKeys.map(({ value, label }) => (
          <button
            key={value}
            className="aux-key"
            aria-pressed={modifiers[value]}
            disabled={!available}
            onClick={() => onToggleModifier(value)}
          >
            {label}
          </button>
        ))}
        {arrows.map(({ icon: Glyph, value, label }) => (
          <IconButton
            key={value}
            className="aux-key touch-none"
            data-repeat-arrow={value}
            label={label}
            disabled={!available}
            onClick={() => onKey(value)}
          >
            <Glyph />
          </IconButton>
        ))}
        <IconButton
          className="aux-key"
          label={expanded ? t(($) => $.terminal.collapseKeys) : t(($) => $.terminal.expandKeys)}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown /> : <ChevronUp />}
        </IconButton>
      </div>
    </div>
  );
}
