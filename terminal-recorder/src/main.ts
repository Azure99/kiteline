import { appVersion, asError, errorReply, AppError } from "@kiteline/shared/protocol";
import type { RecorderConfig, RecorderMessage, RecorderRequest } from "@kiteline/shared/ipc";
import { JsonWriter, readLines } from "@kiteline/shared/stdio";
import { RecordedSession } from "./session.js";

async function main() {
  if (process.argv.includes("--version")) {
    console.log(appVersion);
    return;
  }
  if (process.argv[2] !== "--agent" || !process.argv[3])
    throw new Error("The terminal recorder is started by kiteline-agent.");
  const config = JSON.parse(process.argv[3]) as RecorderConfig;
  const writer = new JsonWriter(process.stdout);
  const sessions = new Map<string, RecordedSession>();
  let closing = false;
  function emit(message: RecorderMessage, owner?: string) {
    const accepted = writer.send(message, owner);
    if (!accepted && !owner) void close();
    return accepted;
  }
  async function request(message: RecorderRequest) {
    if (closing) return;
    try {
      let result: unknown;
      if (message.type === "create" || message.type === "recover") {
        const existing = sessions.get(message.sessionId);
        if (existing && message.type === "create")
          throw new AppError("conflict", "Session already exists");
        const session =
          existing ??
          new RecordedSession(message, config, emit, () => {
            if (sessions.get(message.sessionId) === session) sessions.delete(message.sessionId);
          });
        sessions.set(message.sessionId, session);
        try {
          result = await session.start();
        } catch (error) {
          session.fault(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      } else {
        const session = sessions.get(message.sessionId);
        if (!session) {
          if (message.type === "detach" || message.type === "consumed") return;
          throw new AppError("recording_unavailable", "终端记录不可用");
        }
        switch (message.type) {
          case "attach":
            await session.attach(
              message.attachmentId,
              message.terminalProfile,
              message.history,
              message.historyGap,
            );
            result = {};
            break;
          case "end":
            await session.end();
            result = {};
            break;
          case "redraw":
            await session.input.redraw();
            result = {};
            break;
          case "detach":
            writer.discard(message.attachmentId);
            session.detach(message.attachmentId);
            return;
          case "consumed":
            session.consumed(message.attachmentId, message.bytes);
            return;
          case "input":
            if (session.acceptsInput(message.attachmentId))
              session.input.input(message.attachmentId, Buffer.from(message.dataBase64, "base64"));
            return;
          case "paste":
            if (session.acceptsInput(message.attachmentId))
              session.input.paste(message.attachmentId, message.text);
            return;
          case "resize":
            if (session.acceptsInput(message.attachmentId))
              session.input.resize(message.attachmentId, message.cols, message.rows);
            return;
          default:
            throw new AppError("unsupported", "Unsupported recorder action");
        }
      }
      if ("id" in message)
        emit({ type: "reply", reply: { id: message.id, outcome: "succeeded", result } });
    } catch (error) {
      if ("id" in message) emit({ type: "reply", reply: errorReply(message.id, error) });
      else if ("attachmentId" in message)
        emit({
          type: "frame",
          sessionId: message.sessionId,
          attachmentId: message.attachmentId,
          frame: { type: "input.error", ...asError(error), outcome: "failed" },
        });
    }
  }
  async function close() {
    if (closing) return;
    closing = true;
    await Promise.allSettled([...sessions.values()].map((session) => session.close()));
    writer.close();
    process.stdin.destroy();
  }
  readLines(
    process.stdin,
    (line) => {
      void request(JSON.parse(line.toString()) as RecorderRequest);
    },
    (error) => {
      console.error(error.message);
      void close();
    },
  );
  process.stdin.on("end", () => void close());
  process.stdout.on("error", () => void close());
  process.once("SIGTERM", () => void close());
}
main().catch((error: unknown) => {
  console.error(asError(error).message);
  process.exitCode = 1;
});
