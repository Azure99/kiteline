import { Unicode11Addon } from "@xterm/addon-unicode11";

interface Disposable {
  dispose(): void;
}
interface BufferState {
  x: number;
  scrollTop: number;
  scrollBottom: number;
  ybase: number;
  savedY: number;
}
interface CsiParameters {
  params: Int32Array;
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
    scrollUp(params: CsiParameters): boolean;
    scrollDown(params: CsiParameters): boolean;
    insertLines(params: CsiParameters): boolean;
    deleteLines(params: CsiParameters): boolean;
    repeatPrecedingCharacter(params: CsiParameters): boolean;
  };
  coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  mouseStateService: { activeEncoding: string; activeProtocol: string };
}
interface AdaptableTerminal {
  cols: number;
  rows: number;
  parser: {
    registerCsiHandler(
      id: { final: string },
      handler: (params: (number | number[])[]) => boolean,
    ): Disposable;
  };
  options: { disableStdin?: boolean; scrollback?: number };
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
export function initializeTerminalUnicode(terminal: {
  loadAddon(addon: Unicode11Addon): void;
  unicode: { activeVersion: string };
}) {
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
}
// These private reads belong to the fixed terminal profile; upgrade both consumers together.
export function adaptTerminalScrolling(terminal: AdaptableTerminal) {
  const internal = core(terminal);
  const input = internal._inputHandler;
  for (const name of [
    "scrollUp",
    "scrollDown",
    "insertLines",
    "deleteLines",
    "repeatPrecedingCharacter",
  ] as const) {
    const original = input[name];
    input[name] = function (params) {
      const buffer = internal._bufferService.buffer;
      const maximum =
        name === "repeatPrecedingCharacter"
          ? terminal.cols - buffer.x
          : buffer.scrollBottom - buffer.scrollTop + 1;
      // tmux 3.4 bounds counts by the remaining columns or scroll region height.
      if (maximum <= 0) return true;
      const count = params.params[0]!;
      params.params[0] = Math.min(count || 1, maximum);
      try {
        return original.call(this, params);
      } finally {
        params.params[0] = count;
      }
    };
  }
  terminal.parser.registerCsiHandler({ final: "S" }, (params) => {
    const buffer = internal._bufferService.buffer;
    if (buffer !== internal._bufferService.buffers.normal || buffer.scrollTop !== 0) return false;
    const count = Math.min(
      typeof params[0] === "number" ? params[0] || 1 : 1,
      buffer.scrollBottom - buffer.scrollTop + 1,
    );
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
export function forwardUserInput(terminal: AdaptableTerminal, send: (data: string) => void) {
  const service = core(terminal).coreService;
  const original = service.triggerDataEvent;
  service.triggerDataEvent = function (data, wasUserInput) {
    if (wasUserInput === true && !terminal.options.disableStdin) send(data);
    original.call(this, data, wasUserInput);
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

// Fixed xterm beta inertia omits coordinates; only an explicit tap requests focus.
export function adaptTouchGestures(
  container: HTMLElement,
  screen: HTMLElement,
  selecting: () => boolean,
  onTap: () => void,
): Disposable {
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
