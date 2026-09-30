import type { Terminal } from "@xterm/xterm";
import { evaluateKeyboardEvent } from "@xterm/xterm/src/common/input/Keyboard";
import { KeyboardResultType, type IKeyboardEvent } from "@xterm/xterm/src/common/Types";

export type Modifiers = { shiftKey: boolean; ctrlKey: boolean; altKey: boolean };
export const releasedModifiers: Modifiers = { shiftKey: false, ctrlKey: false, altKey: false };

const namedKeys: Record<string, [number, string]> = {
  Tab: [9, "Tab"],
  Escape: [27, "Escape"],
  PageUp: [33, "PageUp"],
  PageDown: [34, "PageDown"],
  ArrowLeft: [37, "ArrowLeft"],
  ArrowUp: [38, "ArrowUp"],
  ArrowRight: [39, "ArrowRight"],
  ArrowDown: [40, "ArrowDown"],
  " ": [32, "Space"],
};
const punctuation: [string, number, string][] = [
  [";:", 186, "Semicolon"],
  ["=+", 187, "Equal"],
  [",<", 188, "Comma"],
  ["-_", 189, "Minus"],
  [".>", 190, "Period"],
  ["/?", 191, "Slash"],
  ["`~", 192, "Backquote"],
  ["[{", 219, "BracketLeft"],
  ["\\|", 220, "Backslash"],
  ["]}", 221, "BracketRight"],
  ["'\"", 222, "Quote"],
];

function describe(key: string): IKeyboardEvent {
  let [keyCode, code] = namedKeys[key] ?? [0, ""];
  let shiftKey = false;
  if (/^[a-z]$/i.test(key)) {
    keyCode = key.toUpperCase().charCodeAt(0);
    code = `Key${key.toUpperCase()}`;
  } else {
    const digit = "0123456789".indexOf(key);
    const shiftedDigit = ")!@#$%^&*(".indexOf(key);
    if (key.length === 1 && (digit >= 0 || shiftedDigit >= 0)) {
      keyCode = 48 + Math.max(digit, shiftedDigit);
      code = `Digit${keyCode - 48}`;
      shiftKey = shiftedDigit >= 0;
    } else {
      const entry = punctuation.find(([pair]) => key.length === 1 && pair.includes(key));
      if (entry) {
        [, keyCode, code] = entry;
        shiftKey = entry[0][1] === key;
      }
    }
  }
  return {
    key,
    keyCode,
    code,
    type: "keydown",
    shiftKey,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  };
}

export class AuxiliaryInput {
  private modifiers = releasedModifiers;
  private composing = false;
  private handled = false;
  private textInput?: InputEvent;
  private inputTimer = 0;

  constructor(
    private terminal: Terminal,
    private changed: (value: Modifiers) => void,
  ) {
    terminal.attachCustomKeyEventHandler(this.keyEvent);
    // Capture before xterm; a 229 key may forward the same text on its queued IME callback.
    terminal.element!.addEventListener("input", this.inputEvent, true);
    terminal.textarea!.addEventListener("compositionstart", this.compositionStart);
    terminal.textarea!.addEventListener("compositionend", this.compositionEnd);
  }
  toggle(key: keyof Modifiers) {
    if (this.terminal.options.disableStdin) return;
    this.modifiers = { ...this.modifiers, [key]: !this.modifiers[key] };
    if (!Object.values(this.modifiers).some(Boolean)) this.modifiers = releasedModifiers;
    this.changed(this.modifiers);
  }
  release() {
    if (this.modifiers === releasedModifiers) return;
    this.modifiers = releasedModifiers;
    this.changed(this.modifiers);
  }
  key(key: string) {
    if (this.terminal.options.disableStdin) return;
    this.dispatch(describe(key));
  }
  private encode(event: IKeyboardEvent) {
    const merged = {
      ...event,
      shiftKey: event.shiftKey || this.modifiers.shiftKey,
      ctrlKey: event.ctrlKey || this.modifiers.ctrlKey,
      altKey: event.altKey || this.modifiers.altKey,
    };
    if (this.modifiers.shiftKey && !event.shiftKey) {
      const pair = punctuation.find((entry) => entry[1] === event.keyCode)?.[0];
      merged.key =
        pair?.[1] ??
        (event.keyCode >= 48 && event.keyCode <= 57
          ? ")!@#$%^&*("[event.keyCode - 48]!
          : event.key.length === 1
            ? event.key.toUpperCase()
            : event.key);
    }
    const result = evaluateKeyboardEvent(
      merged,
      this.terminal.modes.applicationCursorKeysMode,
      false,
      true,
    );
    // xterm's keypress path supplies characters such as plain Space after keydown.
    if (
      result.key === undefined &&
      merged.key.length === 1 &&
      !merged.ctrlKey &&
      !merged.altKey &&
      !merged.metaKey
    )
      result.key = merged.key;
    return result;
  }
  private dispatch(event: IKeyboardEvent) {
    const result = this.encode(event);
    this.release();
    if (result.type === KeyboardResultType.PAGE_UP || result.type === KeyboardResultType.PAGE_DOWN)
      this.terminal.scrollLines(
        (this.terminal.rows - 1) * (result.type === KeyboardResultType.PAGE_UP ? -1 : 1),
      );
    else if (result.key !== undefined) this.terminal.input(result.key, true);
  }
  private keyEvent = (event: KeyboardEvent) => {
    if (event.type === "keyup") {
      this.handled = false;
      return true;
    }
    if (event.type === "keypress" && this.handled) return false;
    if (event.type !== "keydown") return true;
    this.handled = false;
    if (
      this.terminal.options.disableStdin ||
      this.composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      ["Dead", "AltGraph", "Shift", "Control", "Alt", "Meta"].includes(event.key) ||
      event.getModifierState("AltGraph") ||
      (event.key.length === 1 && event.key.charCodeAt(0) > 127) ||
      this.modifiers === releasedModifiers
    )
      return true;
    this.handled = true;
    event.preventDefault();
    this.dispatch({
      key: event.key,
      keyCode: event.keyCode,
      code: event.code,
      type: event.type,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    });
    return false;
  };
  private inputEvent = (event: Event) => {
    if (this.handled) {
      event.stopImmediatePropagation();
      return;
    }
    this.textInput = event as InputEvent;
    clearTimeout(this.inputTimer);
    this.inputTimer = window.setTimeout(() => {
      this.textInput = undefined;
    }, 0);
  };
  forward(text: string) {
    const input = this.textInput;
    if (!input || input.data !== text || input.isComposing || this.composing) return text;
    this.textInput = undefined;
    const result = /^[\x20-\x7e]$/.test(text) ? this.encode(describe(text)).key : text;
    this.release();
    return result;
  }
  private compositionStart = () => {
    this.composing = true;
  };
  private compositionEnd = () => {
    this.composing = false;
    this.release();
  };
  dispose() {
    clearTimeout(this.inputTimer);
    this.terminal.element?.removeEventListener("input", this.inputEvent, true);
    this.terminal.textarea?.removeEventListener("compositionstart", this.compositionStart);
    this.terminal.textarea?.removeEventListener("compositionend", this.compositionEnd);
    this.terminal.attachCustomKeyEventHandler(() => true);
    this.release();
  }
}
