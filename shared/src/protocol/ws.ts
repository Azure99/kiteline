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
  if (socket.readyState !== WebSocket.OPEN) throw new AppError("cancelled", "数据连接已关闭");
  const bytes = Buffer.byteLength(data);
  if (bytes > (binary ? limits.dataChunkBytes : limits.controlMessageBytes))
    throw new AppError("limit_exceeded", "数据帧超过容量");
  if (socket.bufferedAmount + bytes > limits.terminalPendingBytes)
    throw new AppError("limit_exceeded", "当前显示传输积压，请重新连接");
  socket.send(data, { binary });
}
