import type { TerminalNotice } from "@kiteline/shared/protocol";

export function terminalNotice(code: number, body: string): TerminalNotice | undefined {
  if (code === 9) {
    if (body === "4" || body.startsWith("4;")) return;
    return { title: "", body, blocked: false };
  }
  if (code === 777 && body.startsWith("notify;")) {
    const separator = body.indexOf(";", 7);
    if (separator === -1) return;
    return { title: body.slice(7, separator), body: body.slice(separator + 1), blocked: false };
  }
}
