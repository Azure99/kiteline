import { appVersion, asError, errorReply, AppError } from "@kiteline/shared/protocol";
import type { RecorderConfig, RecorderMessage, RecorderRequest } from "@kiteline/shared/ipc";
import { JsonWriter, readLines } from "@kiteline/shared/stdio";
import { RecordedSession } from "./session.js";

interface Creation {
  sessionId: string;
  session?: RecordedSession;
  cancelled: boolean;
  settled: Promise<void>;
  finish: () => void;
}

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
  const creations = new Map<string, Creation>();
  const retiring = new Map<string, Promise<void>>();
  let closing = false;
  function retire(session: RecordedSession) {
    const id = session.options.sessionId;
    if (sessions.get(id) === session) sessions.delete(id);
    const previous = retiring.get(id);
    if (previous) return previous;
    const cleanup = session.close().then(() => {
      for (const [id, owner] of creations) if (owner.session === session) creations.delete(id);
      if (retiring.get(id) === cleanup) retiring.delete(id);
    });
    retiring.set(id, cleanup);
    void cleanup.catch((error: unknown) => {
      console.error(error);
      void close();
    });
    return cleanup;
  }
  function emit(message: RecorderMessage, owner?: string) {
    const accepted = writer.send(message, owner);
    if (!accepted && !owner) void close();
    return accepted;
  }
  async function request(message: RecorderRequest) {
    if (closing) return;
    // Admission precedes every await, including waiting for an older recording to close.
    let creation: Creation | undefined;
    if (message.type === "create") {
      let finish!: () => void;
      creation = {
        sessionId: message.sessionId,
        cancelled: false,
        settled: new Promise<void>((resolve) => (finish = resolve)),
        finish,
      };
      creations.set(message.id, creation);
    }
    try {
      let result: unknown;
      if (message.type === "cancelCreate") {
        const creation = creations.get(message.createId);
        if (creation) {
          if (creation.sessionId !== message.sessionId)
            throw new AppError("conflict", "Creation identity does not match");
          creation.cancelled = true;
          const stopped = creation.session && retire(creation.session);
          await creation.settled;
          await stopped;
        }
        result = {};
      } else if (message.type === "create" || message.type === "recover") {
        await retiring.get(message.sessionId);
        if (closing || creation?.cancelled)
          throw new AppError("cancelled", "Terminal creation interrupted");
        const existing = sessions.get(message.sessionId);
        if (existing && message.type === "create")
          throw new AppError("conflict", "Session already exists");
        const session =
          existing ??
          new RecordedSession(message, config, emit, () => {
            void retire(session);
          });
        sessions.set(message.sessionId, session);
        if (creation) creation.session = session;
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
          throw new AppError("recording_unavailable", "Terminal recording is unavailable");
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
    } finally {
      if (creation && message.type === "create") {
        creation.finish();
        if (!creation.session) creations.delete(message.id);
      }
    }
  }
  async function close() {
    if (closing) return;
    closing = true;
    for (const creation of creations.values()) creation.cancelled = true;
    const results = await Promise.allSettled(
      [
        ...new Set([
          ...sessions.values(),
          ...[...creations.values()].flatMap((creation) =>
            creation.session ? [creation.session] : [],
          ),
        ]),
      ].map((session) => retire(session)),
    );
    await Promise.all([...creations.values()].map((creation) => creation.settled));
    const cleanup = await Promise.allSettled([...retiring.values()]);
    for (const result of [...results, ...cleanup]) {
      if (result.status === "rejected") {
        console.error(result.reason);
        process.exitCode = 1;
      }
    }
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
