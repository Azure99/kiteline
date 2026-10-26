import type { Terminal } from "@xterm/xterm";
import { afterEach, expect, test, vi } from "vitest";
import { AuxiliaryInput } from "../src/terminal/auxiliary-input";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each([
  ["c", "\x03"],
  ["你好", "你好"],
  ["", undefined],
])("pending CTRL applies once when composition commits %j", async (text, expected) => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  const element = new EventTarget();
  const textarea = new EventTarget();
  const forwarded: string[] = [];
  let modifiers = { shiftKey: false, ctrlKey: false, altKey: false };
  // xterm registers first and forwards the committed textarea text on its queued callback.
  textarea.addEventListener("compositionend", () => {
    setTimeout(() => {
      if (text) forwarded.push(auxiliary.forward(text)!);
    }, 0);
  });
  const terminal = {
    element,
    textarea,
    options: { disableStdin: false },
    modes: { applicationCursorKeysMode: false },
    attachCustomKeyEventHandler() {},
  } as unknown as Terminal;
  const auxiliary = new AuxiliaryInput(terminal, (value) => (modifiers = value));
  const input = (data: string | null, isComposing: boolean) => {
    const event = new Event("input");
    Object.assign(event, { data, isComposing });
    element.dispatchEvent(event);
  };

  auxiliary.toggle("ctrlKey");
  textarea.dispatchEvent(new Event("compositionstart"));
  input(text, true);
  await vi.runOnlyPendingTimersAsync();
  input(text || null, !!text);
  textarea.dispatchEvent(new Event("compositionend"));
  await vi.runOnlyPendingTimersAsync();
  expect(forwarded).toEqual(expected === undefined ? [] : [expected]);
  expect(modifiers.ctrlKey).toBe(false);

  input("c", false);
  expect(auxiliary.forward("c")).toBe("c");
  auxiliary.dispose();
});
