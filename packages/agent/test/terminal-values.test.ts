import { expect, test } from "vitest";
import {
  AppError,
  asError,
  parseInputPosition,
  parseScreenPosition,
  parseScreenWait,
  parseSessionInput,
  parseSnapshotOptions,
  parseTerminalCols,
  parseTerminalPosition,
  parseTerminalQuietMs,
  parseTerminalRows,
  parseTerminalTail,
  parseTerminalTimeoutMs,
} from "@kiteline/shared/protocol";

const position = { epoch: "epoch", seq: 0 };

test("terminal positions share the 128 UTF-16 epoch limit without restricting Unicode or colons", () => {
  const epoch = "界".repeat(126) + "😀";
  for (const parse of [
    (epoch: unknown) => parseTerminalPosition({ epoch, seq: 0 }),
    (epoch: unknown) => parseInputPosition({ epoch, inputSeq: 0 }),
    (epoch: unknown) => parseScreenPosition({ epoch, seq: 0, tail: null, attrs: false }),
  ]) {
    expect(parse(epoch)).toMatchObject({ epoch });
    expect(parse("wire:epoch")).toMatchObject({ epoch: "wire:epoch" });
    for (const invalid of [epoch + "x", "", "e\0", null])
      expect(() => parse(invalid)).toThrowError(AppError);
  }
  expect(parseTerminalPosition({ epoch: "e", seq: Number.MAX_SAFE_INTEGER })).toEqual({
    epoch: "e",
    seq: Number.MAX_SAFE_INTEGER,
  });
  for (const seq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"])
    expect(() => parseTerminalPosition({ epoch: "e", seq })).toThrowError(AppError);
  expect(parseInputPosition({ epoch: "e", inputSeq: 2, seq: 99 })).toEqual({
    epoch: "e",
    inputSeq: 2,
  });
  expect(() => parseInputPosition({ epoch: "e", seq: 2 })).toThrowError(AppError);
  for (const invalid of [null, []])
    expect(() => parseTerminalPosition(invalid)).toThrowError(AppError);
});

test("snapshot conditions require explicit options while omitted screen options stay omitted", () => {
  expect(parseSnapshotOptions({})).toEqual({ tail: undefined, attrs: undefined });
  expect(parseSnapshotOptions({ tail: 0, attrs: false })).toEqual({ tail: 0, attrs: false });
  for (const options of [{ tail: null }, { attrs: null }])
    expect(() => parseSnapshotOptions(options)).toThrowError(AppError);
  for (const tail of [null, 0, 50_000]) {
    const ifChanged = { ...position, tail, attrs: false };
    expect(parseSnapshotOptions({ ifChanged })).toEqual({
      tail: undefined,
      attrs: undefined,
      ifChanged,
    });
  }
  for (const ifChanged of [
    position,
    { ...position, attrs: false },
    { ...position, tail: null },
    { ...position, tail: null, attrs: null },
  ])
    expect(() => parseScreenPosition(ifChanged)).toThrowError(AppError);
});

test("terminal input preserves empty and literal text and ignores unrelated key payload", () => {
  for (const type of ["text", "paste"] as const) {
    expect(parseSessionInput({ type, text: "", enter: false })).toEqual({
      type,
      text: "",
      enter: false,
    });
    expect(parseSessionInput({ type, text: "Enter\0", enter: true })).toEqual({
      type,
      text: "Enter\0",
      enter: true,
    });
  }
  expect(parseSessionInput({ type: "key", key: "Enter", enter: "ignored", text: 1 })).toEqual({
    type: "key",
    key: "Enter",
  });
  for (const input of [
    { type: "raw", text: "x" },
    { type: "key", key: "Home" },
    { type: "text", text: 1 },
    { type: "paste", text: "x", enter: null },
  ])
    expect(() => parseSessionInput(input)).toThrowError(AppError);
});

test("wire wait defaults and irrelevant fields stay distinct from CLI combination rules", () => {
  expect(parseScreenWait({})).toEqual({
    tail: undefined,
    attrs: undefined,
    mode: "quiet",
    quietMs: 300,
  });
  expect(parseScreenWait({ quietMs: null, after: "ignored" })).toMatchObject({
    mode: "quiet",
    quietMs: 300,
  });
  expect(parseScreenWait({ mode: "change", after: position, quietMs: "ignored" })).toEqual({
    tail: undefined,
    attrs: undefined,
    mode: "change",
    after: position,
  });
  for (const params of [{ mode: null }, { mode: "match" }, { mode: "change" }])
    expect(() => parseScreenWait(params)).toThrowError(AppError);
});

test("explicit terminal dimensions and durations use the protocol integer ranges", () => {
  for (const [parse, min, max] of [
    [parseTerminalTail, 0, 50_000],
    [parseTerminalCols, 1, 500],
    [parseTerminalRows, 1, 200],
    [parseTerminalQuietMs, 1, 10_000],
    [parseTerminalTimeoutMs, 1, 10_000],
  ] as const) {
    expect(parse(min)).toBe(min);
    expect(parse(max)).toBe(max);
    for (const value of [min - 1, max + 1, 1.5, null, undefined]) {
      try {
        parse(value);
        expect.fail("A missing, non-integer or out-of-range terminal value must be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(asError(error)).toMatchObject({ code: "invalid_argument" });
      }
    }
  }
});
