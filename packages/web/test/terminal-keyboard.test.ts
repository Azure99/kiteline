import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { virtualKeyboard } = vi.hoisted(() => {
  const virtualKeyboard = { show: vi.fn() };
  vi.stubGlobal("matchMedia", () => ({ matches: true }) as MediaQueryList);
  vi.stubGlobal("navigator", { virtualKeyboard });
  return { virtualKeyboard };
});
import { terminalKeyboard } from "../src/terminal/keyboard-input";

beforeEach(() => {
  virtualKeyboard.show.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createKeyboard(mobile = true) {
  const document = { activeElement: null as EventTarget | null };
  vi.stubGlobal("document", document);
  const textarea = Object.assign(new EventTarget(), {
    virtualKeyboardPolicy: "",
    setAttribute(_name: string, value: string) {
      this.virtualKeyboardPolicy = value;
    },
    blur() {
      document.activeElement = null;
      textarea.dispatchEvent(new Event("blur"));
    },
  });
  const focusPolicies: string[] = [];
  let selected = false;
  let onSelectionChange: (() => void) | undefined;
  const terminal = {
    textarea,
    options: { disableStdin: false },
    focus() {
      focusPolicies.push(textarea.virtualKeyboardPolicy);
      document.activeElement = textarea;
    },
    hasSelection: () => selected,
    onSelectionChange(listener: () => void) {
      onSelectionChange = listener;
      return {
        dispose() {
          onSelectionChange = undefined;
        },
      };
    },
  };
  return {
    keyboard: terminalKeyboard(terminal as unknown as Terminal, mobile),
    terminal,
    textarea,
    document,
    focusPolicies,
    select() {
      selected = true;
      onSelectionChange?.();
    },
  };
}

test("mobile activation sets automatic keyboard policy before every focus", () => {
  const input = createKeyboard();
  expect(input.textarea.virtualKeyboardPolicy).toBe("manual");

  input.keyboard.activate();
  input.keyboard.activate();

  expect(input.focusPolicies).toEqual(["auto", "auto"]);
  expect(virtualKeyboard.show).toHaveBeenCalledTimes(2);
  input.keyboard.dispose();
});

test("a window blur keeps automatic policy until focus leaves the terminal textarea", () => {
  const input = createKeyboard();
  input.keyboard.activate();

  input.textarea.dispatchEvent(new Event("blur"));
  expect(input.textarea.virtualKeyboardPolicy).toBe("auto");

  input.document.activeElement = new EventTarget();
  input.textarea.dispatchEvent(new Event("blur"));
  expect(input.textarea.virtualKeyboardPolicy).toBe("manual");
  input.keyboard.dispose();
});

test("desktop selection uses manual policy until explicit keyboard activation", () => {
  const input = createKeyboard(false);
  expect(input.textarea.virtualKeyboardPolicy).toBe("auto");

  input.select();
  expect(input.textarea.virtualKeyboardPolicy).toBe("manual");
  input.keyboard.activate();

  expect(input.focusPolicies).toEqual(["auto"]);
  expect(virtualKeyboard.show).not.toHaveBeenCalled();
  input.keyboard.dispose();
});

test("disabled terminal input does not activate the keyboard", () => {
  const input = createKeyboard();
  input.terminal.options.disableStdin = true;

  input.keyboard.activate();

  expect(input.textarea.virtualKeyboardPolicy).toBe("manual");
  expect(input.focusPolicies).toEqual([]);
  expect(virtualKeyboard.show).not.toHaveBeenCalled();
  input.keyboard.dispose();
});
