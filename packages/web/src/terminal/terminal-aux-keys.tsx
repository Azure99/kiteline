import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, PenLine } from "lucide-react";
import { IconButton } from "../components/icon-button";
import type { Modifiers } from "./auxiliary-input";

export function TerminalAuxKeys({
  hidden,
  available,
  mobile,
  modifiers,
  onKey,
  onToggleModifier,
  hasDraft,
  onCompose,
}: {
  hidden: boolean;
  available: boolean;
  mobile: boolean;
  modifiers: Modifiers;
  onKey(value: string): void;
  onToggleModifier(key: keyof Modifiers): void;
  hasDraft: boolean;
  onCompose(): void;
}) {
  const { t } = useTranslation();
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
            onClick={() => onKey(value)}
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
