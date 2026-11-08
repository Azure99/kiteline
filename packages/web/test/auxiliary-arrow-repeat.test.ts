import type { Terminal } from "@xterm/xterm";
import { expect, test } from "vitest";
import { AuxiliaryInput, releasedModifiers, type Modifiers } from "../src/terminal/auxiliary-input";

function input() {
  const sent: string[] = [];
  const modes = { applicationCursorKeysMode: false };
  let modifiers = releasedModifiers;
  const terminal = {
    element: new EventTarget(),
    textarea: new EventTarget(),
    options: { disableStdin: false },
    modes,
    attachCustomKeyEventHandler() {},
    input: (value: string) => sent.push(value),
  } as unknown as Terminal;
  const auxiliary = new AuxiliaryInput(terminal, (value) => (modifiers = value));
  return { auxiliary, sent, modes, modifiers: () => modifiers };
}

test("a held chord repeats without consuming a later modifier latch", () => {
  const { auxiliary, sent, modifiers } = input();
  auxiliary.toggle("ctrlKey");
  const chord: Modifiers = { ...modifiers() };

  auxiliary.key("ArrowLeft");
  expect(sent).toEqual(["\x1b[1;5D"]);
  expect(modifiers()).toEqual(releasedModifiers);

  auxiliary.toggle("shiftKey");
  auxiliary.key("ArrowLeft", chord);
  auxiliary.key("ArrowLeft", chord);
  expect(sent).toEqual(["\x1b[1;5D", "\x1b[1;5D", "\x1b[1;5D"]);
  expect(modifiers()).toEqual({ shiftKey: true, ctrlKey: false, altKey: false });

  auxiliary.key("ArrowRight");
  expect(sent.at(-1)).toBe("\x1b[1;2C");
  expect(modifiers()).toEqual(releasedModifiers);
  auxiliary.dispose();
});

test("each repeated arrow uses the current application cursor mode", () => {
  const { auxiliary, sent, modes } = input();
  auxiliary.key("ArrowUp");
  modes.applicationCursorKeysMode = true;
  auxiliary.key("ArrowUp", releasedModifiers);
  modes.applicationCursorKeysMode = false;
  auxiliary.key("ArrowUp", releasedModifiers);

  expect(sent).toEqual(["\x1b[A", "\x1bOA", "\x1b[A"]);
  auxiliary.dispose();
});
