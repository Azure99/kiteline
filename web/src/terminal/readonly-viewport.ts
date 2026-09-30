import type { Terminal } from "@xterm/xterm";

export function scrollTerminalLines(terminal: Terminal, lines: number) {
  const container = terminal.element!.parentElement!;
  if (
    !(
      container.classList.contains("terminal-readonly") ||
      container.classList.contains("terminal-keyboard-clipped")
    ) ||
    !scrollClippedScreen(terminal, 0, lines * terminal.dimensions!.css.cell.height)
  ) {
    terminal.scrollLines(lines);
  }
}

export function scrollClippedScreen(terminal: Terminal, x: number, y: number) {
  const container = terminal.element!.parentElement!;
  const { viewportY, baseY } = terminal.buffer.active;
  const left = container.scrollLeft;
  container.scrollLeft += x;
  if (container.classList.contains("terminal-keyboard-clipped") && y < 0 && viewportY > 0)
    return false;
  if (y > 0 && viewportY < baseY) return false;
  const top = container.scrollTop;
  container.scrollTop += y;
  return container.scrollTop !== top || (y === 0 && container.scrollLeft !== left);
}

export function listenTerminalScroll(
  terminal: Terminal,
  scroll: (x: number, y: number) => boolean,
) {
  const container = terminal.element!.parentElement!;
  const screen = terminal.screenElement!;
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    const unit =
      event.deltaMode === 1
        ? terminal.dimensions!.css.cell.height
        : event.deltaMode === 2
          ? container.clientHeight
          : 1;
    if (!scroll(event.deltaX * unit, event.deltaY * unit)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const gesture = (event: Event) => {
    const change = event as Event & { translationX: number; translationY: number };
    if (!scroll(-change.translationX, -change.translationY)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  screen.addEventListener("wheel", wheel, { capture: true, passive: false });
  screen.addEventListener("-xterm-gesturechange", gesture, true);
  return () => {
    screen.removeEventListener("wheel", wheel, true);
    screen.removeEventListener("-xterm-gesturechange", gesture, true);
  };
}

// A finished screen keeps its original grid. Scroll the clipped rows locally,
// then use xterm's own viewport for older history, without resizing its buffer.
export function retainReadonlyViewport(terminal: Terminal) {
  const container = terminal.element!.parentElement!;
  container.classList.add("terminal-readonly");
  const stop = listenTerminalScroll(terminal, (x, y) => scrollClippedScreen(terminal, x, y));
  return () => {
    stop();
    container.classList.remove("terminal-readonly");
  };
}
