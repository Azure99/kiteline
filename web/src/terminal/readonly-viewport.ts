import type { Terminal } from "@xterm/xterm";

export function scrollTerminalLines(terminal: Terminal, lines: number) {
  const container = terminal.element!.parentElement!;
  if (
    !container.classList.contains("terminal-readonly") ||
    !scrollClippedScreen(terminal, 0, lines * terminal.dimensions!.css.cell.height)
  ) {
    terminal.scrollLines(lines);
  }
}

function scrollClippedScreen(terminal: Terminal, x: number, y: number) {
  const container = terminal.element!.parentElement!;
  const { viewportY, baseY } = terminal.buffer.active;
  const left = container.scrollLeft;
  container.scrollLeft += x;
  if (y > 0 && viewportY < baseY) return false;
  const top = container.scrollTop;
  container.scrollTop += y;
  return container.scrollTop !== top || (y === 0 && container.scrollLeft !== left);
}

// A finished screen keeps its original grid. Scroll the clipped rows locally,
// then use xterm's own viewport for older history, without resizing its buffer.
export function retainReadonlyViewport(terminal: Terminal) {
  const container = terminal.element!.parentElement!;
  const screen = terminal.screenElement!;
  container.classList.add("terminal-readonly");
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    const unit =
      event.deltaMode === 1
        ? terminal.dimensions!.css.cell.height
        : event.deltaMode === 2
          ? container.clientHeight
          : 1;
    if (!scrollClippedScreen(terminal, event.deltaX * unit, event.deltaY * unit)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const gesture = (event: Event) => {
    const change = event as Event & { translationX: number; translationY: number };
    if (!scrollClippedScreen(terminal, -change.translationX, -change.translationY)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  screen.addEventListener("wheel", wheel, { capture: true, passive: false });
  screen.addEventListener("-xterm-gesturechange", gesture, true);
  return () => {
    screen.removeEventListener("wheel", wheel, true);
    screen.removeEventListener("-xterm-gesturechange", gesture, true);
    container.classList.remove("terminal-readonly");
  };
}
