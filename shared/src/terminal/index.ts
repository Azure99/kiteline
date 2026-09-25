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

// Fixed xterm beta inertia omits coordinates; touch never requests input focus.
export function adaptTouchGestures(screen: HTMLElement, selecting: () => boolean): Disposable {
  let last: { clientX: number; clientY: number } | undefined;
  let blocked = false;
  const touch = (event: TouchEvent) => {
    const point = event.changedTouches[0];
    if (point) last = { clientX: point.clientX, clientY: point.clientY };
    if (event.type === "touchstart" && !selecting()) blocked = false;
  };
  const gesture = (raw: Event) => {
    const event = raw as Event & { clientX?: number; clientY?: number };
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
    screen.addEventListener(name, touch, { capture: true, passive: true });
  for (const name of gestures) screen.addEventListener(name, gesture, true);
  screen.addEventListener("mousedown", mouse, true);
  return {
    dispose: () => {
      for (const name of touches) screen.removeEventListener(name, touch, true);
      for (const name of gestures) screen.removeEventListener(name, gesture, true);
      screen.removeEventListener("mousedown", mouse, true);
    },
  };
}
