import { programStatusApp, type ProgramStatusRecord } from "@kiteline/shared/protocol";
import type { ReceivedReport } from "../terminal/reports";
import { isOpen, leadState, type TerminalStatus } from "./workspace-status";

type State = ProgramStatusRecord["state"];

export type StatusEntry =
  | { type: "program"; record: ProgramStatusRecord; app?: string; report?: ReceivedReport }
  | { type: "summary"; states: State[] }
  | { type: "report"; report: ReceivedReport };

/**
 * One terminal's sections, lead first: open waits and errors, then the rest, each newest first.
 * Equal state and message pairs share one display entry. A matching notification adds its
 * receipt label to the first matching entry; neither merge establishes a source relationship.
 * The list and its +x count use these same entries.
 */
export function statusEntries(
  terminal: TerminalStatus,
  records: ProgramStatusRecord[] | undefined,
) {
  const entries: StatusEntry[] = [];
  if (records) {
    const root = records.find((record) => !record.id);
    const ordered = [...records].reverse().filter((record) => record.state !== "idle");
    ordered.sort((a, b) => Number(isOpen(b.state)) - Number(isOpen(a.state)));
    const seen = new Set<string>();
    for (const record of ordered) {
      const key = JSON.stringify([record.state, record.msg ?? ""]);
      if (seen.has(key)) continue;
      seen.add(key);
      const app = programStatusApp(record, records);
      entries.push({ type: "program", record, app: app !== root?.app ? app : undefined });
    }
  } else {
    const states = (terminal.summary?.states ?? []).filter((state) => state !== "idle");
    const state = leadState(states);
    if (state)
      entries.push({ type: "summary", states: [state, ...states.filter((s) => s !== state)] });
  }
  const report = terminal.report;
  if (report) {
    const matching = report.notice.body
      ? entries.find((entry) => entry.type === "program" && entry.record.msg === report.notice.body)
      : undefined;
    if (matching?.type === "program") matching.report = report;
    else entries.push({ type: "report", report });
  }
  const idle = records
    ? records.some((record) => record.state === "idle")
    : terminal.summary?.states.includes("idle");
  if (!entries.length && idle) entries.push({ type: "summary", states: ["idle"] });
  const lead = entries[0];
  const text =
    lead?.type === "program"
      ? lead.record.msg
      : lead?.type === "report"
        ? lead.report.notice.body
        : undefined;
  let preview: { text: string; notification?: ReceivedReport } | undefined = text
    ? { text }
    : undefined;
  if (
    !preview &&
    lead?.type === "program" &&
    lead.record.state === "done" &&
    report?.notice.body &&
    !report.notice.blocked
  ) {
    preview = { text: report.notice.body, notification: report };
  }
  return { entries, lead, preview, more: Math.max(0, entries.length - 1) };
}

/** The state a section shows; "notice" for a notification on its own. */
export function entryState(entry: StatusEntry | undefined) {
  if (entry?.type === "program") return entry.record.state;
  return entry?.type === "summary" ? (leadState(entry.states) ?? "idle") : "notice";
}
