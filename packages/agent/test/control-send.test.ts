import { afterEach, expect, test, vi } from "vitest";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { AppError, limits, type AgentControlMessage } from "@kiteline/shared/protocol";
import { Agent } from "../src/agent.js";
import { privateDirectory } from "../src/config.js";
import { testConfig } from "./support/config.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp("/var/tmp/kiteline-control-send-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanups.push(async () => {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const messages: AgentControlMessage[] = [];
  const connected = new Promise<WebSocket>((resolve) => {
    server.once("connection", (peer) => {
      peer.on("message", (data) => messages.push(JSON.parse(data.toString())));
      resolve(peer);
    });
  });
  const agent = new Agent(testConfig(root), {
    deviceId: "control-send",
    deviceToken: "control-send",
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  cleanups.push(() => agent.close());
  for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
  await agent.start();
  const peer = await connected;
  await expect.poll(() => messages.some((message) => message.type === "hello")).toBe(true);
  const request = (id: string) =>
    peer.send(JSON.stringify({ type: "rpc.request", id, method: "sessions.list", params: {} }));
  const replies = () => messages.filter((message) => message.type === "rpc.result");
  return { agent, peer, messages, request, replies };
}

test("control encoding and socket exceptions remain visible and release the request ID", async () => {
  const { agent, request, replies } = await fixture();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const dispatch = vi.spyOn(agent, "dispatch");
  for (const source of ["JSON", "WebSocket"]) {
    const id = `${source}-failure`;
    const failure = new AppError("limit_exceeded", `${source} failed unexpectedly`);
    const encode = vi.fn(() => {
      throw failure;
    });
    if (source === "JSON") dispatch.mockResolvedValueOnce({ toJSON: encode });
    else dispatch.mockResolvedValueOnce({ sent: false });
    const send = vi.spyOn(agent.socket!, "send");
    if (source === "WebSocket")
      send.mockImplementationOnce(() => {
        throw failure;
      });
    request(id);
    await expect.poll(() => logged.mock.calls).toContainEqual([failure.message]);
    expect(replies().filter((message) => message.reply.id === id)).toEqual([]);
    if (source === "JSON") expect(send).not.toHaveBeenCalled();
    send.mockRestore();

    dispatch.mockResolvedValueOnce({ recovered: source });
    request(id);
    await expect
      .poll(() => replies().filter((message) => message.reply.id === id))
      .toEqual([
        { type: "rpc.result", reply: { id, outcome: "succeeded", result: { recovered: source } } },
      ]);
  }
});

test("oversized progress is diagnosed before writability and backpressure still closes the peer", async () => {
  const { agent, peer, messages, request, replies } = await fixture();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const buffered = vi
    .spyOn(agent.socket!, "bufferedAmount", "get")
    .mockReturnValue(limits.controlMessageBytes * 2 + 1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(agent, "dispatch").mockImplementationOnce(
    async (_method, _params, _signal, progress) => {
      // This controlled payload exercises the event transport limit, not path admission.
      progress!({ phase: "running", currentPath: "x".repeat(limits.controlMessageBytes) });
      await gate;
      return { completed: true };
    },
  );
  const closed = once(peer, "close");
  try {
    request("progress-budget");
    await expect
      .poll(() => logged.mock.calls)
      .toContainEqual(["Control message dropped (request.progress): size limit exceeded"]);
    expect(messages.some((message) => message.type === "request.progress")).toBe(false);
    expect(peer.readyState).toBe(WebSocket.OPEN);
    release();
    const [code, reason] = (await closed) as [number, Buffer];
    expect(code).toBe(1013);
    expect(reason.toString()).toBe("control_backpressure");
    expect(replies()).toEqual([]);
    buffered.mockRestore();
    logged.mockClear();
    // A normal metadata notification while disconnected stays silent and does not undo commit.
    await expect(agent.metadata.updateSettings(1234)).resolves.toEqual({ historyLines: 1234 });
    expect(logged).not.toHaveBeenCalled();
  } finally {
    release();
  }
});
