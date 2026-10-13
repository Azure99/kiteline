import {
  AppError,
  integer,
  limits,
  record,
  string,
  terminalKeys,
  type ScreenOptions,
  type SnapshotOptions,
  type InputPosition,
  type ScreenWait,
  type SessionInput,
} from "@kiteline/shared/protocol";
import type { Sessions } from "./sessions.js";

function boolean(value: unknown, name: string) {
  if (value !== undefined && typeof value !== "boolean")
    throw new AppError("invalid_argument", `Invalid ${name}`);
  return value as boolean | undefined;
}
function text(value: unknown) {
  if (typeof value !== "string")
    throw new AppError("invalid_argument", "Input text must be a string");
  return value;
}
export function terminalRpc(method: string, params: Record<string, unknown>, sessions: Sessions) {
  const sessionId = string(params.sessionId);
  const item = sessions.get(sessionId, string(params.workspaceId));
  if (item.session.webStatus !== "available" || item.ending)
    throw new AppError("recording_unavailable", "Recover terminal recording first");
  if (method === "sessions.send" || method === "sessions.resize") {
    const deadline = Date.now() + integer(params.timeoutMs ?? 5000, "timeoutMs", 1, 10000);
    if (method === "sessions.resize")
      return sessions.recorder.request({
        type: "session.resize",
        sessionId,
        deadline,
        cols: integer(params.cols, "cols", 1, limits.terminalMaxCols),
        rows: integer(params.rows, "rows", 1, limits.terminalMaxRows),
      });
    const value = record(params.input);
    let input: SessionInput;
    if (value.type === "paste" || value.type === "text")
      input = { type: value.type, text: text(value.text), enter: boolean(value.enter, "enter") };
    else if (
      value.type === "key" &&
      typeof value.key === "string" &&
      terminalKeys.some((key) => key === value.key)
    )
      input = { type: "key", key: value.key as Extract<SessionInput, { type: "key" }>["key"] };
    else
      throw new AppError("invalid_argument", "Input must be text, paste, or a supported named key");
    let ifInput: InputPosition | undefined;
    if (params.ifInput !== undefined) {
      const condition = record(params.ifInput);
      ifInput = {
        epoch: string(condition.epoch, "epoch", 128),
        inputSeq: integer(condition.inputSeq, "inputSeq", 0, Number.MAX_SAFE_INTEGER),
      };
    }
    return sessions.recorder.request({ type: "session.send", sessionId, input, ifInput, deadline });
  }
  const options: ScreenOptions = {
    tail:
      params.tail === undefined
        ? undefined
        : integer(params.tail, "tail", 0, limits.terminalHistoryLines),
    attrs: boolean(params.attrs, "attrs"),
  };
  const historyGap = item.session.historyGap;
  if (method === "sessions.snapshot") {
    const snapshot: SnapshotOptions = options;
    if (params.ifChanged !== undefined) {
      const condition = record(params.ifChanged);
      if (typeof condition.attrs !== "boolean")
        throw new AppError("invalid_argument", "ifChanged.attrs must be a boolean");
      snapshot.ifChanged = {
        epoch: string(condition.epoch, "epoch", 128),
        seq: integer(condition.seq, "seq", 0, Number.MAX_SAFE_INTEGER),
        tail:
          condition.tail === null
            ? null
            : integer(condition.tail, "ifChanged.tail", 0, limits.terminalHistoryLines),
        attrs: condition.attrs,
      };
    }
    return sessions.recorder.request({
      type: "snapshot",
      sessionId,
      options: snapshot,
      historyGap,
    });
  }
  const timeoutMs = integer(params.timeoutMs ?? 1000, "timeoutMs", 1, 10000);
  const mode = params.mode === undefined ? "quiet" : params.mode;
  let wait: ScreenWait;
  if (mode === "quiet")
    wait = {
      ...options,
      mode: "quiet",
      quietMs: integer(params.quietMs ?? 300, "quietMs", 1, 10000),
    };
  else if (mode === "change") {
    const after = record(params.after);
    wait = {
      ...options,
      mode: "change",
      after: {
        epoch: string(after.epoch, "epoch", 128),
        seq: integer(after.seq, "seq", 0, Number.MAX_SAFE_INTEGER),
      },
    };
  } else throw new AppError("invalid_argument", "Wait mode must be quiet or change");
  return sessions.recorder.request({
    type: "wait",
    sessionId,
    options: wait,
    historyGap,
    deadline: Date.now() + timeoutMs,
  });
}
