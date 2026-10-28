import { ApiError } from "@kiteline/shared/protocol/client";
import { workspacePath } from "@kiteline/shared/protocol/navigation";
import { target } from "./config.js";
import { client, remote } from "./client.js";
import { result, screenResult, sessionLines } from "./output.js";
import type { TerminalPlan, WebUrlPlan } from "./options.js";

export async function terminal(plan: TerminalPlan, api: ReturnType<typeof client>) {
  if (plan.command === "terminal list" || plan.command === "terminal create") {
    const { deviceId, ...params } = await target(plan.target);
    if (plan.command === "terminal list") {
      const reply = await remote(api.rpc(deviceId, "sessions.list", params));
      return result(reply, sessionLines(reply.sessions), plan.json);
    }
    const reply = await remote(api.rpc(deviceId, "sessions.create", { ...params, ...plan.params }));
    return result(reply, sessionLines([reply]), plan.json);
  }
  const { deviceId, ...params } = await target(plan.target);
  switch (plan.command) {
    case "terminal snapshot": {
      const reply = await remote(
        api.rpc(deviceId, "sessions.snapshot", { ...params, ...plan.params }),
      );
      return screenResult(reply, plan.json);
    }
    case "terminal send": {
      const reply = await remote(api.rpc(deviceId, "sessions.send", { ...params, ...plan.params }));
      return result(
        reply,
        `Input handled.\nbefore=${reply.before.epoch}:${reply.before.seq}\ninput=${reply.input.epoch}:${reply.input.inputSeq}`,
        plan.json,
      );
    }
    case "terminal wait": {
      const reply = await remote(api.rpc(deviceId, "sessions.wait", { ...params, ...plan.params }));
      return screenResult(reply, plan.json);
    }
    case "terminal resize": {
      const reply = await remote(
        api.rpc(deviceId, "sessions.resize", { ...params, ...plan.params }),
      );
      return result(reply, `Shared terminal resized to ${reply.cols}x${reply.rows}.`, plan.json);
    }
    case "terminal recover": {
      const reply = await remote(api.rpc(deviceId, "sessions.recover", params));
      return result(
        reply,
        `${sessionLines([reply])}\nUse terminal list or snapshot to observe recovery.`,
        plan.json,
      );
    }
  }
}

export async function webUrl(plan: WebUrlPlan, api: ReturnType<typeof client>, server: string) {
  if (plan.path !== undefined) {
    const { deviceId, workspaceId } = await target(plan.target);
    await remote(api.rpc(deviceId, "sessions.list", { workspaceId }));
    const url = new URL(workspacePath(deviceId, workspaceId, "files", { file: plan.path }), server)
      .href;
    return result({ url }, url, plan.json);
  }
  const { deviceId, workspaceId, sessionId } = await target(plan.target);
  const reply = await remote(api.rpc(deviceId, "sessions.list", { workspaceId }));
  if (
    !reply.sessions.some(
      (session) => session.workspaceId === workspaceId && session.id === sessionId,
    )
  )
    throw new ApiError("not_found", "Terminal is not in this workspace; check terminal list");
  const url = new URL(
    workspacePath(deviceId, workspaceId, "terminal", { session: sessionId }),
    server,
  ).href;
  return result({ url }, url, plan.json);
}
