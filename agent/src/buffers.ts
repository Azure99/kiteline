export class BytePrefix {
  private buffer: Buffer;
  private length = 0;
  truncated = false;
  constructor(size: number) {
    this.buffer = Buffer.alloc(size);
  }
  append(bytes: Buffer) {
    const length = Math.min(bytes.length, this.buffer.length - this.length);
    bytes.copy(this.buffer, this.length, 0, length);
    this.length += length;
    if (length < bytes.length) this.truncated = true;
  }
  get bytes() {
    return this.buffer.subarray(0, this.length);
  }
  text() {
    return new TextDecoder().decode(this.bytes, { stream: this.truncated });
  }
}
