import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Load the vendor at runtime so the application tsconfig does not recheck xterm's source.
const helperPath = createRequire(import.meta.url).resolve(
  "@xterm/xterm/src/browser/input/CompositionHelper.ts",
);
const { CompositionHelper } = await import(helperPath);

interface CompositionInput {
  compositionstart(): void;
  compositionupdate(event: Pick<CompositionEvent, "data">): void;
  compositionend(): void;
  keydown(event: KeyboardEvent): boolean;
  input(text: string): boolean;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createInput() {
  const textarea = { value: "", selectionStart: 0, selectionEnd: 0 };
  const view = { textContent: "", classList: { add() {}, remove() {} } };
  const data: string[] = [];
  const helper: CompositionInput = new CompositionHelper(
    textarea,
    view,
    { buffer: { isCursorInViewport: false } },
    {},
    {
      triggerDataEvent(text: string) {
        data.push(text);
      },
    },
    {},
  );
  return {
    helper,
    setValue(value: string) {
      textarea.value = value;
      textarea.selectionStart = textarea.selectionEnd = value.length;
    },
    keydown(keyCode: number) {
      return helper.keydown({ keyCode } as KeyboardEvent);
    },
    enter() {
      // The terminal sends CR and clears its textarea after the helper accepts Enter.
      expect(helper.keydown({ keyCode: 13 } as KeyboardEvent)).toBe(true);
      data.push("\r");
      textarea.value = "";
    },
    bytes() {
      return Buffer.from(data.join("")).toString("hex");
    },
  };
}

test.each(["timer-before-input", "input-before-timer"])(
  "%s sends committed IME text once",
  (order) => {
    const input = createInput();
    expect(input.keydown(229)).toBe(false);
    if (order === "timer-before-input") vi.runAllTimers();

    input.setValue("你");
    expect(input.helper.input("你")).toBe(true);
    vi.runAllTimers();

    expect(input.bytes()).toBe("e4bda0");
  },
);

test("composition and its pending finalizer retain exclusive ownership of committed text", () => {
  const input = createInput();
  expect(input.keydown(229)).toBe(false);
  input.helper.compositionstart();
  input.setValue("你");
  input.helper.compositionupdate({ data: "你" });
  expect(input.helper.input("你")).toBe(false);
  vi.runAllTimers();
  expect(input.bytes()).toBe("");

  input.helper.compositionend();
  expect(input.helper.input("你")).toBe(false);
  vi.runAllTimers();
  expect(input.bytes()).toBe("e4bda0");
});

test("Enter after an English composition settles a pending 229 without adding DEL", () => {
  const input = createInput();
  input.helper.compositionstart();
  input.setValue("c");
  input.helper.compositionupdate({ data: "c" });
  vi.runAllTimers();
  input.helper.compositionend();
  vi.runAllTimers();
  expect(input.bytes()).toBe("63");

  expect(input.keydown(229)).toBe(false);
  input.enter();
  vi.runAllTimers();

  expect(input.bytes()).toBe("630d");
});

test("an ordinary key settles new IME text before the terminal clears its textarea", () => {
  const input = createInput();
  expect(input.keydown(229)).toBe(false);
  input.setValue("你");
  input.enter();
  vi.runAllTimers();

  expect(input.bytes()).toBe("e4bda00d");
});

test("a real deletion is sent before the following Enter", () => {
  const input = createInput();
  input.setValue("你好");
  expect(input.keydown(229)).toBe(false);
  input.setValue("你");
  input.enter();
  vi.runAllTimers();

  expect(input.bytes()).toBe("7f0d");
});

test("textarea observation still sends deletion when there is no committed input event", () => {
  const input = createInput();
  input.setValue("你好");
  expect(input.keydown(229)).toBe(false);
  input.setValue("你");
  vi.runAllTimers();

  expect(input.bytes()).toBe("7f");
});

test("ordinary keys without a pending observation continue without IME output", () => {
  const input = createInput();
  expect(input.keydown(65)).toBe(true);
  expect(input.keydown(13)).toBe(true);
  vi.runAllTimers();

  expect(input.bytes()).toBe("");
});
