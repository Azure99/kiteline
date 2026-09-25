interface Disposable {
  dispose(): void;
}
interface BufferState {
  scrollTop: number;
  scrollBottom: number;
  ybase: number;
  savedY: number;
}
interface TerminalCore {
  _bufferService: {
    buffer: BufferState;
    buffers: { normal: BufferState };
    scroll(attr: unknown): void;
  };
  _inputHandler: {
    _parser: { currentState: number };
    _eraseAttrData(): unknown;
    markRangeDirty(start: number, end: number): void;
  };
  coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  mouseStateService: { activeEncoding: string; activeProtocol: string };
}
interface AdaptableTerminal {
  parser: {
    registerCsiHandler(
      id: { final: string },
      handler: (params: (number | number[])[]) => boolean,
    ): Disposable;
  };
  options: { disableStdin?: boolean };
}
function core(terminal: object) {
  return (terminal as { _core: TerminalCore })._core;
}

export function terminalOptions(historyLines: number) {
  return {
    allowProposedApi: true,
    scrollback: historyLines,
    vtExtensions: { win32InputMode: false, kittyKeyboard: false },
  };
}
// These private reads belong to the fixed xterm-c1 profile; upgrade both consumers together.
export function retainScrollUpHistory(terminal: AdaptableTerminal) {
  const internal = core(terminal);
  return terminal.parser.registerCsiHandler({ final: "S" }, (params) => {
    const buffer = internal._bufferService.buffer;
    if (buffer !== internal._bufferService.buffers.normal || buffer.scrollTop !== 0) return false;
    const count = typeof params[0] === "number" ? params[0] || 1 : 1;
    for (let index = 0; index < count; index++) {
      const before = buffer.ybase;
      internal._bufferService.scroll(internal._inputHandler._eraseAttrData());
      buffer.savedY += buffer.ybase - before;
    }
    internal._inputHandler.markRangeDirty(buffer.scrollTop, buffer.scrollBottom);
    return true;
  });
}
export function atGround(terminal: object) {
  return core(terminal)._inputHandler._parser.currentState === 0;
}
export function mouseEncodingVT(terminal: object) {
  const encoding = core(terminal).mouseStateService.activeEncoding;
  return encoding === "SGR" ? "\x1b[?1006h" : encoding === "SGR_PIXELS" ? "\x1b[?1016h" : "";
}
export function forwardUserInput(
  terminal: AdaptableTerminal,
  send: (data: string) => void,
): Disposable {
  const service = core(terminal).coreService;
  const original = service.triggerDataEvent;
  service.triggerDataEvent = function (data, wasUserInput) {
    if (wasUserInput === true && !terminal.options.disableStdin) send(data);
    original.call(this, data, wasUserInput);
  };
  return {
    dispose: () => {
      service.triggerDataEvent = original;
    },
  };
}
export function freezeMouse(terminal: object) {
  core(terminal).mouseStateService.activeProtocol = "NONE";
}
export function normalizePaste(text: string) {
  return text.replace(/\r?\n/g, "\r").replaceAll("\x1b", "\u241b");
}

export const touchHoldMs = 550;
export const touchSlopPx = 8;

// Fixed xterm beta inertia omits coordinates, and its TAP accepts small swipes.
export function adaptTouchGestures(
  screen: HTMLElement,
  selecting: () => boolean,
  onTap: () => void,
): Disposable {
  let last: { clientX: number; clientY: number } | undefined;
  let start: { x: number; y: number; time: number } | undefined;
  let tap = false;
  let blocked = false;
  const touch = (event: TouchEvent) => {
    const point = event.changedTouches[0];
    if (point) last = { clientX: point.clientX, clientY: point.clientY };
    if (event.type === "touchstart") {
      if (!selecting()) blocked = false;
      tap = false;
      start =
        event.touches.length === 1 && point
          ? { x: point.clientX, y: point.clientY, time: Date.now() }
          : undefined;
    } else {
      if (
        event.type === "touchcancel" ||
        (event.type === "touchmove" && event.touches.length !== 1) ||
        (start &&
          point &&
          Math.hypot(point.clientX - start.x, point.clientY - start.y) > touchSlopPx)
      )
        start = undefined;
      if (event.type === "touchend" || event.type === "touchcancel") {
        tap = !!start && event.touches.length === 0 && Date.now() - start.time < touchHoldMs;
        start = undefined;
      }
    }
  };
  const gesture = (raw: Event) => {
    const event = raw as Event & { clientX?: number; clientY?: number };
    if (selecting()) blocked = true;
    if (blocked) {
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (event.type === "-xterm-gesturechange") {
      start = undefined;
      tap = false;
      if (last) {
        event.clientX ??= last.clientX;
        event.clientY ??= last.clientY;
      }
    } else if (event.type === "-xterm-gesturetap") {
      if (tap) onTap();
      else {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }
    if (event.type === "-xterm-gesturetap") tap = false;
  };
  const touches = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
  const gestures = ["-xterm-gesturechange", "-xterm-gesturetap", "-xterm-gesturecontextmenu"];
  for (const name of touches)
    screen.addEventListener(name, touch, { capture: true, passive: true });
  for (const name of gestures) screen.addEventListener(name, gesture, true);
  return {
    dispose: () => {
      for (const name of touches) screen.removeEventListener(name, touch, true);
      for (const name of gestures) screen.removeEventListener(name, gesture, true);
    },
  };
}
