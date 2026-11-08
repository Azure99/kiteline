import type { Terminal } from "@xterm/xterm";
import { afterEach, expect, test, vi } from "vitest";
import { KeyboardViewport } from "../src/terminal/keyboard-viewport";

afterEach(() => vi.unstubAllGlobals());

function createViewport(showCursor: boolean, reading: boolean) {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = undefined;
  });
  const container = Object.assign(new EventTarget(), {
    scrollTop: 20,
    classList: { toggle() {}, remove() {} },
    getBoundingClientRect: () => ({ top: 0, bottom: 50, width: 100, height: 50 }),
  });
  const screen = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ top: -container.scrollTop }),
  });
  const subscribe = () => ({ dispose() {} });
  let selected = reading;
  const terminal = {
    element: { parentElement: container },
    screenElement: screen,
    modes: { showCursor },
    dimensions: { css: { cell: { height: 10 } } },
    hasSelection: () => selected,
    onWriteParsed: subscribe,
    onScroll: subscribe,
    onResize: subscribe,
    onSelectionChange: subscribe,
    buffer: {
      active: { type: "normal", baseY: 0, viewportY: 0, cursorY: 8 },
      onBufferChange: subscribe,
    },
  };
  const viewport = new KeyboardViewport(terminal as unknown as Terminal, () => {});
  viewport.update(true);
  selected = false;
  return { viewport, container, render: () => frame?.(0) };
}

test.each([
  { showCursor: false, reading: true, force: false, top: 20, keepsReading: true },
  { showCursor: true, reading: true, force: false, top: 40, keepsReading: false },
  { showCursor: false, reading: true, force: true, top: 40, keepsReading: false },
  { showCursor: false, reading: false, force: false, top: 40, keepsReading: false },
])(
  "input preserves manual reading only for a hidden cursor (cursor=$showCursor, reading=$reading, force=$force)",
  ({ showCursor, reading, force, top, keepsReading }) => {
    const { viewport, container, render } = createViewport(showCursor, reading);

    viewport.followInput(force);
    render();

    expect(viewport.isReading()).toBe(keepsReading);
    expect(container.scrollTop).toBe(top);
    viewport.dispose();
  },
);
