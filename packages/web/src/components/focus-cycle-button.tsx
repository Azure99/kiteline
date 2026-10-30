import type { PointerEventHandler } from "react";
import { useTranslation } from "react-i18next";
import { Fullscreen, Minimize, Scan } from "lucide-react";
import { IconButton } from "./icon-button";

export function FocusCycleButton({
  active,
  fullscreen,
  enterFocusLabel,
  onClick,
  onPointerDown,
}: {
  active: boolean;
  fullscreen: boolean;
  enterFocusLabel: string;
  onClick(): void;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  let label = enterFocusLabel;
  let Glyph = Scan;
  if (fullscreen) {
    label = t(($) => $.terminal.exitFullscreen);
    Glyph = Minimize;
  } else if (active) {
    label = t(($) => $.terminal.enterFullscreen);
    Glyph = Fullscreen;
  }
  return (
    <IconButton label={label} aria-pressed={active} onClick={onClick} onPointerDown={onPointerDown}>
      <Glyph />
    </IconButton>
  );
}
