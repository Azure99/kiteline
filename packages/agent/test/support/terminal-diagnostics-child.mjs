import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "../../dist/agent.js";
import { defaultAgentLimits } from "../../dist/config.js";

const dataDir = process.argv[2];
const runDir = join(dataDir, "run");
await mkdir(runDir);
const agent = new Agent(
  { dataDir, runDir, shell: "/bin/bash", limits: { ...defaultAgentLimits } },
  { deviceId: "diagnostics-test", deviceToken: "local", server: "https://localhost" },
);
let closing;
function close() {
  return (closing ??= agent.close().finally(() => {
    if (process.connected) process.disconnect();
  }));
}
process.on("disconnect", () => {
  void close().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});

try {
  const workspace = await agent.metadata.add(dataDir);
  if (process.argv[3] === "preload") {
    const nodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require=${join(dataDir, "recorder-preload.cjs")}`;
    try {
      const result = await agent.sessions.create(
        { workspaceId: workspace.id },
        new AbortController().signal,
      );
      process.send({ id: "create", result });
    } catch (error) {
      process.send({
        id: "create",
        error: { code: error.code, message: error.message, outcome: error.outcome },
      });
    } finally {
      if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = nodeOptions;
      await close();
    }
  } else {
    const session = await agent.sessions.create(
      { workspaceId: workspace.id },
      new AbortController().signal,
    );
    process.on("message", (message) => {
      if (message.type === "close") {
        void close().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
        return;
      }
      const request =
        message.type === "pending-end"
          ? agent.sessions.recorder.request({ type: "end", sessionId: session.id })
          : agent.dispatch(
              "sessions.send",
              {
                workspaceId: workspace.id,
                sessionId: session.id,
                input: { type: "text", text: message.text, enter: true },
                timeoutMs: message.timeoutMs,
              },
              new AbortController().signal,
            );
      let settled = false;
      void request.then(
        (result) => {
          settled = true;
          process.send({ id: message.id, result });
        },
        (error) => {
          settled = true;
          process.send({
            id: message.id,
            error: { code: error.code, message: error.message, outcome: error.outcome },
          });
        },
      );
      if (message.type === "pending-end") {
        // This recorder is ready; request() reaches call/write before the next check phase.
        setImmediate(() => {
          if (!settled) process.send({ id: message.id, pending: true });
        });
      }
    });
    process.send({
      id: "ready",
      socket: join(runDir, session.id, "tmux.sock"),
      recorderPid: agent.sessions.recorder.pid,
    });
  }
} catch (error) {
  await close();
  throw error;
}
