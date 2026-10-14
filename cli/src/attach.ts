import { write } from "node:fs";
import { AppError, asError, limits, record, type ChannelReady } from "@kiteline/shared/protocol";
import { ApiError, versionedPath } from "@kiteline/shared/protocol/client";
import { heartbeat, sendFrame } from "@kiteline/shared/protocol/ws";
import type { TtyInput } from "@kiteline/shared/protocol/ipc";
import { connectServerSocket } from "@kiteline/shared/node/network";
import { target, type Credentials } from "./config.js";
import { client, remote } from "./client.js";
import type { Options } from "./options.js";

// Cancel a partial control string before restoring modes after a broken connection.
const reset = Buffer.from(
  "\x18\x1b\\\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>\x1b[0m\x1b[?25h\x1b[?1049l",
);

async function output(fd: number, data: Buffer) {
  for (let offset = 0; offset < data.length; ) {
    offset += await new Promise<number>((resolve, reject) => {
      write(fd, data, offset, data.length - offset, null, (error, bytes) => {
        if (error) reject(error);
        else if (!bytes) reject(new Error("Terminal output made no progress"));
        else resolve(bytes);
      });
    });
  }
}

function dimensions() {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

export async function attach(
  options: Options,
  api: ReturnType<typeof client>,
  credentials: Credentials,
) {
  const { deviceId, workspaceId, sessionId } = await target(options, true);
  const ready = await remote(
    api.post<ChannelReady>(
      `/api/devices/${encodeURIComponent(deviceId)}/channels`,
      {
        kind: "terminal.attach",
        params: {
          mode: "tty",
          workspaceId,
          sessionId,
          ...dimensions(),
          term: process.env.TERM || "xterm-256color",
        },
      },
      undefined,
      false,
    ),
  );
  const url = new URL(
    versionedPath(`/api/channels/${encodeURIComponent(ready.channelId)}/terminal`),
    credentials.server,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = connectServerSocket(url, {
    headers: { origin: credentials.server, authorization: `Bearer ${credentials.token}` },
    maxPayload: limits.controlMessageBytes,
    handshakeTimeout: limits.interactionTimeout,
  });
  await new Promise<void>((resolve) => {
    let queue = Promise.resolve();
    let consumed = 0;
    let finishing = false;
    let raw = false;

    function finish(error?: unknown) {
      if (finishing) return;
      finishing = true;
      socket.terminate();
      // Default SIGINT restores POSIX termios even when fs.write or TCSADRAIN is blocked.
      const deadline = setTimeout(() => process.kill(process.pid, "SIGINT"), 1000);
      void (async () => {
        try {
          await queue;
        } catch (failure) {
          error = failure;
        }
        try {
          if (error) {
            if (raw) await output(1, reset);
            const failure = error instanceof ApiError ? error : asError(error);
            await output(2, Buffer.from(`failed [${failure.code}] ${failure.message}\r\n`));
          }
          if (raw) process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", input);
          process.stdin.off("error", failed);
          process.stdin.off("end", inputClosed);
          process.stdout.off("resize", resize);
          process.off("SIGTERM", interrupted);
          clearTimeout(deadline);
          process.exitCode = error ? (error instanceof ApiError ? 1 : 2) : 0;
          resolve();
        } catch {
          // Leave the deadline active if output or native terminal restoration failed.
        }
      })();
    }

    function send(data: Buffer | TtyInput) {
      if (finishing) return;
      try {
        sendFrame(socket, Buffer.isBuffer(data) ? data : JSON.stringify(data));
      } catch (error) {
        finish(new ApiError("io_error", asError(error).message));
      }
    }
    function input(data: Buffer) {
      for (let offset = 0; offset < data.length; offset += limits.dataChunkBytes)
        send(data.subarray(offset, offset + limits.dataChunkBytes));
    }
    function resize() {
      send({ type: "resize", ...dimensions() });
    }
    function failed(error: Error) {
      finish(error);
    }
    function inputClosed() {
      finish(new AppError("io_error", "Local terminal input closed"));
    }
    function interrupted() {
      finish(new AppError("cancelled", "Attach interrupted"));
    }

    socket.on("message", (data, binary) => {
      if (finishing) return;
      try {
        if (binary) {
          const bytes = Buffer.from(data as Buffer);
          queue = queue.then(async () => {
            await output(1, bytes);
            consumed += bytes.length;
            send({ type: "consumed", bytes: consumed });
          });
          void queue.catch(failed);
          return;
        }
        const message = record(JSON.parse(data.toString()));
        if (message.type === "ended")
          finish(
            message.exitCode === 0
              ? undefined
              : new ApiError("command_failed", `Terminal client exited ${message.exitCode}`),
          );
        else if (message.type === "error")
          finish(new ApiError(String(message.code), String(message.message)));
        else throw new ApiError("invalid_argument", "Unexpected terminal frame");
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(new ApiError("io_error", error.message)));
    socket.on("close", () => finish(new ApiError("offline", "Terminal connection closed")));
    process.stdin.on("error", failed);
    process.stdin.on("end", inputClosed);
    process.on("SIGTERM", interrupted);
    socket.once("open", () => {
      heartbeat(socket);
      try {
        process.stdin.setRawMode(true);
        raw = true;
        process.stdin.on("data", input);
        process.stdout.on("resize", resize);
      } catch (error) {
        finish(error);
      }
    });
  });
}
