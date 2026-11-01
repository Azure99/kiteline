import type { PointerEventHandler } from "react";
import { useTranslation } from "react-i18next";
import { Fullscreen, Minimize, Scan } from "lucide-react";
import { IconButton } from "./icon-button";

export function FocusCycleButton({
  active,
  fullscreen,
  next,
  enterFocusLabel,
  onClick,
  onPointerDown,
}: {
  active: boolean;
  fullscreen: boolean;
  next: "enterFocus" | "enterFullscreen" | "exitFocus";
  enterFocusLabel: string;
  onClick(): void;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  let label = enterFocusLabel;
  let Glyph = Scan;
  if (next === "exitFocus") {
    label = t(($) => (fullscreen ? $.terminal.exitFullscreen : $.terminal.exitFocus));
    Glyph = Minimize;
  } else if (next === "enterFullscreen") {
    label = t(($) => $.terminal.enterFullscreen);
    Glyph = Fullscreen;
  }
  return (
    <IconButton label={label} aria-pressed={active} onClick={onClick} onPointerDown={onPointerDown}>
      <Glyph />
    </IconButton>
  );
}
