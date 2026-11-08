import { expect, test } from "vitest";
import type { ProgramStatusRecord } from "@kiteline/shared/protocol";
import type { ReceivedReport } from "../src/terminal/reports";
import type { TerminalStatus } from "../src/devices/workspace-status";
import { entryState, statusEntries } from "../src/devices/workspace-status-entries";

const terminal: TerminalStatus = {
  deviceId: "device",
  workspaceId: "workspace",
  sessionId: "session",
  name: "Session",
  current: true,
};
function notice(body: string, blocked = false): ReceivedReport {
  return {
    type: "terminal.notice",
    deviceId: "device",
    workspaceId: "workspace",
    sessionId: "session",
    name: "Session",
    noticeId: "notice",
    receivedAt: 1,
    notice: { title: "Earlier report", body, blocked },
  };
}

test("an open wait leads with its own text; other records stay newest first", () => {
  const records: ProgramStatusRecord[] = [
    { id: "", state: "blocked", kind: "question", msg: "Overwrite?" },
    { id: "worker", state: "working", msg: "Tests 128/240" },
    { id: "finished", state: "done", msg: "Docs updated" },
  ];
  const view = statusEntries(terminal, records);
  expect(view.lead).toMatchObject({ type: "program", record: { id: "", state: "blocked" } });
  expect(view.preview).toEqual({ text: "Overwrite?" });
  expect(view.more).toBe(2);
  expect(view.entries.map((entry) => entry.type === "program" && entry.record.id)).toEqual([
    "",
    "finished",
    "worker",
  ]);
  const completed = statusEntries(terminal, records.slice(1));
  expect(entryState(completed.lead)).toBe("done");
  expect(completed.preview).toEqual({ text: "Docs updated" });
});

test("matching state and message share the newest representative regardless of other fields", () => {
  const representative: ProgramStatusRecord = {
    id: "different/branch",
    state: "blocked",
    kind: "permission",
    title: "New title",
    app: "NewApp",
    progress: 80,
    msg: "Approve?",
  };
  const report = notice("Approve?", true);
  const view = statusEntries({ ...terminal, report }, [
    { id: "", state: "blocked", kind: "question", title: "Old title", msg: "Approve?" },
    { id: "other", state: "done", msg: "Unrelated result" },
    representative,
  ]);
  expect(view.entries).toEqual([
    { type: "program", record: representative, app: "NewApp", report },
    { type: "program", record: { id: "other", state: "done", msg: "Unrelated result" } },
  ]);
  expect(view.preview).toEqual({ text: "Approve?" });
  expect(view.more).toBe(1);
});

test("equal text in different states stays separate; the notification labels only the first", () => {
  const report = notice("Same text");
  const view = statusEntries({ ...terminal, report }, [
    { id: "error", state: "error", msg: "Same text" },
    { id: "done", state: "done", msg: "Same text" },
    { id: "wait", state: "blocked", msg: "Same text" },
  ]);
  expect(view.entries).toMatchObject([
    { type: "program", record: { id: "wait" }, report },
    { type: "program", record: { id: "error" } },
    { type: "program", record: { id: "done" } },
  ]);
  expect(view.entries.filter((entry) => entry.type === "program" && entry.report)).toHaveLength(1);
  expect(view.more).toBe(2);
});

test("missing and empty current messages merge by state, while an empty notification stays separate", () => {
  const report = notice("");
  const view = statusEntries({ ...terminal, report }, [
    { id: "first", state: "done", title: "First" },
    { id: "working", state: "working" },
    { id: "last", state: "done", title: "Last", msg: "" },
  ]);
  expect(view.entries).toMatchObject([
    { type: "program", record: { id: "last" } },
    { type: "program", record: { id: "working" } },
    { type: "report", report },
  ]);
  expect(view.preview).toBeUndefined();
  expect(view.more).toBe(2);
});

test("different original text is not normalized or merged with notifications", () => {
  const report = notice("Ready");
  const view = statusEntries({ ...terminal, report }, [
    { id: "first", state: "done", msg: "Ready " },
    { id: "second", state: "done", msg: "ready" },
  ]);
  expect(view.entries).toHaveLength(3);
  expect(view.entries[2]).toEqual({ type: "report", report });
  expect(view.more).toBe(2);
});

test("only an empty current done previews a non-waiting notification with its receipt metadata", () => {
  const report = notice("Old reply");
  const view = statusEntries({ ...terminal, report }, [{ id: "", state: "done" }]);
  expect(entryState(view.lead)).toBe("done");
  expect(view.preview).toEqual({ text: "Old reply", notification: report });
  expect(view.more).toBe(1);
  expect(view.entries[1]).toEqual({ type: "report", report });
  for (const state of ["working", "blocked", "error"] as const) {
    expect(statusEntries({ ...terminal, report }, [{ id: "", state }]).preview).toBeUndefined();
  }
  expect(
    statusEntries({ ...terminal, report: notice("Old question", true) }, [
      { id: "", state: "done" },
    ]).preview,
  ).toBeUndefined();
  expect(
    statusEntries({ ...terminal, report }, [{ id: "", state: "done", msg: "Current result" }])
      .preview,
  ).toEqual({ text: "Current result" });
});

test("without records all known states remain in one summary section and history stays separate", () => {
  const report = notice("Cleared child's question", true);
  const source: TerminalStatus = {
    ...terminal,
    current: false,
    summary: { states: ["working", "done", "blocked", "idle"], records: 100 },
    report,
  };
  const view = statusEntries(source, undefined);
  expect(view.lead).toEqual({ type: "summary", states: ["blocked", "working", "done"] });
  expect(entryState(view.lead)).toBe("blocked");
  expect(view.preview).toBeUndefined();
  expect(view.more).toBe(1);
  expect(view.entries[1]).toEqual({ type: "report", report });
  expect(statusEntries({ ...source, report: undefined }, undefined).more).toBe(0);
  expect(
    statusEntries(
      { ...source, summary: { states: ["done"], records: 1 }, report: notice("Old reply") },
      undefined,
    ).preview,
  ).toBeUndefined();
});

test("idle-only stays explicit, while idle with a notification leads with that notification", () => {
  const records: ProgramStatusRecord[] = [{ id: "", state: "idle", app: "codex" }];
  const idle = statusEntries(terminal, records);
  expect(idle.lead).toEqual({ type: "summary", states: ["idle"] });
  expect(idle.more).toBe(0);
  const report = notice("Final reply excerpt");
  const notified = statusEntries({ ...terminal, report }, records);
  expect(notified.lead).toEqual({ type: "report", report });
  expect(notified.preview).toEqual({ text: "Final reply excerpt" });
  expect(notified.more).toBe(0);
  expect(
    statusEntries({ ...terminal, summary: { states: ["idle"], records: 1 } }, []).entries,
  ).toEqual([]);
});

test("idle ancestors supply app names without adding sections", () => {
  const view = statusEntries(terminal, [
    { id: "", state: "idle", app: "Root" },
    { id: "group", state: "idle", app: "WorkerApp" },
    { id: "group/one", state: "working", msg: "First" },
    { id: "group/two", state: "working", msg: "Second" },
  ]);
  expect(view.entries).toMatchObject([
    { type: "program", record: { id: "group/two" }, app: "WorkerApp" },
    { type: "program", record: { id: "group/one" }, app: "WorkerApp" },
  ]);
  expect(view.more).toBe(1);
});
