import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  AppError,
  OperationError,
  asError,
  type ScheduledTask,
  type ScheduledTaskInput,
  type TaskSchedule,
} from "@kiteline/shared/protocol";
import { agentConfig } from "./config.js";
import { localRequest } from "./local.js";

const usage = {
  list: "list [--offset N]",
  show: "show TASK_ID",
  create:
    "create --name NAME --command COMMAND (--cron EXPR | --at ISO_DATE) [--cwd PATH] [--timezone IANA_ZONE] [--task-id ID]",
  update:
    "update TASK_ID [--name NAME] [--command COMMAND] [--cron EXPR | --at ISO_DATE] [--cwd PATH] [--timezone IANA_ZONE] [--expected-revision N]",
  preview: "preview (--cron EXPR | --at ISO_DATE) [--timezone IANA_ZONE]",
  run: "run TASK_ID [--run-id ID]",
  pause: "pause TASK_ID",
  resume: "resume TASK_ID",
  acknowledge: "acknowledge TASK_ID --run-id RUN_ID",
  runs: "runs TASK_ID [--offset N]",
  status: "status RUN_ID",
  output: "output RUN_ID [--stream stdout|stderr] [--offset N] [--limit BYTES]",
  stop: "stop RUN_ID",
  delete: "delete TASK_ID [--yes] [--acknowledge-run RUN_ID]",
} as const;
type Command = keyof typeof usage;

function help(command?: Command) {
  return `Scheduled Tasks - kiteline-agent schedule

${Object.values(command ? { [command]: usage[command] } : usage)
  .map((line) => "  kiteline-agent schedule " + line + " [--json]")
  .join("\n")}

All commands support --help and --json. Help works without a running or configured agent.
Management requires the bound agent running under the same OS user. No command starts
the agent. IDs are stable opaque strings; copy them from results.

Schedules: --cron is numeric five-field cron (minute hour day month weekday), with
OR semantics for day and weekday. --at is a future ISO timestamp with Z or an explicit
offset. Missed occurrences are skipped, not replayed. The default saved timezone is
the device timezone; it does not follow your browser or override the command's TZ.
The default cwd is the agent user's HOME. --cwd must be an existing absolute directory.
The configured Shell runs -c COMMAND, non-interactively with stdin closed, inheriting
the agent's environment, credentials and PATH (not this CLI's environment or cwd).
There is no PTY, interactive approval, automatic retry or default runtime limit.

create stores an active task. update changes only supplied fields, preserving running
commands. It reads the current revision unless --expected-revision is supplied;
a conflict means read again and review before updating.
run returns after acceptance, not completion. Same-task overlap and device capacity
return busy. Closing this CLI, the browser or relay does not stop accepted commands.
pause prevents future schedules but allows manual run. stop stops only that run,
using TERM then KILL; poll status until it ends. Keep commands in the foreground.
Normal agent stop/upgrade stops in-flight runs; saved definitions and results remain.
After an abnormal restart, unknown runs require review: reviewRunId blocks both
automatic and manual runs. acknowledge --run-id confirms the displayed ID and keeps
the task paused. Then use ordinary resume to enable its schedule.
delete removes a task and retained results, not files created by its command. Stop
active runs first; unresolved unknown runs also require --acknowledge-run. --yes
is required without an interactive terminal.

Results: list and runs return bounded pages with offset/total; use --offset for more.
status includes the command's exitCode/signal. output --limit accepts 4 to 32768 bytes.
It reads bounded UTF-8 text from
stdout or stderr; offset/nextOffset are bytes. Follow nextOffset to read further.
Output and records have finite retention: truncated means a retained prefix only.
A missing record may have been cleaned; it does not prove a command never ran.

JSON: one stdout object {outcome,result} or {outcome,error,taskId?,runId?}; diagnostics
go to stderr. Errors preserve code/details/outcome. Exit codes: 0 management success
or accepted, 1 confirmed management failure, 2 usage error, 3 unconfirmed outcome.
Neither run exit 0 nor status exit 0 means the command succeeded; inspect its state.
On exit 3 query the printed taskId/runId. Never automatically replay a mutation.

Examples:
  kiteline-agent schedule preview --cron '0 9 * * 1-5' --timezone Asia/Shanghai --json
  kiteline-agent schedule create --name 'Daily review' --cron '0 9 * * 1-5' --timezone Asia/Shanghai --cwd '/srv/My Project' --command './daily-review.sh' --json
  kiteline-agent schedule create --name 'One check' --at '2027-01-05T09:00:00+08:00' --command 'printf ready' --json
  kiteline-agent schedule list --json
  kiteline-agent schedule show TASK_ID --json
  kiteline-agent schedule update TASK_ID --name 'Review' --expected-revision 1 --json
  kiteline-agent schedule run TASK_ID --run-id MY_RUN_ID --json
  kiteline-agent schedule status MY_RUN_ID --json
  kiteline-agent schedule output MY_RUN_ID --stream stdout --offset 0 --json
  kiteline-agent schedule runs TASK_ID --json
  kiteline-agent schedule pause TASK_ID --json
  kiteline-agent schedule stop MY_RUN_ID --json
  kiteline-agent schedule acknowledge TASK_ID --run-id UNKNOWN_RUN_ID --json
  kiteline-agent schedule resume TASK_ID --json
  kiteline-agent schedule delete TASK_ID --yes --acknowledge-run UNKNOWN_RUN_ID --json
`;
}

export async function scheduleCli(args: string[]) {
  const name = args[0];
  const validCommand = name !== undefined && Object.hasOwn(usage, name);
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(help(validCommand ? (name as Command) : undefined));
    return;
  }
  let taskId: string | undefined;
  let runId: string | undefined;
  const json = args.includes("--json");
  let parsing = true;
  try {
    if (!validCommand)
      throw new Error("Unknown schedule subcommand; use kiteline-agent schedule --help");
    const command = name as Command;
    const allowed = usage[command].match(/--[a-z-]+/g) ?? [];
    const options = Object.fromEntries(
      [...allowed.map((flag) => flag.slice(2)), "json"].map((key) => [
        key,
        { type: key === "json" || key === "yes" ? ("boolean" as const) : ("string" as const) },
      ]),
    );
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options,
      allowPositionals: true,
      strict: true,
    });
    const hasId = !["list", "create", "preview"].includes(command);
    if (positionals.length !== (hasId ? 1 : 0))
      throw new Error(`Usage: kiteline-agent schedule ${usage[command]}`);
    const option = (key: string) => values[key] as string | undefined;
    const number = (key: string, fallback?: number) => {
      const value = option(key);
      if (value === undefined) return fallback;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error(`--${key} must be a non-negative integer`);
      return Number(value);
    };
    const fields: Partial<ScheduledTaskInput> = {};
    for (const key of ["name", "command", "cwd", "timezone"] as const)
      if (option(key) !== undefined) fields[key] = option(key);
    let schedule: TaskSchedule | undefined;
    if (option("cron") !== undefined && option("at") !== undefined)
      throw new Error("Choose --cron or --at, not both");
    if (option("cron") !== undefined) schedule = { kind: "cron", expression: option("cron")! };
    if (option("at") !== undefined) schedule = { kind: "once", at: option("at")! };
    if (schedule) fields.schedule = schedule;
    if (["create", "preview"].includes(command) && !schedule)
      throw new Error("--cron or --at is required");
    if (command === "create" && (!fields.name || !fields.command))
      throw new Error("--name and --command are required");
    if (command === "update" && !Object.keys(fields).length)
      throw new Error("Provide at least one field to update");
    if (command === "acknowledge" && !option("run-id")) throw new Error("--run-id is required");
    const offset = number("offset", 0);
    const limit = number("limit");
    const revision = number("expected-revision");
    const acknowledgeRunId = option("acknowledge-run");
    if (command === "delete" && !values.yes) {
      if (!process.stdin.isTTY) throw new Error("Use --yes to confirm deletion without a terminal");
      const reader = createInterface({ input: process.stdin, output: process.stderr });
      try {
        if (
          (
            await reader.question(`Delete task ${positionals[0]} and its retained results? [y/N] `)
          ).toLowerCase() !== "y"
        ) {
          parsing = false;
          throw new AppError("cancelled", "Deletion cancelled");
        }
      } finally {
        reader.close();
      }
    }
    if (["status", "output", "stop"].includes(command)) runId = positionals[0];
    else if (hasId) taskId = positionals[0];
    if (command === "create") taskId = option("task-id") ?? randomUUID();
    if (command === "run") runId = option("run-id") ?? randomUUID();
    if (command === "acknowledge") runId = option("run-id");
    parsing = false;
    const config = await agentConfig();
    const request = <T>(method: string, params: Record<string, unknown> = {}) =>
      localRequest<T>(config, method, params);
    let result: unknown;
    switch (command) {
      case "list":
        result = await request("tasks.list", { offset });
        break;
      case "show":
        result = await request("tasks.get", { taskId });
        break;
      case "preview":
        result = await request("tasks.preview", { schedule, timezone: fields.timezone });
        break;
      case "create":
        result = await request("tasks.create", { taskId, input: fields });
        break;
      case "update": {
        const expectedRevision =
          revision ?? (await request<ScheduledTask>("tasks.get", { taskId })).revision;
        result = await request("tasks.update", { taskId, expectedRevision, changes: fields });
        break;
      }
      case "run":
        result = await request("tasks.run", { taskId, runId });
        break;
      case "pause":
        result = await request("tasks.pause", { taskId });
        break;
      case "resume":
        result = await request("tasks.resume", { taskId });
        break;
      case "acknowledge":
        result = await request("tasks.acknowledge", { taskId, runId });
        break;
      case "delete":
        result = await request("tasks.delete", { taskId, acknowledgeRunId });
        break;
      case "runs":
        result = await request("runs.list", { taskId, offset });
        break;
      case "status":
        result = await request("runs.get", { runId });
        break;
      case "stop":
        result = await request("runs.stop", { runId });
        break;
      case "output":
        result = await request("runs.output", {
          runId,
          stream: option("stream") ?? "stdout",
          offset,
          limit,
        });
        break;
    }
    console.log(
      JSON.stringify(json ? { outcome: "succeeded", result } : result, null, json ? undefined : 2),
    );
  } catch (error) {
    const outcome = error instanceof OperationError ? error.outcome : "failed";
    const detail = parsing
      ? { code: "invalid_argument", message: asError(error).message }
      : asError(error);
    if (json)
      console.log(
        JSON.stringify({
          outcome,
          error: detail,
          taskId,
          runId,
          ...(error instanceof OperationError && error.result !== undefined
            ? { result: error.result }
            : {}),
        }),
      );
    console.error(
      `${detail.code}: ${detail.message}${taskId ? ` (taskId=${taskId})` : ""}${runId ? ` (runId=${runId})` : ""}`,
    );
    process.exitCode =
      outcome === "unknown" ? 3 : parsing || detail.code === "invalid_argument" ? 2 : 1;
  }
}
