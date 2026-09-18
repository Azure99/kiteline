import { AppError, type TextFormat } from "./index.js";

export function decodeText(bytes: Uint8Array): { text: string; format: TextFormat } {
  if (bytes.includes(0)) throw new AppError("unsupported", "二进制文件不能作为文本编辑");
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AppError("unsupported", "文件不是有效的 UTF-8 文本");
  }
  if (bom) text = text.slice(1);
  let crlf = 0,
    lf = 0,
    cr = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    if (match[0] === "\r\n") crlf++;
    else if (match[0] === "\r") cr++;
    else lf++;
  }
  return {
    text: text.replace(/\r\n?/g, "\n"),
    format: {
      bom,
      lineEnding: crlf > lf + cr ? "crlf" : "lf",
      mixedLineEndings: cr > 0 || (crlf > 0 && lf > 0),
    },
  };
}

export function encodeText(text: string, format: TextFormat): Uint8Array {
  const content = format.lineEnding === "crlf" ? text.replace(/\n/g, "\r\n") : text;
  return new TextEncoder().encode((format.bom ? "\uFEFF" : "") + content);
}
