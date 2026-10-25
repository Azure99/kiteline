import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type ChannelReady } from "@kiteline/shared/protocol";
import { versionedPath } from "@kiteline/shared/protocol/client";
import { terminalOutputCost } from "@kiteline/shared/protocol/ipc";
import { tmux } from "@kiteline/shared/terminal/node";
import { client } from "../../cli/src/client.js";
import { serverFixture } from "../../server/test/fixture.js";
import { Agent } from "../src/agent.js";
import { TtyBridge } from "../src/terminal/tty.js";
import { testConfig } from "./support/config.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const polling = { timeout: 5000, interval: 20 };

async function fixture() {
  const server = await serverFixture();
  cleanups.push(server.close);
  const root = await mkdtemp("/var/tmp/kiteline-remote-tty-");
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "run"));
  const binding = server.store.newBinding();
  const identity = { ...server.store.bind(binding.code, "TTY test"), server: server.origin };
  const agent = new Agent(testConfig(root, { shell: "/bin/bash" }), identity);
  cleanups.push(() => agent.close());
  const workspace = await agent.metadata.add(root);
  await agent.start();
  await expect.poll(() => server.app.connections.devices()[0]?.status, polling).toBe("online");
  const session = await agent.sessions.create(
    workspace.id,
    undefined,
    undefined,
    new AbortController().signal,
  );
  const credential = server.store.createCredential("Attach", [identity.deviceId], null);
  const credentials = { server: server.origin, token: credential.token };
  const api = client(credentials);
  const params = { workspaceId: workspace.id, sessionId: session.id };
  async function open(mode: "tty" | "web", extra: Record<string, unknown> = {}) {
    const ready = await api.post<ChannelReady>(
      `/api/devices/${identity.deviceId}/channels`,
      {
        kind: "terminal.attach",
        params: { ...params, mode, cols: 80, rows: 24, term: "xterm-256color", ...extra },
      },
      undefined,
      false,
    );
    const socket = new WebSocket(
      server.origin.replace("http:", "ws:") +
        versionedPath(`/api/channels/${ready.channelId}/terminal`),
      { headers: { origin: server.origin, authorization: `Bearer ${credential.token}` } },
    );
    cleanups.push(() => socket.terminate());
    let output = "";
    let consumed = 0;
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (data, binary) => {
      const frame = binary ? undefined : (JSON.parse(data.toString()) as Record<string, unknown>);
      if (binary) output += data.toString();
      else frames.push(frame!);
      const credit =
        mode === "tty"
          ? binary
            ? Buffer.byteLength(data as Buffer)
            : 0
          : frame?.type === "error" || frame?.type === "input.error"
            ? 0
            : terminalOutputCost(Buffer.byteLength(data as Buffer));
      if (credit && socket.readyState === WebSocket.OPEN) {
        consumed += credit;
        socket.send(JSON.stringify({ type: "consumed", bytes: consumed }));
      }
    });
    const closed = once(socket, "close");
    await once(socket, "open");
    return { socket, frames, closed, output: () => output };
  }
  return { agent, root, session, params, api, identity, open };
}

test("TTY uses CLI credentials, shares the existing pane with Web, and detaches independently", async () => {
  const f = await fixture();
  const identity = f.agent.sessions.get(f.session.id).identity;
  const pane = () => tmux(identity.socket, ["display-message", "-p", "#{pane_pid} #{pane_dead}"]);
  const before = await pane();
  const web = await f.open("web");
  await expect.poll(() => web.frames.some((frame) => frame.type === "ready"), polling).toBe(true);
  const tty = await f.open("tty");
  tty.socket.send(Buffer.from("printf '中文\\n' > shared.txt\r"));
  await expect.poll(tty.output, polling).toContain("\x1b");
  await expect
    .poll(() => readFile(join(f.root, "shared.txt"), "utf8").catch(() => ""), polling)
    .toBe("中文\n");
  tty.socket.send(JSON.stringify({ type: "resize", cols: 93, rows: 31 }));
  await expect
    .poll(
      () => tmux(identity.socket, ["display-message", "-p", "#{pane_width}x#{pane_height}"]),
      polling,
    )
    .toBe("93x31\n");
  tty.socket.send(Buffer.from([2, 100]));
  await tty.closed;
  expect(tty.frames).toContainEqual({ type: "ended", exitCode: 0 });
  expect(await pane()).toBe(before);
  web.socket.send(Buffer.from("printf 'AFTER-CLI\\n'\r"));
  await expect.poll(web.output, polling).toContain("AFTER-CLI\r\n");
  const second = await f.open("tty");
  await expect.poll(second.output, polling).toContain("AFTER-CLI");
  second.socket.terminate();
  await second.closed;
  const cancelled = await f.open("tty");
  cancelled.socket.terminate();
  await cancelled.closed;
  await expect
    .poll(() => tmux(identity.socket, ["list-clients", "-F", "#{client_control_mode}"]), polling)
    .toBe("1\n");
  expect(await pane()).toBe(before);
}, 15000);

test("TTY rejects invalid targets and ACKs, but keeps working when recording is unavailable", async () => {
  const f = await fixture();
  await expect(f.open("tty", { workspaceId: "other" })).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(f.open("tty", { rows: 0 })).rejects.toMatchObject({ code: "invalid_argument" });
  const tty = await f.open("tty");
  await expect.poll(tty.output, polling).toContain("\x1b");
  process.kill(f.agent.sessions.recorder.pid!, "SIGKILL");
  await expect
    .poll(() => f.agent.sessions.get(f.session.id).session.webStatus, polling)
    .toBe("unavailable");
  tty.socket.send(Buffer.from("printf retained > retained.txt\r"));
  await expect
    .poll(() => readFile(join(f.root, "retained.txt"), "utf8").catch(() => ""), polling)
    .toBe("retained");
  await expect(f.open("web")).rejects.toMatchObject({ code: "recording_unavailable" });
  const second = await f.open("tty");
  await expect.poll(second.output, polling).toContain("\x1b");
  second.socket.send(JSON.stringify({ type: "consumed", bytes: Number.MAX_SAFE_INTEGER }));
  await second.closed;
  expect(second.frames).toContainEqual(
    expect.objectContaining({ type: "error", code: "invalid_argument" }),
  );
  tty.socket.send(Buffer.from([2, 100]));
  await tty.closed;
  expect(tty.frames).toContainEqual({ type: "ended", exitCode: 0 });
}, 15000);

test("blocked native input has a finite failure and cleanup without ending the pane", async () => {
  const f = await fixture();
  const identity = f.agent.sessions.get(f.session.id).identity;
  const bridge = await TtyBridge.start(
    identity.socket,
    { cols: 80, rows: 24, term: "xterm-256color" },
    () => {},
    () => {},
    () => {},
  );
  cleanups.push(() => bridge.stop());
  const clients = () =>
    tmux(identity.socket, ["list-clients", "-F", "#{?client_control_mode,,#{client_pid}}"]);
  await expect.poll(async () => (await clients()).trim(), polling).not.toBe("");
  const pid = Number((await clients()).trim());
  process.kill(pid, "SIGSTOP");
  const data = Buffer.alloc(64 * 1024, 120);
  expect(() => {
    for (let count = 0; count < 32; count++) bridge.input(data);
  }).toThrow("Terminal input backlog exceeds the limit");
  await bridge.stop();
  await expect.poll(async () => (await clients()).trim(), polling).toBe("");
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await tmux(identity.socket, ["display-message", "-p", "#{pane_dead}"])).toBe("0\n");
}, 15000);
