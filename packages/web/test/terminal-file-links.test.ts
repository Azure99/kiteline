import { expect, test } from "vitest";
import { terminalFileTarget } from "../src/terminal/file-links";

test("terminal paths use the source workspace root and only consume the line suffix", () => {
  for (const value of [
    "src/main.ts:61:3",
    "./src/main.ts:61",
    "/work/app/src/main.ts:61",
    "file:///work/app/src/main.ts:61",
  ])
    expect(terminalFileTarget(value, "/work/app")).toEqual({ path: "src/main.ts", line: 61 });
  expect(terminalFileTarget("./README", "C:\\work\\app")).toEqual({
    path: "README",
    line: undefined,
  });
  expect(terminalFileTarget("src/中文 文件.ts:12", "/work/app")).toEqual({
    path: "src/中文 文件.ts",
    line: 12,
  });
  expect(terminalFileTarget("file://localhost/work/app/a/../main.ts:2", "/work/app")).toEqual({
    path: "main.ts",
    line: 2,
  });
});

test("unsupported paths and invalid line suffixes do not produce a file action", () => {
  for (const value of [
    "word",
    "../main.ts",
    "/work/application/main.ts",
    "~/main.ts",
    "C:\\work\\app\\main.ts",
    "file://remote/work/app/main.ts",
    "src/main.ts:0",
    "src/main.ts:1.5",
    "src/main.ts:999999999999999999",
    "src/main.ts\nother.ts",
    "file:///work/app/a%0Ab.ts",
  ])
    expect(terminalFileTarget(value, "/work/app"), value).toBeUndefined();
});
