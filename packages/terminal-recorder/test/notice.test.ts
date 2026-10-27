import { expect, test } from "vitest";
import type { TerminalNotice } from "@kiteline/shared/protocol";
import { terminalNotice } from "../src/notice.js";
import { Model } from "../src/model.js";

const base64 = (text: string) => Buffer.from(text).toString("base64");

test("ordinary OSC notifications preserve numeric text and semicolons, excluding progress", () => {
  expect(terminalNotice(9, "123;message")).toEqual({
    title: "",
    body: "123;message",
    blocked: false,
  });
  expect(terminalNotice(9, "4")).toBeUndefined();
  expect(terminalNotice(9, "4;1;50")).toBeUndefined();
  expect(terminalNotice(777, "notify;Build;Done;next")).toEqual({
    title: "Build",
    body: "Done;next",
    blocked: false,
  });
  expect(terminalNotice(777, "notify;;")).toEqual({ title: "", body: "", blocked: false });
  expect(terminalNotice(777, "other;Build;Done")).toBeUndefined();
  expect(terminalNotice(777, "notify;Build")).toBeUndefined();
});

test("blocked reports decode text and apply pair ordering without keeping program state", () => {
  expect(
    terminalNotice(
      7501,
      `state=working:garbage:bad=has space:app=any-tool:id=parent/child: state = blocked :title=${base64("测试")}:msg=${base64("Approve?").replace(/=+$/, "")}`,
    ),
  ).toEqual({ title: "测试", body: "Approve?", blocked: true });
  expect(terminalNotice(7501, "state=blocked")).toEqual({ title: "", body: "", blocked: true });
  for (const body of [
    "?",
    "state=working",
    "state=idle",
    "state=clear",
    "state=blocked:state=working",
  ])
    expect(terminalNotice(7501, body)).toBeUndefined();
});

test("invalid encoded text, identifiers and protocol limits reject the whole blocked report", () => {
  for (const field of [
    "msg=a",
    "msg=YQ=",
    "msg=/w==",
    `msg=${base64("line\nbreak")}`,
    "id=bad//path",
    `id=${"x/".repeat(8)}x`,
    `id=${"x".repeat(33)}`,
    `app=${"x".repeat(33)}`,
    `title=${base64("x".repeat(193))}`,
    `msg=${base64("x".repeat(2049))}`,
    `${"x".repeat(17)}=y`,
    `unknown=${"x".repeat(4096)}`,
  ])
    expect(
      terminalNotice(7501, `state=blocked:${field}:msg=${base64("later")}`),
      field,
    ).toBeUndefined();
});

test("headless Model receives fragmented reports without any display attachment", async () => {
  const reports: TerminalNotice[] = [],
    faults: Error[] = [];
  const model = new Model(
    { cols: 80, rows: 24, historyLines: 100 },
    {
      fault: (error) => faults.push(error),
      backlogChanged: () => {},
      notice: (report) => reports.push(report),
    },
  );
  try {
    const bytes = Buffer.from(
      `before\x1b]9;123\x07\x1b]777;notify;Build;Done;next\x1b\\\x1b]7501;state=blocked:msg=${base64("确认")}\x07after`,
    );
    for (const byte of bytes) model.output(Buffer.from([byte]));
    await model.ordered(() => {});
    expect(reports).toEqual([
      { title: "", body: "123", blocked: false },
      { title: "Build", body: "Done;next", blocked: false },
      { title: "", body: "确认", blocked: true },
    ]);
    expect(model.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("beforeafter");
    expect(faults).toEqual([]);
  } finally {
    await model.dispose();
  }
});
