import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { image: { type: "string" }, agent: { type: "string" } },
});
if (positionals.length !== 2 || (values.image && values.agent))
  throw new Error(
    "Usage: node scripts/verify-server.mjs PACKAGE WORK [--image=TAG | --agent=PACKAGE]",
  );
const [directory, work] = positionals.map((path) => resolve(path));
const release = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
const execute = promisify(execFile);
const command = async (file, args) =>
  (await execute(file, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 })).stdout;
await mkdir(work, { recursive: false });

function start(label, file, args, environment) {
  const child = spawn(file, args, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  const item = { label, child, output: "", result: undefined, error: undefined };
  item.done = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      item.result = { code, signal };
      resolve(item.result);
    }),
  );
  child.once("error", (error) => {
    item.error = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      item.output += bytes;
    });
  return item;
}
async function bounded(promise, message, milliseconds = 30000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(test, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await delay(100);
  }
  throw new Error(message);
}
async function stop(item) {
  if (!item.result) item.child.kill("SIGTERM");
  assert.deepEqual(
    await bounded(item.done, `${item.label} did not stop`),
    { code: 0, signal: null },
    item.output,
  );
}
async function terminal(agentDirectory, server, origin, children) {
  let cookie;
  async function api(path, method = "GET", body) {
    const url = new URL(path, origin);
    url.searchParams.set("appVersion", release.version);
    const response = await fetch(url, {
      method,
      headers: { origin, ...(cookie ? { cookie } : {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response;
  }
  const state = join(work, "agent-state");
  const workspace = join(work, "workspace");
  await mkdir(workspace);
  const environment = {
    ...process.env,
    KITELINE_AGENT_HOME: state,
    KITELINE_AGENT_RUN_DIR: join(work, "agent-run"),
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  const setupToken = /Kiteline setup token: (\S+)/.exec(server.output)?.[1];
  assert.ok(setupToken, server.output);
  const setup = await api("/api/setup", "POST", {
    setupToken,
    password: randomBytes(24).toString("hex"),
  });
  cookie = setup.headers.get("set-cookie").split(";")[0];
  const binding = await (await api("/api/bindings", "POST", {})).json();
  const entry = join(agentDirectory, "bin/kiteline-agent");
  const bind = start("bind", entry, ["bind", "--server", origin], environment);
  children.push(bind);
  bind.child.stdin.end(binding.code + "\n");
  const bound = await bounded(bind.done, "Binding did not finish");
  if (bind.error) throw bind.error;
  assert.deepEqual(bound, { code: 0, signal: null }, bind.output);
  const { deviceId } = JSON.parse(await readFile(join(state, "connection.json"), "utf8"));
  const agent = start("agent", entry, ["run"], environment);
  children.push(agent);
  agent.child.stdin.end();
  await until(async () => {
    if (agent.error) throw agent.error;
    if (agent.result) throw new Error(`Agent exited: ${agent.output}`);
    return (await (await api("/api/devices")).json()).devices.some(
      (device) => device.id === deviceId && device.status === "online",
    );
  }, "Agent did not become online");
  async function rpc(method, params) {
    const reply = await (
      await api(`/api/devices/${deviceId}/rpc`, "POST", { id: randomUUID(), method, params })
    ).json();
    assert.equal(reply.outcome, "succeeded", JSON.stringify(reply));
    return reply.result;
  }
  const workspaceRecord = await rpc("workspaces.add", { absolutePath: workspace, name: "CI" });
  const params = { workspaceId: workspaceRecord.id };
  const session = await rpc("sessions.create", { ...params, name: "CI" });
  const channel = await (
    await api(`/api/devices/${deviceId}/channels`, "POST", {
      kind: "terminal.attach",
      params: { ...params, sessionId: session.id, history: "retained" },
    })
  ).json();
  const { WebSocket } = await import(
    pathToFileURL(join(agentDirectory, "agent/node_modules/ws/wrapper.mjs"))
  );
  const url = new URL(
    `/api/channels/${channel.channelId}/terminal?appVersion=${release.version}`,
    origin,
  );
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { origin, cookie }, handshakeTimeout: 10000 });
  let socketError;
  socket.on("error", (error) => {
    socketError = error;
  });
  const frames = [];
  let output = "",
    consumed = 0;
  socket.on("message", (bytes, binary) => {
    if (binary) {
      output += bytes.toString();
      consumed += bytes.length;
      socket.send(JSON.stringify({ type: "consumed", bytes: consumed }));
    } else frames.push(JSON.parse(bytes.toString()));
  });
  const wait = (test, message) =>
    until(() => {
      if (socketError) throw socketError;
      return test();
    }, message);
  try {
    await wait(
      () => frames.some((frame) => frame.type === "ready"),
      "Terminal did not become ready",
    );
    const input = (text) => socket.send(Buffer.from(text));
    input("printf 'CI-%s\\n' 'PTY-OK'\r");
    await wait(() => output.includes("CI-PTY-OK\r\n"), "Shell output marker missing");
    input("exit 0\r");
    await wait(() => frames.some((frame) => frame.type === "ended"), "Shell did not exit");
    assert.equal(frames.find((frame) => frame.type === "ended").exitCode, 0);
    socket.close();
    await stop(agent);
  } finally {
    socket.terminate();
  }
}

async function verifyServer() {
  const children = [];
  const failures = [];
  let container, origin;
  try {
    let server;
    if (values.image) {
      const image = JSON.parse(await command("docker", ["image", "inspect", values.image]))[0];
      assert.equal(image.Os, "linux");
      assert.equal(image.Architecture, release.architecture === "x64" ? "amd64" : "arm64");
      container = `kiteline-ci-${randomUUID()}`;
      await command("docker", [
        "run",
        "-d",
        "--name",
        container,
        "-p",
        "127.0.0.1::8080",
        values.image,
      ]);
      const info = JSON.parse(await command("docker", ["inspect", container]))[0];
      origin = `http://127.0.0.1:${info.NetworkSettings.Ports["8080/tcp"][0].HostPort}`;
    } else {
      const reservation = createServer();
      await new Promise((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(0, "127.0.0.1", resolve);
      });
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      origin = `http://127.0.0.1:${port}`;
      server = start("server", join(directory, "bin/kiteline-server"), ["serve"], {
        ...process.env,
        KITELINE_DATA_DIR: join(work, "server-state"),
        KITELINE_LISTEN_ADDR: `127.0.0.1:${port}`,
      });
      children.push(server);
      server.child.stdin.end();
    }
    let health;
    await until(async () => {
      if (server?.error) throw server.error;
      if (server?.result) throw new Error(`Server exited: ${server.output}`);
      try {
        const response = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(1000) });
        if (!response.ok) return false;
        health = await response.json();
        return true;
      } catch {
        return false;
      }
    }, "Server health check did not become ready");
    assert.equal(health.version, release.version);
    if (values.agent) await terminal(resolve(values.agent), server, origin, children);
    if (container) {
      const prefix = "/opt/kiteline-server";
      assert.deepEqual(
        JSON.parse(await command("docker", ["exec", container, "cat", `${prefix}/release.json`])),
        release,
      );
      assert.equal(
        await command("docker", ["exec", container, "cat", `${prefix}/SHA256SUMS`]),
        await readFile(join(directory, "SHA256SUMS"), "utf8"),
      );
      await command("docker", [
        "exec",
        "-w",
        prefix,
        container,
        "sha256sum",
        "--status",
        "--check",
        "SHA256SUMS",
      ]);
      await command("docker", ["stop", "--time", "30", container]);
      const stopped = JSON.parse(await command("docker", ["inspect", container]))[0];
      assert.equal(stopped.State.ExitCode, 0);
      assert.equal(stopped.State.Pid, 0);
    } else await stop(server);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const item of children.reverse()) {
      if (!item.result) {
        try {
          await stop(item);
        } catch (error) {
          failures.push(error);
          item.child.kill("SIGKILL");
          try {
            await bounded(item.done, `${item.label} cleanup did not finish`, 5000);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      try {
        await writeFile(join(work, `${item.label}.log`), item.output);
      } catch (error) {
        failures.push(error);
      }
    }
    if (container) {
      try {
        const { stdout, stderr } = await execute("docker", ["logs", container], {
          timeout: 60000,
          maxBuffer: 16 * 1024 * 1024,
        });
        await writeFile(join(work, "container.log"), stdout + stderr);
      } catch (error) {
        failures.push(error);
      }
      try {
        await command("docker", ["rm", "--force", container]);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "Server acceptance failed");
}
await verifyServer();
console.log(
  `Server ${release.sourceCommit} (${release.architecture}): health and normal stop passed`,
);
if (values.agent) console.log("Connection, shell input/output and normal terminal exit passed");
