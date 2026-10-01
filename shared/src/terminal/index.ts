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
