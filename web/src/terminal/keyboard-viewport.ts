import type { Terminal } from "@xterm/xterm";
import { scrollClippedScreen } from "./readonly-viewport";

// The xterm grid stays intact; only the visible slice moves while the keyboard is open.
export class KeyboardViewport {
  private container: HTMLElement;
  private frame = 0;
  private active = false;
  private reading = false;
  private shortHistory?: number;
  private subscriptions: { dispose(): void }[];
  constructor(
    private terminal: Terminal,
    private onReading: () => void,
  ) {
    this.container = terminal.element!.parentElement!;
    this.subscriptions = [
      terminal.onWriteParsed(() => {
        if (this.shortHistory !== undefined && terminal.buffer.active.baseY > 0) {
          terminal.scrollToLine(this.shortHistory);
          this.shortHistory = undefined;
        }
        this.schedule();
      }),
      terminal.onScroll(this.schedule),
      terminal.onResize(this.schedule),
      terminal.onSelectionChange(() => {
        if (this.active && terminal.hasSelection()) this.startReading();
      }),
      terminal.buffer.onBufferChange(() => {
        this.reading = false;
        this.shortHistory = undefined;
        this.schedule();
      }),
    ];
    terminal.screenElement!.addEventListener("wheel", this.wheel, {
      capture: true,
      passive: false,
    });
    terminal.screenElement!.addEventListener("-xterm-gesturechange", this.gesture, true);
  }
  update(active: boolean) {
    if (active !== this.active) {
      this.active = active;
      this.container.classList.toggle("terminal-keyboard-clipped", active);
      this.reading = false;
      this.shortHistory = undefined;
      if (!active) this.container.scrollTop = 0;
      else if (this.terminal.hasSelection()) this.startReading();
    }
    this.schedule();
  }
  isReading() {
    return this.active && this.reading;
  }
  followInput() {
    this.reading = false;
    this.shortHistory = undefined;
    this.schedule();
  }
  private startReading() {
    this.reading = true;
    const buffer = this.terminal.buffer.active;
    if (buffer.type === "normal" && buffer.baseY === 0) this.shortHistory = buffer.viewportY;
    this.onReading();
  }
  private scroll(x: number, y: number) {
    if (
      !this.active ||
      this.terminal.buffer.active.type !== "normal" ||
      this.terminal.modes.mouseTrackingMode !== "none"
    )
      return false;
    const moved = scrollClippedScreen(this.terminal, x, y);
    if (moved) this.startReading();
    return moved;
  }
  private wheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    const unit =
      event.deltaMode === 1
        ? this.terminal.dimensions!.css.cell.height
        : event.deltaMode === 2
          ? this.container.clientHeight
          : 1;
    if (!this.scroll(event.deltaX * unit, event.deltaY * unit)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  private gesture = (event: Event) => {
    const change = event as Event & { translationX: number; translationY: number };
    if (!this.scroll(-change.translationX, -change.translationY)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  private schedule = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (!this.active || this.reading || this.terminal.hasSelection()) return;
      const buffer = this.terminal.buffer.active;
      if (buffer.viewportY !== buffer.baseY) return;
      const clip = this.container.getBoundingClientRect();
      if (!clip.width || !clip.height) return;
      const screen = this.terminal.screenElement!.getBoundingClientRect();
      const cell = this.terminal.dimensions!.css.cell.height;
      const top = screen.top + buffer.cursorY * cell;
      if (top + cell > clip.bottom) this.container.scrollTop += top + cell - clip.bottom;
      else if (top < clip.top) this.container.scrollTop -= clip.top - top;
    });
  };
  dispose() {
    cancelAnimationFrame(this.frame);
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.terminal.screenElement!.removeEventListener("wheel", this.wheel, true);
    this.terminal.screenElement!.removeEventListener("-xterm-gesturechange", this.gesture, true);
    this.container.classList.remove("terminal-keyboard-clipped");
  }
}
