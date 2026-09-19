import { WebSocket } from "ws";
import { AppError, limits } from "./index.js";

export function heartbeat(socket: WebSocket) {
  let lastPong = Date.now();
  socket.on("pong", () => {
    lastPong = Date.now();
  });
  const timer = setInterval(() => {
    if (Date.now() - lastPong >= limits.heartbeatTimeout) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, limits.heartbeatInterval);
  socket.on("close", () => clearInterval(timer));
  socket.on("error", () => {});
}

export function sendFrame(
  socket: WebSocket,
  data: string | Buffer,
  binary = Buffer.isBuffer(data),
) {
  if (socket.readyState !== WebSocket.OPEN)
    throw new AppError("cancelled", "Data connection closed");
  const bytes = Buffer.byteLength(data);
  if (bytes > (binary ? limits.dataChunkBytes : limits.controlMessageBytes))
    throw new AppError("limit_exceeded", "Data frame exceeds the size limit");
  if (socket.bufferedAmount + bytes > limits.terminalPendingBytes)
    throw new AppError(
      "limit_exceeded",
      "Display transmission backlog exceeds the limit; reconnect",
    );
  socket.send(data, { binary });
}
