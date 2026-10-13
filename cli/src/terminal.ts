import { AppError, type SessionInput } from "@kiteline/shared/protocol";
import { ApiError } from "@kiteline/shared/protocol/client";
import { workspacePath } from "@kiteline/shared/protocol/navigation";
import { target } from "./config.js";
import { client, remote } from "./client.js";
import { result, screenResult, sessionLines } from "./output.js";
import type { Options } from "./options.js";

export async function terminal(
  command: string,
  options: Options,
  api: ReturnType<typeof client>,
  server: string,
) {
  const requiresSession = command !== "terminal create" && command !== "terminal list";
  const { deviceId, workspaceId, sessionId } = await target(options, requiresSession);
  if (command === "terminal list") {
    const reply = await remote(api.rpc(deviceId, "sessions.list", { workspaceId }));
    return result(reply, sessionLines(reply.sessions), options);
  }
  if (command === "terminal create") {
    const reply = await remote(
      api.rpc(deviceId, "sessions.create", { workspaceId, name: options.name }),
    );
    return result(reply, sessionLines([reply]), options);
  }
  const params = { workspaceId, sessionId: sessionId! };
  if (command === "web url") {
    const reply = await remote(api.rpc(deviceId, "sessions.list", { workspaceId }));
    if (!reply.sessions.some((s) => s.workspaceId === workspaceId && s.id === sessionId))
      throw new ApiError("not_found", "Terminal is not in this workspace; check terminal list");
    const url = new URL(
      workspacePath(deviceId, workspaceId, "terminal", { session: sessionId }),
      server,
    ).href;
    return result({ url }, url, options);
  }
  if (command === "terminal snapshot") {
    const reply = await remote(
      api.rpc(deviceId, "sessions.snapshot", {
        ...params,
        tail: options.tail,
        attrs: options.attrs,
        ifChanged: options["if-changed"],
      }),
    );
    return screenResult(reply, options);
  }
  if (command === "terminal send") {
    let input: SessionInput;
    if (options.key !== undefined) {
      input = { type: "key", key: options.key };
    } else if (options.paste !== undefined) {
      input = { type: "paste", text: options.paste, enter: options.enter };
    } else {
      input = { type: "text", text: options.text!, enter: options.enter };
    }
    const reply = await remote(
      api.rpc(deviceId, "sessions.send", {
        ...params,
        input,
        ifInput: options["if-input"],
        timeoutMs: options["timeout-ms"],
      }),
    );
    return result(
      reply,
      `Input handled.\nbefore=${reply.before.epoch}:${reply.before.seq}\ninput=${reply.input.epoch}:${reply.input.inputSeq}`,
      options,
    );
  }
  if (command === "terminal wait") {
    const observation =
      options.mode === "change"
        ? { mode: "change" as const, after: options.after! }
        : {
            mode: options.mode as "quiet" | undefined,
            quietMs: options["quiet-ms"],
          };
    const reply = await remote(
      api.rpc(deviceId, "sessions.wait", {
        ...params,
        ...observation,
        tail: options.tail,
        attrs: options.attrs,
        timeoutMs: options["timeout-ms"],
      }),
    );
    return screenResult(reply, options);
  }
  if (command === "terminal resize") {
    const reply = await remote(
      api.rpc(deviceId, "sessions.resize", {
        ...params,
        cols: options.cols!,
        rows: options.rows!,
        timeoutMs: options["timeout-ms"],
      }),
    );
    return result(reply, `Shared terminal resized to ${reply.cols}x${reply.rows}.`, options);
  }
  if (command === "terminal recover") {
    const reply = await remote(api.rpc(deviceId, "sessions.recover", params));
    return result(
      reply,
      `${sessionLines([reply])}\nUse terminal list or snapshot to observe recovery.`,
      options,
    );
  }
  throw new AppError("invalid_argument", `Unknown command: ${command}`);
}
