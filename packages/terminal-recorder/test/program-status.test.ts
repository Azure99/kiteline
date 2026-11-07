import { expect, test } from "vitest";
import headless from "@xterm/headless";
import {
  ProgramStatusStore,
  parseProgramStatus,
  programStatusApp,
} from "@kiteline/shared/protocol";
import type { TerminalEvent } from "@kiteline/shared/protocol/ipc";
import { Model, type Snapshot } from "../src/model.js";

const osc = (body: string) => `\x1b]7501;${body}\x1b\\`;
const base64 = (text: string) => Buffer.from(text).toString("base64");

test("reports replace whole records, resolve ancestor app and clear path subtrees", () => {
  const store = new ProgramStatusStore();
  for (const body of [
    "state=idle:app=build",
    `state=blocked:id=worker:kind=question:progress=40:msg=${base64("Approve?")}`,
    "state=done:id=worker/test",
    "state=working:id=worker2",
  ])
    store.apply(parseProgramStatus(body)!);
  expect(store.summary()).toEqual({
    states: ["working", "done", "blocked", "idle"],
    records: 4,
  });
  const child = store.snapshot().find((record) => record.id === "worker")!;
  expect(programStatusApp(child, store.snapshot())).toBe("build");
  expect(child.app).toBeUndefined();
  store.apply(parseProgramStatus("state=working:id=worker")!);
  expect(store.snapshot().find((record) => record.id === "worker")).toEqual({
    id: "worker",
    state: "working",
  });
  store.apply(parseProgramStatus("state=clear:id=worker")!);
  expect(store.snapshot().map((record) => record.id)).toEqual(["", "worker2"]);
  store.apply(parseProgramStatus("state=clear")!);
  expect(store.summary()).toEqual({ states: [], records: 0 });
});

test("unknown and malformed fields have protocol semantics and invalid text rejects atomically", () => {
  expect(
    parseProgramStatus(
      `state=working:garbage:bad=has space:app=any-tool:id=parent/child: state = blocked :title=${base64("测试")}:msg=${base64("Approve?").replace(/=+$/, "")}`,
    ),
  ).toEqual({
    id: "parent/child",
    state: "blocked",
    app: "any-tool",
    title: "测试",
    msg: "Approve?",
  });
  expect(parseProgramStatus("?")).toBeUndefined();
  expect(parseProgramStatus("state=future")).toBeUndefined();
  expect(
    parseProgramStatus("state=blocked:unknown=ok:bad pair:kind=future:app=bad/path:progress=101"),
  ).toEqual({ id: "", state: "blocked" });
  expect(parseProgramStatus("state=working:state=done:kind=permission:progress=3")).toEqual({
    id: "",
    state: "done",
  });
  for (const invalid of [
    "msg=a",
    "msg=YQ=",
    "msg=/w==",
    `msg=${base64("line\nbreak")}`,
    "id=bad//path",
    "id=bad%path",
    `id=${"x/".repeat(8)}x`,
    `id=${"x".repeat(33)}`,
    `app=${"a".repeat(33)}`,
    `title=${base64("a".repeat(193))}`,
    `msg=${base64("a".repeat(2049))}`,
    `${"x".repeat(17)}=y`,
    `unknown=${"x".repeat(4096)}`,
  ])
    expect(
      parseProgramStatus(`state=done:${invalid}:msg=${base64("later")}`),
      invalid,
    ).toBeUndefined();
});

test("a blocked record produces one historical notice independent of later states", async () => {
  const { target, notices } = model();
  try {
    expect((await target.observe({}, false)).reason).toBe("full");
    expect(target.programStatus.summary()).toEqual({ states: [], records: 0 });
    await write(
      target,
      osc(`state=blocked:title=${base64("Question")}:msg=${base64("Continue?")}`),
    );
    expect(notices).toEqual([{ title: "Question", body: "Continue?", blocked: true }]);
    await write(target, osc("state=working") + osc("state=clear"));
    expect(notices).toHaveLength(1);
    expect(target.programStatus.summary()).toEqual({ states: [], records: 0 });
  } finally {
    await target.dispose();
  }
});

test.each([
  { root: "working", child: "done" },
  { root: "done", child: "working" },
] as const)(
  "mixed states remain visible with root $root and child $child",
  async ({ root, child }) => {
    const { target } = model();
    try {
      await write(target, osc(`state=${root}`) + osc(`state=${child}:id=worker`));
      expect(target.programStatus.summary()).toEqual({
        states: [child, root],
        records: 2,
      });
      const snapshot = await target.observe({}, false);
      expect("programStatus" in snapshot && snapshot.programStatus).toEqual([
        { id: "", state: root },
        { id: "worker", state: child },
      ]);
    } finally {
      await target.dispose();
    }
  },
);

test("record eviction removes the earliest appearance, including the root, at the 256-record cap", () => {
  const store = new ProgramStatusStore();
  for (let index = 0; index < 256; index++)
    store.apply({ id: index === 0 ? "" : `worker${index}`, state: "working" });
  store.apply({ id: "", state: "done" });
  store.apply({ id: "new", state: "idle" });
  expect(store.snapshot()).toHaveLength(256);
  expect(store.snapshot().some((record) => record.id === "worker1")).toBe(false);
  expect(store.snapshot().some((record) => record.id === "")).toBe(true);
});

test("record order follows state changes; repeated reports and text updates keep their place", () => {
  const store = new ProgramStatusStore();
  store.apply({ id: "", state: "blocked", msg: "Choose" });
  store.apply({ id: "worker", state: "working", msg: "Tests 1/2" });
  store.apply({ id: "finished", state: "done" });
  store.apply({ id: "worker", state: "working", msg: "Tests 2/2" });
  store.apply({ id: "", state: "blocked", msg: "Choose" });
  expect(store.snapshot().map((record) => record.id)).toEqual(["", "worker", "finished"]);
  expect(store.snapshot()[1]?.msg).toBe("Tests 2/2");
  store.apply({ id: "worker", state: "done" });
  expect(store.snapshot().map((record) => record.id)).toEqual(["", "finished", "worker"]);
});

test("changed blocked fields move the record; working updates and repeats do not", () => {
  const store = new ProgramStatusStore();
  store.apply({ id: "", state: "blocked", kind: "question", msg: "Q1" });
  store.apply({ id: "w", state: "working", msg: "1/2" });
  store.apply({ id: "w", state: "working", msg: "2/2", progress: 90 });
  expect(store.snapshot().map((record) => record.id)).toEqual(["", "w"]);
  expect(store.summary().states).toEqual(["working", "blocked"]);
  store.apply({ id: "", state: "blocked", kind: "permission", msg: "Run rm -rf build?" });
  expect(store.snapshot().map((record) => record.id)).toEqual(["w", ""]);
  expect(store.summary().states).toEqual(["blocked", "working"]);
});

function model() {
  const notices: unknown[] = [];
  const target = new Model(
    { cols: 80, rows: 5, historyLines: 100 },
    {
      fault: (error) => {
        throw error;
      },
      backlogChanged: () => {},
      notice: (notice) => notices.push(notice),
    },
  );
  return { target, notices };
}
async function write(target: Model, data: string) {
  for (const byte of Buffer.from(data)) target.output(Buffer.from([byte]));
  await target.ordered(() => {});
}

test("prompt/exit expire active records; alternate screen and DECSTR preserve them; RIS clears", async () => {
  const { target } = model();
  try {
    await write(
      target,
      osc("state=working") +
        osc("state=blocked:id=a") +
        osc("state=done:id=b") +
        osc("state=error:id=c"),
    );
    await write(target, "\x1b[?1049h\x1b[?1049l\x1b[!p");
    expect(target.programStatus.snapshot()).toHaveLength(4);
    await write(target, "\x1b]133;A\x07");
    expect(target.programStatus.snapshot().map((record) => record.state)).toEqual([
      "done",
      "error",
    ]);
    await write(target, osc("state=working:id=d"));
    await target.ordered(() => target.finishProgramStatus());
    const snapshot = await target.observe({}, false);
    expect(
      "programStatus" in snapshot && snapshot.programStatus.map((record) => record.state),
    ).toEqual(["done", "error"]);
    await write(target, "\x1bc");
    expect(target.programStatus.snapshot()).toEqual([]);
  } finally {
    await target.dispose();
  }
});

test("screen recovery and final output stay separate from JSON program status", async () => {
  const { target, notices } = model();
  const viewer = new headless.Terminal({ cols: 80, rows: 5, allowProposedApi: true });
  const replies: string[] = [];
  viewer.onData((data) => replies.push(data));
  const live: TerminalEvent[] = [];
  let snapshot!: Snapshot;
  const output = (data: string | Uint8Array) =>
    new Promise<void>((resolve) => viewer.write(data, resolve));
  try {
    await write(
      target,
      osc("?") + osc("state=blocked:id=a:kind=question") + osc("state=done:id=b") + "BEFORE\r\n",
    );
    await target.checkpointNow();
    const detach = await target.attach(
      "retained",
      1000,
      (value) => {
        snapshot = value;
      },
      (event) => live.push(event),
      new AbortController().signal,
    );
    expect(snapshot.data.toString()).not.toContain("7501");
    await output(snapshot.data);
    await write(target, "FINAL_TAIL_23" + "\x1b]7501;state=working");
    await target.ordered(() => target.finishProgramStatus());
    for (const event of live) if (event.type === "output") await output(event.data);
    const observed = await target.observe({}, false);
    expect("programStatus" in observed && observed.programStatus).toEqual([
      { id: "b", state: "done" },
    ]);
    expect(viewer.buffer.active.getLine(1)!.translateToString(true)).toBe("FINAL_TAIL_23");
    expect(notices).toHaveLength(1);
    expect(replies).toEqual([]);
    detach();
  } finally {
    viewer.dispose();
    await target.dispose();
  }
});
