import type { IBufferCellPosition, Terminal } from "@xterm/xterm";
import { scrollTerminalLines } from "./clipped-screen";

type Cell = IBufferCellPosition;
type Point = { x: number; y: number };
export interface SelectionHandles {
  start?: Point;
  end?: Point;
  menu: Point;
}

export class TouchSelection {
  revision = 0;
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;
  private edge?: ReturnType<typeof setInterval>;
  private touch?: Point;
  private drag?: { anchor: Cell; point: Point; expected: [number, number] };
  private disposables: { dispose(): void }[];
  private screen: HTMLElement;
  private container: HTMLElement;
  private geometryFrame = 0;
  constructor(
    private terminal: Terminal,
    private changed: (handles?: SelectionHandles) => void,
    onTap: () => void,
  ) {
    this.screen = terminal.screenElement!;
    this.container = terminal.element!.parentElement!;
    this.disposables = [
      adaptTouchGestures(
        this.container,
        this.screen,
        () => this.active || terminal.hasSelection(),
        onTap,
      ),
      terminal.onSelectionChange(() => {
        this.revision++;
        this.refresh();
      }),
      terminal.onScroll(() => this.refresh()),
      terminal.onWriteParsed(() => {
        const range = terminal.getSelectionPosition();
        if (
          this.drag &&
          (!range ||
            this.index(range.start) !== this.drag.expected[0] ||
            this.index(range.end) !== this.drag.expected[1])
        )
          this.stopDrag();
        this.refresh();
      }),
      terminal.onResize(() => this.cancel()),
      terminal.onDimensionsChange(() => {
        this.stopDrag();
        this.refresh();
      }),
      terminal.buffer.onBufferChange(() => this.cancel()),
    ];
    this.screen.addEventListener("touchstart", this.start, { capture: true, passive: true });
    this.screen.addEventListener("touchmove", this.move, { capture: true, passive: true });
    this.screen.addEventListener("touchend", this.end, true);
    this.screen.addEventListener("touchcancel", this.end, true);
    this.screen.addEventListener("contextmenu", this.suppress, true);
    this.screen.addEventListener("click", this.suppress, true);
    this.container.addEventListener("scroll", this.scrolled);
    window.addEventListener("kiteline:viewport", this.geometry);
  }
  private geometry = () => {
    cancelAnimationFrame(this.geometryFrame);
    this.geometryFrame = requestAnimationFrame(() => this.refresh());
  };
  private start = (event: TouchEvent) => {
    this.end();
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    this.touch = { x: touch.clientX, y: touch.clientY };
    this.timer = setTimeout(() => {
      if (this.touch) this.selectWord(this.touch);
    }, touchHoldMs);
  };
  private move = (event: TouchEvent) => {
    const point = event.touches[0];
    if (
      !point ||
      event.touches.length !== 1 ||
      (this.touch &&
        Math.hypot(point.clientX - this.touch.x, point.clientY - this.touch.y) > touchSlopPx)
    )
      this.end();
  };
  private end = (event?: Event) => {
    clearTimeout(this.timer);
    this.touch = undefined;
    // The selection menu can appear under the finger before touchend.
    if (this.active && event?.cancelable) event.preventDefault();
  };
  private suppress = (event: Event) => {
    if (this.active) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  private scrolled = () => this.refresh();
  private cell(point: Point, boundary = false): Cell | undefined {
    const size = this.terminal.dimensions?.css.cell;
    const rect = this.screen.getBoundingClientRect();
    if (!size?.width || !size.height || !rect.width || !rect.height) return;
    const round = boundary ? Math.round : Math.floor;
    const buffer = this.terminal.buffer.active;
    const visible = this.bounds();
    if (visible.right <= visible.left || visible.bottom <= visible.top) return;
    const x = Math.max(visible.left, Math.min(point.x, visible.right - 1));
    const y = Math.max(visible.top, Math.min(point.y, visible.bottom - 1));
    return {
      x: Math.max(
        0,
        Math.min(this.terminal.cols - (boundary ? 0 : 1), round((x - rect.left) / size.width)),
      ),
      y: Math.max(
        buffer.viewportY,
        Math.min(
          buffer.length - 1,
          buffer.viewportY + this.terminal.rows - 1,
          buffer.viewportY + Math.floor((y - rect.top) / size.height),
        ),
      ),
    };
  }
  private bounds() {
    const screen = this.screen.getBoundingClientRect();
    const container = this.container.getBoundingClientRect();
    return {
      top: Math.max(screen.top, container.top),
      bottom: Math.min(screen.bottom, container.bottom),
      left: Math.max(screen.left, container.left),
      right: Math.min(screen.right, container.right),
    };
  }
  private index(cell: Cell) {
    return cell.y * this.terminal.cols + cell.x;
  }
  private fromIndex(index: number): Cell {
    return { x: index % this.terminal.cols, y: Math.floor(index / this.terminal.cols) };
  }
  private normalize(cell: Cell, end: boolean): Cell {
    const value = this.terminal.buffer.active.getLine(cell.y)?.getCell(cell.x);
    return value?.getWidth() === 0 ? { ...cell, x: cell.x + (end ? 1 : -1) } : cell;
  }
  private selectWord(point: Point) {
    const hit = this.cell(point);
    if (!hit) return;
    const start = this.normalize(hit, false);
    const buffer = this.terminal.buffer.active;
    const line = buffer.getLine(start.y);
    const value = line?.getCell(start.x);
    if (!value) return;
    const separators = this.terminal.options.wordSeparator ?? " ()[]{}'\"";
    const isWord = (text: string) =>
      text.length > 0 && text.trim() !== "" && !separators.includes(text);
    let first = this.index(start);
    let end = first + Math.max(1, value.getWidth());
    if (isWord(value.getChars())) {
      while (first > 0) {
        const at = this.fromIndex(first);
        if (at.x === 0 && !buffer.getLine(at.y)?.isWrapped) break;
        const previous = this.normalize(this.fromIndex(first - 1), false);
        const text = buffer.getLine(previous.y)?.getCell(previous.x)?.getChars() ?? "";
        if (!isWord(text)) break;
        first = this.index(previous);
      }
      while (end < buffer.length * this.terminal.cols) {
        const next = this.fromIndex(end);
        if (next.x === 0 && !buffer.getLine(next.y)?.isWrapped) break;
        const value = buffer.getLine(next.y)?.getCell(next.x);
        if (!value || !isWord(value.getChars())) break;
        end += Math.max(1, value.getWidth());
      }
    }
    this.active = true;
    this.revision++;
    const a = this.fromIndex(first);
    this.terminal.select(a.x, a.y, end - first);
    this.refresh();
  }
  startDrag(side: "start" | "end", point: Point) {
    this.stopDrag();
    const selected = this.terminal.getSelectionPosition();
    if (!selected) return;
    this.revision++;
    this.drag = {
      anchor: { ...selected[side === "start" ? "end" : "start"] },
      point,
      expected: [this.index(selected.start), this.index(selected.end)],
    };
    this.edge = setInterval(() => {
      if (!this.drag) return;
      const rect = this.bounds();
      const direction =
        this.drag.point.y < rect.top + 20 ? -1 : this.drag.point.y > rect.bottom - 20 ? 1 : 0;
      if (direction) {
        const drag = this.drag;
        scrollTerminalLines(this.terminal, direction * 2);
        if (this.drag === drag) this.moveDrag(drag.point);
      }
    }, 60);
  }
  moveDrag(point: Point) {
    const moving = this.cell(point, true);
    if (!this.drag || !moving) return;
    this.drag.point = point;
    const anchor = this.drag.anchor;
    const reverse = this.index(moving) > this.index(anchor);
    const start = this.normalize(reverse ? anchor : moving, false);
    const end = this.normalize(reverse ? moving : anchor, true);
    this.drag.expected = [this.index(start), this.index(end)];
    this.terminal.select(start.x, start.y, Math.max(0, this.index(end) - this.index(start)));
    this.refresh();
  }
  stopDrag(refresh = false) {
    clearInterval(this.edge);
    this.edge = undefined;
    this.drag = undefined;
    if (refresh) this.refresh();
  }
  private point(cell: Cell): Point | undefined {
    const { viewportY } = this.terminal.buffer.active;
    if (cell.y < viewportY || cell.y >= viewportY + this.terminal.rows) return;
    const size = this.terminal.dimensions?.css.cell;
    if (!size) return;
    const rect = this.screen.getBoundingClientRect();
    const point = {
      x: rect.left + cell.x * size.width,
      y: rect.top + (cell.y - viewportY + 1) * size.height,
    };
    const visible = this.bounds();
    return point.x < visible.left ||
      point.x > visible.right ||
      point.y <= visible.top ||
      point.y > visible.bottom
      ? undefined
      : point;
  }
  private refresh() {
    if (!this.active) return;
    const range = this.terminal.getSelectionPosition();
    const buffer = this.terminal.buffer.active;
    if (
      !range ||
      range.start.y < 0 ||
      range.end.y >= buffer.length ||
      this.index(range.end) <= this.index(range.start)
    ) {
      if (!this.drag || this.drag.expected[0] !== this.drag.expected[1]) this.cancel();
      else this.changed(undefined);
      return;
    }
    const start = this.point(range.start);
    const end = this.point(range.end);
    const rect = this.bounds();
    this.changed({
      start,
      end,
      menu: {
        x: Math.min(rect.right - 50, Math.max(rect.left + 50, (start ?? end)?.x ?? rect.left + 50)),
        y: Math.max(64, (start ?? end)?.y ?? rect.top),
      },
    });
  }
  cancel() {
    this.revision++;
    this.end();
    this.stopDrag();
    const active = this.active;
    this.active = false;
    if (active) this.terminal.clearSelection();
    this.changed(undefined);
  }
  dispose() {
    this.end();
    this.stopDrag();
    for (const item of this.disposables) item.dispose();
    this.screen.removeEventListener("touchstart", this.start, true);
    this.screen.removeEventListener("touchmove", this.move, true);
    this.screen.removeEventListener("touchend", this.end, true);
    this.screen.removeEventListener("touchcancel", this.end, true);
    this.screen.removeEventListener("contextmenu", this.suppress, true);
    this.screen.removeEventListener("click", this.suppress, true);
    this.container.removeEventListener("scroll", this.scrolled);
    window.removeEventListener("kiteline:viewport", this.geometry);
    cancelAnimationFrame(this.geometryFrame);
  }
}

const touchHoldMs = 550;
const touchSlopPx = 8;

// The pinned xterm beta inertia omits coordinates; only an explicit tap requests focus.
export function adaptTouchGestures(
  container: HTMLElement,
  screen: HTMLElement,
  selecting: () => boolean,
  onTap: () => void,
) {
  let last: { clientX: number; clientY: number } | undefined;
  let blocked = false;
  let contact:
    | { identifier: number; x: number; y: number; started: number; eligible: boolean }
    | undefined;
  const document = container.ownerDocument;
  const touch = (event: TouchEvent) => {
    const inBody = screen.contains(event.target as Node);
    if (!contact && !inBody) return;
    const point = event.changedTouches[0];
    if (point) last = { clientX: point.clientX, clientY: point.clientY };
    if (event.type === "touchstart") {
      if (contact) contact.eligible = false;
      else if (point && inBody && event.touches.length === 1) {
        blocked = selecting();
        contact = {
          identifier: point.identifier,
          x: point.clientX,
          y: point.clientY,
          started: event.timeStamp,
          eligible: !blocked,
        };
      }
      return;
    }
    if (!contact) return;
    if (event.type === "touchmove" || event.type === "touchcancel" || selecting())
      contact.eligible = false;
    if (event.type !== "touchend" && event.type !== "touchcancel") return;
    const tap =
      contact.eligible &&
      event.type === "touchend" &&
      event.touches.length === 0 &&
      point?.identifier === contact.identifier &&
      event.timeStamp - contact.started < touchHoldMs &&
      Math.hypot(point.clientX - contact.x, point.clientY - contact.y) <= touchSlopPx;
    if (event.touches.length === 0) contact = undefined;
    else contact.eligible = false;
    if (tap) onTap();
  };
  const gesture = (raw: Event) => {
    const event = raw as Event & { clientX?: number; clientY?: number };
    if (contact && event.type === "-xterm-gesturechange") contact.eligible = false;
    if (selecting()) blocked = true;
    if (blocked || event.type === "-xterm-gesturetap") {
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (event.type === "-xterm-gesturechange") {
      if (last) {
        event.clientX ??= last.clientX;
        event.clientY ??= last.clientY;
      }
    }
  };
  const mouse = (event: MouseEvent) => {
    if (
      (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } })
        .sourceCapabilities?.firesTouchEvents
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const touches = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
  const gestures = ["-xterm-gesturechange", "-xterm-gesturetap", "-xterm-gesturecontextmenu"];
  for (const name of touches)
    document.addEventListener(name, touch, { capture: true, passive: true });
  for (const name of gestures) container.addEventListener(name, gesture, true);
  container.addEventListener("mousedown", mouse, true);
  return {
    dispose: () => {
      for (const name of touches) document.removeEventListener(name, touch, { capture: true });
      for (const name of gestures) container.removeEventListener(name, gesture, true);
      container.removeEventListener("mousedown", mouse, true);
    },
  };
}
