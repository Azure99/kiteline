import { isUtf8 } from "node:buffer";
import { sep } from "node:path";
import type { Token } from "stream-json/parser.js";
import { limits, type SearchMatch } from "@kiteline/shared/protocol";
import { BytePrefix } from "../buffers.js";

interface MatchRecord {
  type: string;
  path: BytePrefix;
  line: number;
  text: BytePrefix;
  ranges: { start?: number; end?: number }[];
  truncated: boolean;
}

// Project rg's token stream directly; line bodies and submatch text are never assembled.
export class SearchJson {
  private stack: { path: string; key: string; array: boolean }[] = [];
  private current?: MatchRecord;
  private field = "";
  private scalar = "";
  private carry = "";
  private range?: { start?: number; end?: number };
  constructor(
    private found: (match: SearchMatch) => void | Promise<void>,
    private skipped: () => void,
  ) {}
  private path() {
    const parent = this.stack.at(-1);
    return parent ? [parent.path, parent.key].filter(Boolean).join(".") : "";
  }
  token(token: Token) {
    if (token.name === "startObject" || token.name === "startArray") {
      const path = this.path();
      if (!this.stack.length)
        this.current = {
          type: "",
          path: new BytePrefix(limits.searchPathBytes),
          line: 0,
          text: new BytePrefix(limits.searchLineBytes),
          ranges: [],
          truncated: false,
        };
      const parent = this.stack.at(-1);
      if (token.name === "startObject" && parent?.array && parent.path === "data.submatches") {
        this.range = this.current!.ranges.length < limits.searchRanges ? {} : undefined;
        if (this.range) this.current!.ranges.push(this.range);
        else this.current!.truncated = true;
      }
      this.stack.push({ path, key: "", array: token.name === "startArray" });
    } else if (token.name === "keyValue") this.stack.at(-1)!.key = token.value;
    else if (token.name === "startString" || token.name === "startNumber") {
      this.field = this.path();
      this.scalar = "";
      this.carry = "";
    } else if (token.name === "stringChunk" || token.name === "numberChunk") {
      this.chunk(token.value);
    } else if (token.name === "endString" || token.name === "endNumber") {
      this.finishScalar();
    } else if (token.name === "endObject" || token.name === "endArray") {
      this.stack.pop();
      if (!this.stack.length) return this.finishRecord();
    }
  }
  private chunk(value: string) {
    const output = this.field.startsWith("data.lines.")
      ? this.current!.text
      : this.field.startsWith("data.path.")
        ? this.current!.path
        : undefined;
    if (output && this.field.endsWith(".bytes")) {
      const encoded = this.carry + value;
      const end = encoded.length - (encoded.length % 4);
      output.append(Buffer.from(encoded.slice(0, end), "base64"));
      this.carry = encoded.slice(end);
    } else if (output && this.field.endsWith(".text")) {
      let text = this.carry + value;
      this.carry = "";
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        this.carry = text.slice(-1);
        text = text.slice(0, -1);
      }
      output.append(Buffer.from(text));
    } else if (
      ["type", "data.line_number", "data.submatches.start", "data.submatches.end"].includes(
        this.field,
      )
    )
      this.scalar = (this.scalar + value).slice(0, 32);
  }
  private finishScalar() {
    const item = this.current!;
    const output = this.field.startsWith("data.lines.")
      ? item.text
      : this.field.startsWith("data.path.")
        ? item.path
        : undefined;
    if (output && this.carry)
      output.append(Buffer.from(this.carry, this.field.endsWith(".bytes") ? "base64" : "utf8"));
    if (this.field === "type") item.type = this.scalar;
    else if (this.field === "data.line_number") item.line = Number(this.scalar);
    else if (this.field === "data.submatches.start" && this.range)
      this.range.start = Number(this.scalar);
    else if (this.field === "data.submatches.end" && this.range)
      this.range.end = Number(this.scalar);
    this.carry = "";
  }
  private finishRecord() {
    const item = this.current!;
    if (item.type !== "match") return;
    if (item.path.truncated || !isUtf8(item.path.bytes)) {
      this.skipped();
      return;
    }
    const path = item.path.bytes.toString().replaceAll(sep, "/").replace(/^\.\//, "");
    const text = item.text.text().replace(/\r?\n$/, "");
    const prefixLength = (end: number) =>
      Math.min(text.length, new TextDecoder().decode(item.text.bytes.subarray(0, end)).length);
    const ranges: [number, number][] = item.ranges.flatMap(({ start, end }) =>
      start !== undefined &&
      end !== undefined &&
      start >= 0 &&
      end >= start &&
      end <= item.text.bytes.length
        ? [[prefixLength(start), prefixLength(end)]]
        : [],
    );
    return this.found({
      path,
      line: item.line,
      text,
      ranges,
      truncated: item.text.truncated || item.truncated,
    });
  }
}
