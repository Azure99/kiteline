import { Duplex, Writable } from "node:stream";
import { createWebSocketStream, type WebSocket } from "ws";
import { AppError, limits } from "./index.js";

export function httpStream(socket: WebSocket, failed: (error: Error) => void): Duplex {
  function fail(error: Error) {
    failed(error);
    source.destroy(error);
  }
  // Classify frames and EOF before ws can expose them to the HTTP parser.
  socket.prependListener("message", (_data, binary) => {
    if (!binary) fail(new AppError("io_error", "HTTP 数据通道收到文本帧"));
  });
  socket.prependListener("close", (code: number) => {
    if (code !== 1000 && code !== 1005)
      fail(new AppError("io_error", `HTTP 数据连接异常关闭 (${code})`));
  });
  const source = createWebSocketStream(socket, { highWaterMark: limits.dataChunkBytes });
  source.on("error", failed);
  const sink = new Writable({
    highWaterMark: limits.dataChunkBytes,
    write(chunk: Buffer, _encoding, callback) {
      let offset = 0;
      function next(error?: Error | null) {
        if (error || offset === chunk.length) return callback(error);
        const part = chunk.subarray(offset, offset + limits.dataChunkBytes);
        offset += part.length;
        source.write(part, next);
      }
      next();
    },
    final(callback) {
      source.end(callback);
    },
    destroy(error, callback) {
      source.destroy(error ?? undefined);
      callback(error);
    },
  });
  const stream = Duplex.from({ readable: source, writable: sink });
  stream.on("error", failed);
  return stream;
}
