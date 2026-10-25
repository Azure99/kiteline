import { Bot, Code, Play, Rocket, Search, Sparkles, SquareTerminal, Wrench } from "lucide-react";
import type { ShortcutIcon as IconName } from "@kiteline/shared/protocol";

const icons = {
  terminal: SquareTerminal,
  sparkles: Sparkles,
  code: Code,
  bot: Bot,
  rocket: Rocket,
  wrench: Wrench,
  search: Search,
  play: Play,
};

export function ShortcutIcon({ icon = "terminal" }: { icon?: IconName }) {
  const Icon = icons[icon];
  return <Icon size={16} className="shrink-0" aria-hidden="true" />;
}
