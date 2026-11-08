import { useCallback, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, PenLine } from "lucide-react";
import { IconButton } from "../components/icon-button";
import type { Modifiers } from "./auxiliary-input";

interface ArrowPress {
  pointerId: number;
  button: HTMLButtonElement;
  x: number;
  y: number;
  timer?: number;
}

export function TerminalAuxKeys({
  hidden,
  available,
  active,
  mobile,
  modifiers,
  onKey,
  onToggleModifier,
  hasDraft,
  onCompose,
}: {
  hidden: boolean;
  available: boolean;
  active: boolean;
  mobile: boolean;
  modifiers: Modifiers;
  onKey(value: string, modifiers?: Modifiers): void;
  onToggleModifier(key: keyof Modifiers): void;
  hasDraft: boolean;
  onCompose(): void;
}) {
  const { t } = useTranslation();
  const enabled = active && available && mobile && !hidden;
  const press = useRef<ArrowPress>(undefined);
  const suppressedClicks = useRef(new Set<HTMLButtonElement>());
  const currentModifiers = useRef(modifiers);
  useLayoutEffect(() => {
    currentModifiers.current = modifiers;
  }, [modifiers]);
  const cancelPress = useCallback(() => {
    const current = press.current;
    if (!current) return;
    window.clearTimeout(current.timer);
    suppressedClicks.current.add(current.button);
    press.current = undefined;
  }, []);
  useLayoutEffect(() => {
    if (!enabled) cancelPress();
    return cancelPress;
  }, [enabled, onKey, cancelPress]);
  useLayoutEffect(() => {
    const visibilityChanged = () => {
      if (document.hidden) cancelPress();
    };
    window.addEventListener("blur", cancelPress);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.removeEventListener("blur", cancelPress);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [cancelPress]);
  function arrowHandlers(value: string) {
    return {
      onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
        const button = event.currentTarget;
        if (press.current) {
          cancelPress();
          suppressedClicks.current.add(button);
          return;
        }
        suppressedClicks.current.delete(button);
        if (!enabled || !event.isPrimary || event.button !== 0) {
          suppressedClicks.current.add(button);
          return;
        }
        const current: ArrowPress = {
          pointerId: event.pointerId,
          button,
          x: event.clientX,
          y: event.clientY,
        };
        press.current = current;
        button.setPointerCapture(event.pointerId);
        current.timer = window.setTimeout(() => {
          const chord = { ...currentModifiers.current };
          suppressedClicks.current.add(button);
          const repeat = () => {
            current.timer = window.setTimeout(repeat, 90);
            onKey(value, chord);
          };
          current.timer = window.setTimeout(repeat, 90);
          onKey(value);
        }, 450);
      },
      onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
        const current = press.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const rect = current.button.getBoundingClientRect();
        if (
          Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10 ||
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          cancelPress();
      },
      onPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
        if (press.current?.pointerId !== event.pointerId) return;
        window.clearTimeout(press.current.timer);
        press.current = undefined;
      },
      onPointerCancel(event: React.PointerEvent<HTMLButtonElement>) {
        if (press.current?.pointerId !== event.pointerId) return;
        cancelPress();
      },
      onLostPointerCapture(event: React.PointerEvent<HTMLButtonElement>) {
        if (press.current?.pointerId !== event.pointerId) return;
        cancelPress();
      },
      onClick(event: React.MouseEvent<HTMLButtonElement>) {
        // Chromium 97 touch clicks can have detail 0; keyboard clicks have no pointer type.
        const pointerClick =
          event.detail > 0 ||
          (event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType !== "");
        if (pointerClick && suppressedClicks.current.delete(event.currentTarget)) return;
        if (enabled) onKey(value);
      },
    };
  }
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
      <div className="terminal-aux-row">
        {upperKeys.map(({ value, label, icon: Glyph }) =>
          Glyph ? (
            <IconButton
              key={value}
              className="aux-key"
              label={label}
              disabled={!available}
              {...arrowHandlers(value)}
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
            className="aux-key"
            label={label}
            disabled={!available}
            {...arrowHandlers(value)}
          >
            <Glyph />
          </IconButton>
        ))}
        <IconButton
          className="aux-key relative"
          label={hasDraft ? t(($) => $.terminal.composeDraft) : t(($) => $.terminal.compose)}
          onClick={onCompose}
        >
          <PenLine />
          {hasDraft && (
            <span className="absolute top-1 right-[calc(50%-14px)] size-1.5 rounded-full bg-primary" />
          )}
        </IconButton>
      </div>
    </div>
  );
}
