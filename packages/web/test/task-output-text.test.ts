import { expect, test } from "vitest";
import { mergeOutput, outputText, type StreamOutput } from "../src/tasks/output-text";

function readPiece(
  text: string,
  offset: number,
  { finished = false, storedBytes }: { finished?: boolean; storedBytes?: number } = {},
) {
  const nextOffset = offset + Buffer.byteLength(text);
  return {
    text,
    offset,
    nextOffset,
    storedBytes: storedBytes ?? nextOffset,
    truncated: false,
    finished,
  };
}

function emptyOutput(): StreamOutput {
  return { chunks: [], nextOffset: 0, carry: "" };
}

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

test("merged pieces preserve raw byte offsets even when controls have no visible text", () => {
  const first = mergeOutput(emptyOutput(), readPiece("界\x1b[3", 0));
  expect(first.output).toEqual({
    chunks: [{ offset: 0, text: "界" }],
    nextOffset: 6,
    carry: "\x1b[3",
  });
  const control = mergeOutput(first.output, readPiece("1m", first.output.nextOffset));
  expect(control.output).toEqual({
    chunks: [{ offset: 0, text: "界" }],
    nextOffset: 8,
    carry: "",
  });
  const end = mergeOutput(
    control.output,
    readPiece("红\r\n", control.output.nextOffset, { finished: true }),
  );
  expect(end).toEqual({
    output: {
      chunks: [
        { offset: 0, text: "界" },
        { offset: 8, text: "红\r\n" },
      ],
      nextOffset: 13,
      carry: "",
    },
    reset: false,
    final: true,
    hasUnreadBytes: false,
  });
});

test("reset replaces only one stream's chunks and carry, including an empty replacement", () => {
  const stdout = mergeOutput(emptyOutput(), readPiece("old\x1b[3", 0)).output;
  const stderr = mergeOutput(emptyOutput(), readPiece("error\x1b]unfinished", 0)).output;
  const replacement = mergeOutput(stdout, readPiece("1mnew", 0));
  expect(replacement.reset).toBe(true);
  expect(replacement.output).toEqual({
    chunks: [{ offset: 0, text: "1mnew" }],
    nextOffset: 5,
    carry: "",
  });
  const empty = mergeOutput(replacement.output, readPiece("", 0, { finished: true }));
  expect(empty.reset).toBe(true);
  expect(empty.output).toEqual(emptyOutput());
  const errorEnd = mergeOutput(
    stderr,
    readPiece("\x07tail", stderr.nextOffset, { finished: true }),
  );
  expect(errorEnd.output.chunks.map((chunk) => chunk.text).join("")).toBe("errortail");
  expect(stderr.carry).toBe("\x1b]unfinished");
});

test("empty final reads release carry once while empty growing reads retain it", () => {
  const first = mergeOutput(emptyOutput(), readPiece("before \x1b]8;;unfinished", 0)).output;
  const growing = mergeOutput(first, readPiece("", first.nextOffset));
  expect(growing.output).toEqual(first);
  expect(growing.final).toBe(false);
  const final = mergeOutput(growing.output, readPiece("", first.nextOffset, { finished: true }));
  expect(final.output.carry).toBe("");
  expect(final.output.chunks.map((chunk) => chunk.text).join("")).toBe("before 8;;unfinished");
  const reread = mergeOutput(final.output, readPiece("", first.nextOffset, { finished: true }));
  expect(reread.output).toEqual(final.output);
  expect(reread.final).toBe(true);
});

test("a stopped stream is final only after all stored bytes have been read", () => {
  const first = mergeOutput(
    emptyOutput(),
    readPiece("\x1b[3", 0, { finished: true, storedBytes: 10 }),
  );
  expect(first.final).toBe(false);
  expect(first.hasUnreadBytes).toBe(true);
  expect(first.output.carry).toBe("\x1b[3");
  const stalled = mergeOutput(
    first.output,
    readPiece("", first.output.nextOffset, { finished: true, storedBytes: 10 }),
  );
  expect(stalled.final).toBe(false);
  expect(stalled.hasUnreadBytes).toBe(true);
  expect(stalled.output).toEqual(first.output);
  const final = mergeOutput(
    first.output,
    readPiece("1mtext!", first.output.nextOffset, { finished: true }),
  );
  expect(final.final).toBe(true);
  expect(final.hasUnreadBytes).toBe(false);
  expect(final.output.chunks).toEqual([{ offset: 3, text: "text!" }]);
});
