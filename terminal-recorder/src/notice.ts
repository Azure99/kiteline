import type { TerminalNotice } from "@kiteline/shared/protocol";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeText(value: string, encodedLimit: number, decodedLimit: number) {
  if (
    value.length > encodedLimit ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?|)?$/.test(value)
  )
    return undefined;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > decodedLimit) return undefined;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return undefined;
  }
  return text;
}

function blockedReport(body: string): TerminalNotice | undefined {
  // OSC 7501 rev 0.4: include the longer ST terminator in the receive limit.
  if (Buffer.byteLength(body) + 9 > 4096) return;
  let state: string | undefined;
  let title = "";
  let message = "";
  for (const pair of body.split(":")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (Buffer.byteLength(key) > 16) return;
    if (
      key === "id" &&
      (!/^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32})*$/.test(value) ||
        value.length > 128 ||
        value.split("/").length > 8)
    )
      return;
    if (!/^[a-z]+$/.test(key) || !/^[A-Za-z0-9_.,+/=-]*$/.test(value)) continue;
    if (key === "app" && value.length > 32) return;
    if (key === "state") state = value;
    if (key === "msg" || key === "title") {
      const text = decodeText(value, key === "msg" ? 2732 : 256, key === "msg" ? 2048 : 192);
      if (text === undefined) return;
      if (key === "msg") message = text;
      else title = text;
    }
  }
  return state === "blocked" ? { title, body: message, blocked: true } : undefined;
}

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
  if (code === 7501) return blockedReport(body);
}
