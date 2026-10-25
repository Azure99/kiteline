import { WebSocket, type RawData } from "ws";
import { AppError, limits } from "./index.js";

interface FileFrame {
  data: Buffer;
  binary: boolean;
}

export function sendFileFrame(socket: WebSocket, data: Buffer | string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (socket.readyState !== WebSocket.OPEN)
    return Promise.reject(new AppError("offline", "File channel closed"));
  if (
    Buffer.byteLength(data) >
    (typeof data === "string" ? limits.controlMessageBytes : limits.dataChunkBytes)
  )
    return Promise.reject(new AppError("limit_exceeded", "File data frame exceeds the size limit"));
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.send(data, { binary: Buffer.isBuffer(data) }, (error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    });
  });
}

// pause can leave already parsed messages. Keep them in one bounded, ordered pump.
export function consumeFileFrames(
  socket: WebSocket,
  handle: (frame: FileFrame) => Promise<void>,
  fail: (error: unknown) => void,
  signal: AbortSignal,
) {
  const queue: FileFrame[] = [];
  let bytes = 0;
  let count = 0;
  let pumping: Promise<void> | undefined;
  const message = (raw: RawData, binary: boolean) => {
    if (signal.aborted) return;
    const data = Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw);
    if (
      data.length > (binary ? limits.dataChunkBytes : limits.controlMessageBytes) ||
      bytes + data.length > limits.filePendingBytes ||
      count >= limits.filePendingFrames
    ) {
      fail(new AppError("limit_exceeded", "File receive queue exceeds its capacity"));
      return;
    }
    socket.pause();
    queue.push({ data, binary });
    bytes += data.length;
    count++;
    if (!pumping) pumping = pump();
  };
  async function pump() {
    try {
      while (queue.length && !signal.aborted) {
        const frame = queue.shift()!;
        await handle(frame);
        bytes -= frame.data.length;
        count--;
      }
    } catch (error) {
      fail(error);
    } finally {
      pumping = undefined;
      if (!signal.aborted && socket.readyState === WebSocket.OPEN) socket.resume();
    }
  }
  socket.on("message", message);
  return {
    drain: async () => {
      await pumping;
    },
    close: async () => {
      socket.off("message", message);
      queue.length = 0;
      await pumping;
    },
  };
}
