#!/usr/bin/env node
import { createInterface } from "node:readline";
import {
  AppError,
  appVersion,
  asError,
  string,
  type CliCredential,
  type Device,
} from "@kiteline/shared/protocol";
import { ApiError } from "@kiteline/shared/protocol/client";
import { credentials, removeCredentials, saveCredentials, serverOrigin, target } from "./config.js";
import { client, remote } from "./client.js";
import { help, parse } from "./options.js";
import { result, sessionLines } from "./output.js";
import { terminal, webUrl } from "./terminal.js";
import { files } from "./files.js";
import { attach } from "./attach.js";

async function session(api: ReturnType<typeof client>) {
  const value = await remote(api.api<CliCredential & { kind: string }>("/api/session"));
  if (value.kind !== "cli")
    throw new ApiError("permission_denied", "A Web-issued CLI credential is required");
  return value;
}

async function run() {
  const plan = parse(process.argv.slice(2));
  if (plan.command === "help") return process.stdout.write(help(plan.requestedCommand));
  if (plan.command === "version") return process.stdout.write(appVersion + "\n");
  if (plan.command === "terminal attach") {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new AppError("invalid_argument", "terminal attach requires stdin and stdout TTYs");
    if (process.platform === "win32" && !process.env.KITELINE_ATTACH_RESULT)
      throw new AppError(
        "invalid_argument",
        "Windows terminal attach requires the kiteline.ps1 entry",
      );
  }
  if (plan.command === "auth login") {
    const server = serverOrigin(plan.server);
    let token: string;
    if (plan.tokenStdin) {
      process.stdin.setEncoding("utf8");
      token = "";
      for await (const chunk of process.stdin) token += chunk;
    } else {
      if (!process.stdin.isTTY)
        throw new AppError(
          "invalid_argument",
          "No TTY. Use --token-stdin to read a Web-issued token explicitly.",
        );
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const line = prompt[Symbol.asyncIterator]().next();
        process.stderr.write("Paste Web-issued CLI token: ");
        const { value, done } = await line;
        if (done) throw new AppError("invalid_argument", "Token input closed without a token");
        token = value;
      } finally {
        prompt.close();
      }
    }
    const value = { server, token: string(token.trim(), "token") };
    const access = await session(client(value));
    await saveCredentials(value);
    if (process.env.KITELINE_URL !== undefined || process.env.KITELINE_TOKEN !== undefined)
      process.stderr.write("Saved credentials; KITELINE_URL/KITELINE_TOKEN still override them.\n");
    return result(
      { server, ...access, source: "file" },
      `Saved ${access.name} for ${server}\nDevices: ${access.deviceIds.join(", ")}\nExpires: ${access.expiresAt ?? "never"}`,
      plan.json,
    );
  }
  const auth = await credentials();
  const api = client(auth);
  if (plan.command === "terminal attach") return attach(plan, api, auth);
  if (plan.command === "files download" || plan.command === "files upload") return files(plan, api);
  if (plan.command === "auth status") {
    const access = await session(api);
    return result(
      { server: auth.server, ...access, source: auth.source },
      `${access.name} at ${auth.server} (${auth.source})\nDevices: ${access.deviceIds.join(", ")}\nExpires: ${access.expiresAt ?? "never"}`,
      plan.json,
    );
  }
  if (plan.command === "auth logout") {
    try {
      await remote(api.post("/api/logout"));
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "unauthenticated") throw error;
    }
    await removeCredentials(auth);
    return result(
      { revoked: true, source: auth.source },
      `Current token revoked or already invalid.${auth.source === "environment" ? " Remove KITELINE_URL/KITELINE_TOKEN from the calling environment." : " Saved credentials removed."}`,
      plan.json,
    );
  }
  if (plan.command === "targets") {
    const reply = await remote(api.api<{ devices: Device[] }>("/api/devices"));
    const devices = reply.devices.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      lastSeenAt: d.lastSeenAt,
      workspaceSource: "device_snapshot",
      snapshotRevision: d.snapshot?.revision,
      workspaces: d.snapshot?.workspaces ?? [],
    }));
    return result(
      { devices },
      devices.length
        ? devices
            .map(
              (d) =>
                `${d.id}  ${d.name}  ${d.status}\n  Workspaces (device snapshot${d.status === "offline" ? "; offline" : ""}):\n${d.workspaces.map((w) => `  ${w.id}  ${w.name}  ${w.path}`).join("\n") || "  (none)"}`,
            )
            .join("\n")
        : "No authorized devices.",
      plan.json,
    );
  }
  if (plan.command === "web url") return webUrl(plan, api, auth.server);
  if (plan.command !== "inspect") return terminal(plan, api);
  const { deviceId, workspaceId } = await target(plan.target);
  const reply = await remote(api.api<{ devices: Device[] }>("/api/devices"));
  const device = reply.devices.find((d) => d.id === deviceId);
  if (!device)
    throw new ApiError("not_found", "Device is not in the authorized device list; check targets");
  const workspace = device.snapshot?.workspaces.find((w) => w.id === workspaceId);
  if (!workspace)
    throw new ApiError("not_found", "Workspace is not in this device snapshot; check targets");
  const { sessions } = await remote(api.rpc(deviceId, "sessions.list", { workspaceId }));
  return result(
    {
      device: { id: device.id, name: device.name, status: device.status },
      workspace,
      workspaceSource: "device_snapshot",
      sessions,
    },
    `${device.id}  ${device.name}\n${workspace.id}  ${workspace.name}  ${workspace.path} (device snapshot)\n${sessionLines(sessions)}`,
    plan.json,
  );
}

try {
  await run();
} catch (error) {
  const remoteFailure = error instanceof ApiError;
  const outcome = remoteFailure ? (error.outcome ?? "failed") : "failed";
  const failure = remoteFailure
    ? { code: error.code, message: error.message, details: error.details }
    : asError(error);
  const optionEnd = process.argv.indexOf("--");
  const optionArgs = process.argv.slice(2, optionEnd === -1 ? undefined : optionEnd);
  if (optionArgs.includes("--json"))
    process.stdout.write(
      JSON.stringify({
        outcome,
        error: failure,
        ...(remoteFailure && error.result !== undefined ? { result: error.result } : {}),
      }) + "\n",
    );
  else
    process.stderr.write(
      `${outcome} [${failure.code}] ${failure.message}${failure.details === undefined ? "" : `\n${JSON.stringify(failure.details)}`}${remoteFailure && error.result !== undefined ? `\nresult=${JSON.stringify(error.result)}` : ""}\n`,
    );
  process.exitCode = outcome === "unknown" ? 3 : remoteFailure ? 1 : 2;
}
