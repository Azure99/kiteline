import type {
  ScreenLine,
  Session,
  SnapshotResult,
  TerminalScreen,
} from "@kiteline/shared/protocol";
import type { Options } from "./options.js";

export function result(value: unknown, text: string, options: Options) {
  process.stdout.write(
    options.json ? JSON.stringify({ outcome: "succeeded", result: value }) + "\n" : text + "\n",
  );
}

export function sessionLines(sessions: Session[]) {
  return sessions.length
    ? sessions
        .map(
          (s) =>
            `${s.id}  ${s.name}  ${s.state}  ${s.webStatus}${s.historyGap ? "  historyGap" : ""}${s.webReason ? `  ${s.webReason}` : ""}`,
        )
        .join("\n")
    : "No terminals.";
}

function textLines(lines: ScreenLine[]) {
  let end = lines.length;
  while (end && lines[end - 1]!.text === "") end--;
  return lines.slice(0, end).map((line) => line.text);
}

export function screenResult(
  value: SnapshotResult | { reason: string; snapshot: TerminalScreen },
  options: Options,
) {
  if (options.json) return result(value, "", options);
  const snapshot = "snapshot" in value ? value.snapshot : value;
  const metadata: string[] = [
    `reason=${value.reason}`,
    `position=${JSON.stringify(snapshot.position)}`,
    `input=${snapshot.input.epoch}:${snapshot.input.inputSeq}`,
  ];
  if ("screen" in snapshot) {
    const screen = snapshot;
    const tailCount = screen.tail?.lines.length ?? 0;
    const lines = textLines([...(screen.tail?.lines ?? []), ...screen.screen]);
    if (lines.length) process.stdout.write(lines.join("\n") + "\n");
    metadata.push(
      `dims=${screen.cols}x${screen.rows}`,
      `cursor=${screen.cursor.x},${screen.cursor.y} visible=${screen.cursor.visible}`,
      `active=${screen.active}`,
      `historyGap=${screen.historyGap}`,
      `synchronizedOutput=${screen.synchronizedOutput}`,
      `screen=${screen.screen.length} printed=${Math.max(0, lines.length - tailCount)}`,
    );
    if (screen.tail)
      metadata.push(
        `tail=${tailCount} printed=${Math.min(tailCount, lines.length)} omitted=${screen.tail.omitted}`,
      );
    for (const [part, partLines] of [
      ["tail", screen.tail?.lines],
      ["screen", screen.screen],
    ] as const) {
      if (!partLines) continue;
      metadata.push(
        `${part}.wrapped=${JSON.stringify(partLines.flatMap((line, i) => (line.wrapped ? [i] : [])))}`,
      );
      if (screen.position.attrs)
        metadata.push(
          `${part}.attrs=${JSON.stringify(partLines.flatMap((line, i) => (line.attrs?.length ? [{ line: i, attrs: line.attrs }] : [])))}`,
        );
    }
  }
  process.stderr.write(metadata.join("\n") + "\n");
}
