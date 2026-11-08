import { expect, test } from "vitest";
import {
  summarizeProgramStatus,
  type Device,
  type ProgramStatusRecord,
  type ProgramStatusSummary,
  type Session,
} from "@kiteline/shared/protocol";
import type { ReceivedReport } from "../src/terminal/reports";
import {
  badgeCounts,
  reminderCount,
  terminalBucket,
  workspaceStatuses,
  type TerminalStatus,
} from "../src/devices/workspace-status";
import { entryState, statusEntries } from "../src/devices/workspace-status-entries";

const device: Device = {
  id: "device",
  name: "Device",
  status: "online",
  lastSeenAt: null,
  snapshot: {
    schemaVersion: 1,
    revision: 1,
    workspaces: [{ id: "workspace", name: "Workspace", path: "/workspace" }],
    shortcuts: [],
    settings: { historyLines: 5000 },
  },
};
const report: ReceivedReport = {
  type: "terminal.notice",
  deviceId: device.id,
  workspaceId: "workspace",
  sessionId: "terminal",
  name: "Terminal",
  noticeId: "notice",
  receivedAt: 1,
  notice: { title: "Earlier question", body: "Approve?", blocked: true },
};
function session(programStatus: ProgramStatusSummary, overrides: Partial<Session> = {}): Session {
  return {
    id: "terminal",
    workspaceId: "workspace",
    name: "Terminal",
    createdAt: "2026-11-07T00:00:00Z",
    historyLines: 5000,
    state: "running",
    webStatus: "available",
    historyGap: false,
    programStatus,
    ...overrides,
  };
}

test("there are no reminders without projected terminal statuses", () => {
  expect(reminderCount(workspaceStatuses([device], {}, []))).toBe(0);
});

test.each<{
  states: ProgramStatusRecord["state"][];
  notified: boolean;
  expected: number;
}>([
  { states: [], notified: false, expected: 0 },
  { states: ["idle"], notified: false, expected: 0 },
  { states: ["working"], notified: false, expected: 0 },
  { states: ["working", "idle"], notified: false, expected: 0 },
  { states: ["blocked"], notified: false, expected: 1 },
  { states: ["error"], notified: false, expected: 1 },
  { states: ["done"], notified: false, expected: 1 },
  { states: ["working", "done"], notified: false, expected: 1 },
  { states: ["working"], notified: true, expected: 1 },
  { states: ["idle"], notified: true, expected: 1 },
  { states: ["done"], notified: true, expected: 1 },
  { states: ["working", "blocked", "error", "done"], notified: true, expected: 1 },
  { states: [], notified: true, expected: 1 },
])(
  "reminders count $states with notified=$notified as $expected session",
  ({ states, notified, expected }) => {
    const statuses = workspaceStatuses(
      [device],
      { device: { sessions: [session({ states, records: states.length })], current: true } },
      notified ? [report] : [],
    );
    expect(reminderCount(statuses)).toBe(expected);
  },
);

test("reminders include every workspace and device, even when session IDs match", () => {
  const statuses = workspaceStatuses(
    [
      {
        ...device,
        snapshot: {
          ...device.snapshot!,
          workspaces: [
            ...device.snapshot!.workspaces,
            { id: "other-workspace", name: "Other workspace", path: "/other" },
          ],
        },
      },
      { ...device, id: "other-device", status: "offline" },
    ],
    {
      device: {
        sessions: [
          session({ states: ["done"], records: 1 }),
          session(
            { states: ["error"], records: 1 },
            { id: "other-terminal", workspaceId: "other-workspace" },
          ),
        ],
        current: true,
      },
      "other-device": {
        sessions: [session({ states: ["blocked"], records: 1 })],
        current: false,
      },
    },
    [{ ...report, deviceId: "other-device", sessionId: "ended" }],
  );
  expect(reminderCount(statuses)).toBe(4);
});

test("each terminal counts once, in the state its row leads with", () => {
  // Summary states are listed newest first.
  const status = workspaceStatuses(
    [device],
    {
      device: {
        sessions: [
          session({ states: ["working", "done", "blocked", "error"], records: 4 }),
          session({ states: ["done", "error", "idle"], records: 3 }, { id: "error" }),
          session({ states: ["done", "working"], records: 2 }, { id: "done" }),
          session({ states: ["working", "done"], records: 2 }, { id: "working" }),
        ],
        current: true,
      },
    },
    [report],
  ).get("device/workspace")!;
  // An open wait or error leads over newer states; otherwise the newest state leads.
  expect(
    status.terminals.map((terminal) => [terminal.sessionId, terminalBucket(terminal)]),
  ).toEqual([
    ["error", "error"],
    ["terminal", "blocked"],
    ["done", "done"],
    ["working", "working"],
  ]);
  expect(status.terminals[1]).toMatchObject({
    summary: { states: ["working", "done", "blocked", "error"], records: 4 },
    current: true,
    report,
  });
  expect(badgeCounts(status)).toEqual({ error: 1, blocked: 1, done: 1, working: 1 });
});

test.each<{ states: ProgramStatusRecord["state"][]; expected?: string }>([
  { states: ["idle"] },
  { states: ["done", "working"], expected: "working" },
  { states: ["working", "done"], expected: "done" },
  { states: ["blocked", "working", "done"], expected: "blocked" },
  { states: ["error", "blocked", "done"], expected: "blocked" },
  { states: ["blocked", "error", "working"], expected: "error" },
])("badge, list and summary agree for $states", ({ states, expected }) => {
  const records = states.map((state, index) => ({ id: String(index), state }));
  const terminal: TerminalStatus = {
    deviceId: "device",
    workspaceId: "workspace",
    sessionId: "terminal",
    name: "Terminal",
    current: true,
    summary: summarizeProgramStatus(records),
  };
  const shown = entryState(statusEntries(terminal, records).lead);
  expect(terminalBucket(terminal)).toBe(expected);
  expect(shown).toBe(expected ?? "idle");
  expect(entryState(statusEntries(terminal, undefined).lead)).toBe(shown);
});

test("idle and history remain distinct from completion and running", () => {
  const status = workspaceStatuses(
    [device],
    {
      device: {
        sessions: [session({ states: ["idle"], records: 1 })],
        current: true,
      },
    },
    [report, { ...report, sessionId: "ended", noticeId: "ended-notice" }],
  ).get("device/workspace")!;
  expect(status.terminals).toHaveLength(2);
  expect(status.terminals[0]).toMatchObject({
    summary: { states: ["idle"], records: 1 },
    report,
    current: true,
  });
  expect(status.terminals[1]).toMatchObject({ sessionId: "ended", current: false });
  expect(status.terminals[1]?.summary).toBeUndefined();
  expect(badgeCounts(status)).toEqual({ error: 0, blocked: 0, done: 2, working: 0 });

  const idle = workspaceStatuses(
    [device],
    { device: { sessions: [session({ states: ["idle"], records: 1 })], current: true } },
    [],
  ).get("device/workspace")!;
  expect(badgeCounts(idle)).toEqual({ error: 0, blocked: 0, done: 0, working: 0 });
});

test("recorder failure and an earlier connection's list preserve observations as previous", () => {
  const error = new Error("List read failed");
  for (const observation of [
    { current: true, webStatus: "unavailable" as const },
    { current: false, webStatus: "available" as const },
  ]) {
    const status = workspaceStatuses(
      [device],
      {
        device: {
          sessions: [
            session(
              { states: ["idle", "blocked"], records: 2 },
              { webStatus: observation.webStatus },
            ),
          ],
          current: observation.current,
          error: observation.current ? undefined : error,
        },
      },
      [],
    ).get("device/workspace")!;
    expect(status).toMatchObject({ offline: false, stale: true });
    expect(status.terminals[0]).toMatchObject({
      current: false,
      summary: { states: ["idle", "blocked"], records: 2 },
    });
  }
});

test("an unread notification does not outrank the program's current state", () => {
  const status = workspaceStatuses(
    [device],
    {
      device: {
        sessions: [session({ states: ["working"], records: 1 })],
        current: true,
      },
    },
    [report],
  ).get("device/workspace")!;
  expect(badgeCounts(status)).toEqual({ error: 0, blocked: 0, done: 0, working: 1 });
});

test("one unavailable recorder does not make a healthy terminal's status previous", () => {
  const status = workspaceStatuses(
    [device],
    {
      device: {
        sessions: [
          session({ states: ["blocked"], records: 1 }, { webStatus: "unavailable" }),
          session({ states: ["working"], records: 1 }, { id: "healthy" }),
        ],
        current: true,
      },
    },
    [report],
  ).get("device/workspace")!;
  expect(status).toMatchObject({ stale: true, offline: false });
  expect(status.terminals).toMatchObject([
    { sessionId: "terminal", current: false, report },
    { sessionId: "healthy", current: true },
  ]);
  expect(badgeCounts(status)).toEqual({ error: 0, blocked: 1, done: 0, working: 1 });
});

test("an offline device retains summaries and historical reports as previous observations", () => {
  const status = workspaceStatuses(
    [{ ...device, status: "offline" }],
    { device: { sessions: [session({ states: ["working"], records: 1 })], current: true } },
    [report],
  ).get("device/workspace")!;
  expect(status).toMatchObject({ stale: true, offline: true });
  expect(status.terminals).toMatchObject([
    { current: false, summary: { states: ["working"], records: 1 }, report },
  ]);
});
