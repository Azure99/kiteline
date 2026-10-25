import { expect, test } from "vitest";
import { outputText } from "../src/tasks/output-text";

test("plain text preserves Unicode, newlines, carriage returns and tabs", () => {
  const text = "plain 界\nnext\rkeep\tcolumn";
  expect(outputText("", text, true)).toEqual({ text, carry: "" });
});

test("a CSI sequence split between reads is removed without losing its text", () => {
  const first = outputText("", "before \x1b[3", false);
  const second = outputText(first.carry, "1mred\x1b[0m\n", true);
  expect(first.text + second.text).toBe("before red\n");
  expect(second.carry).toBe("");
});

test.each(["\x07", "\x1b\\"])("an OSC ending %j is removed across reads", (ending) => {
  const first = outputText("", "before \x1b]8;;https://example.com", false);
  const second = outputText(first.carry, ending.slice(0, 1), false);
  const third = outputText(second.carry, `${ending.slice(1)}label\x1b]8;;${ending}\n`, true);
  expect(first.text + second.text + third.text).toBe("before label\n");
  expect(third.carry).toBe("");
});

test("interleaved stdout and stderr reads keep their control sequences separate", () => {
  const stdout = outputText("", "\x1b[3", false);
  const stderr = outputText("", "\x1b[32mstderr\x1b[0m\n", false);
  const stdoutEnd = outputText(stdout.carry, "1mstdout\x1b[0m\n", true);
  expect(stdout.text + stdoutEnd.text).toBe("stdout\n");
  expect(stderr.text).toBe("stderr\n");
  expect(stdoutEnd.carry).toBe("");
  expect(stderr.carry).toBe("");
});

test("an empty final read releases an unterminated OSC without a newline", () => {
  const first = outputText("", "before \x1b]8;;unfinished", false);
  const final = outputText(first.carry, "", true);
  expect(first.text + final.text).toBe("before 8;;unfinished");
  expect(final.carry).toBe("");
});

test("rereading completed output releases the same unterminated OSC", () => {
  expect(outputText("", "before \x1b]8;;unfinished", true)).toEqual({
    text: "before 8;;unfinished",
    carry: "",
  });
});
