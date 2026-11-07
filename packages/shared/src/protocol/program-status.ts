const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const states = ["idle", "working", "done", "blocked", "error"] as const;

export type ProgramState = (typeof states)[number];
export type ProgramStatusKind = "permission" | "question" | "auth";
export interface ProgramStatusRecord {
  id: string;
  state: ProgramState;
  kind?: ProgramStatusKind;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}
export type ProgramStatusReport = ProgramStatusRecord | { id: string; state: "clear" };
export interface ProgramStatusSummary {
  states: ProgramState[];
  records: number;
}

function decodeText(value: string, encodedLimit: number, decodedLimit: number) {
  if (
    value.length > encodedLimit ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?|)?$/.test(value)
  ) {
    return;
  }
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (bytes.length > decodedLimit) return;
    const text = decoder.decode(bytes);
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return;
    }
    return text;
  } catch {
    return;
  }
}

/** Program Status Protocol rev 0.4. Invalid reports never partially change records. */
export function parseProgramStatus(body: string): ProgramStatusReport | undefined {
  // Include the longer ST terminator in the receive limit.
  if (encoder.encode(body).length + 9 > 4096) return;
  const fields = new Map<string, string>();
  for (const pair of body.split(":")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (encoder.encode(key).length > 16) return;
    if (
      key === "id" &&
      (!/^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32})*$/.test(value) ||
        value.length > 128 ||
        value.split("/").length > 8)
    ) {
      return;
    }
    if (!/^[a-z]+$/.test(key) || !/^[A-Za-z0-9_.,+/=-]*$/.test(value)) continue;
    if (key === "app" && value.length > 32) return;
    if (key === "msg" || key === "title") {
      const text = decodeText(value, key === "msg" ? 2732 : 256, key === "msg" ? 2048 : 192);
      if (text === undefined) return;
      fields.set(key, text);
    } else {
      fields.set(key, value);
    }
  }

  const state = fields.get("state");
  const id = fields.get("id") ?? "";
  if (state === "clear") return { id, state };
  if (!states.includes(state as ProgramState)) return;

  const report: ProgramStatusRecord = { id, state: state as ProgramState };
  const app = fields.get("app");
  if (app && /^[A-Za-z0-9_.+-]{1,32}$/.test(app)) report.app = app;
  for (const key of ["title", "msg"] as const) {
    const text = fields.get(key);
    if (text !== undefined) report[key] = text;
  }
  const kind = fields.get("kind");
  if (state === "blocked" && (kind === "permission" || kind === "question" || kind === "auth")) {
    report.kind = kind;
  }
  const progress = fields.get("progress");
  if (
    (state === "working" || state === "blocked") &&
    progress !== undefined &&
    /^\d+$/.test(progress) &&
    Number(progress) <= 100
  ) {
    report.progress = Number(progress);
  }
  return report;
}

export function programStatusApp(record: ProgramStatusRecord, records: ProgramStatusRecord[]) {
  let id = record.id;
  for (;;) {
    const app = records.find((candidate) => candidate.id === id)?.app;
    if (app) return app;
    if (!id) return;
    const slash = id.lastIndexOf("/");
    id = slash < 0 ? "" : id.slice(0, slash);
  }
}

export class ProgramStatusStore {
  private records = new Map<string, ProgramStatusRecord>();

  snapshot() {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  summary(): ProgramStatusSummary {
    return summarizeProgramStatus([...this.records.values()]);
  }

  apply(report: ProgramStatusReport) {
    if (report.state === "clear") {
      if (!report.id) {
        this.records.clear();
      } else {
        for (const id of this.records.keys()) {
          if (id === report.id || id.startsWith(`${report.id}/`)) this.records.delete(id);
        }
      }
      return;
    }
    // New records, state changes and changed kind/title/msg on blocked/done/error move to the
    // end. Repeats, working progress and idle text keep their place.
    const previous = this.records.get(report.id);
    if (
      !previous ||
      previous.state !== report.state ||
      ((report.state === "blocked" || report.state === "done" || report.state === "error") &&
        (previous.kind !== report.kind ||
          previous.title !== report.title ||
          previous.msg !== report.msg))
    ) {
      this.records.delete(report.id);
      if (this.records.size >= 256) this.records.delete(this.records.keys().next().value!);
    }
    this.records.set(report.id, { ...report });
  }

  promptOrExit() {
    for (const [id, record] of this.records) {
      if (record.state === "working" || record.state === "blocked") this.records.delete(id);
    }
  }

  reset() {
    this.records.clear();
  }
}

/** States newest appearance first, so a change in which state leads changes the summary. */
export function summarizeProgramStatus(records: ProgramStatusRecord[]): ProgramStatusSummary {
  const appeared: ProgramState[] = [];
  for (const record of [...records].reverse())
    if (!appeared.includes(record.state)) appeared.push(record.state);
  return { states: appeared, records: records.length };
}
