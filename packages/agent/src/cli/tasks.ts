import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import {
  AppError,
  OperationError,
  asError,
  type ScheduledTask,
  type ScheduledTaskInput,
  type TaskSchedule,
} from "@kiteline/shared/protocol";
import { agentConfig } from "../config.js";
import { localRequest } from "../local.js";
import { taskLimits } from "../limits.js";
import type { ScheduleMethod } from "../tasks/rpc.js";

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

function help(command?: string) {
  const lines =
    command !== undefined && Object.hasOwn(usage, command)
      ? [usage[command as Command]]
      : Object.values(usage);
  return `Scheduled Tasks - kiteline-agent schedule

${lines.map((line) => "  kiteline-agent schedule " + line + " [--json]").join("\n")}

All commands support --help and --json. Help works without a running or configured agent.
Management requires the bound agent running under the same OS user. No command starts
the agent. IDs are stable opaque strings; copy them from results.

Schedules: --cron is numeric five-field cron (minute hour day month weekday), with
OR semantics for day and weekday. --at is a future ISO timestamp with Z or an explicit
offset. Missed occurrences are skipped, not replayed. The default saved timezone is
the device timezone; it does not follow your browser or override the command's TZ.
The default cwd is the agent user's HOME. --cwd must be an existing absolute directory.
The configured Shell runs non-interactively with stdin closed, inheriting the agent's
environment, credentials and PATH (not this CLI's environment or cwd).
Linux/macOS use SHELL -c COMMAND. Windows uses PowerShell with
-NoProfile -NonInteractive -Command COMMAND.
There is no PTY, interactive approval, automatic retry or default runtime limit.

create stores an active task. update changes only supplied fields, preserving running
commands. It reads the current revision unless --expected-revision is supplied;
a conflict means read again and review before updating.
run returns after acceptance, not completion. Same-task overlap and device capacity
return busy. Closing this CLI, the browser or relay does not stop accepted commands.
pause prevents future schedules but allows manual run. stop stops only that run.
Linux/macOS send TERM to the process group, then KILL if it has not stopped.
Windows terminates the Job immediately. Poll status until it ends.
Keep commands in the foreground. Normal agent stop stops in-flight runs;
saved definitions and results remain. Stop the agent before upgrading;
upgrades refuse an installation still in use.
After an abnormal restart, unknown runs require review: reviewRunId blocks both
automatic and manual runs. acknowledge --run-id confirms the displayed ID and keeps
the task paused. Then use ordinary resume to enable its schedule.
delete removes a task and retained results, not files created by its command. Stop
active runs first; unresolved unknown runs also require --acknowledge-run. --yes
is required without an interactive terminal.

Results: list and runs return bounded pages with offset/total; use --offset for more.
status includes the command's exitCode/signal. output --limit accepts 4 to ${taskLimits.outputReadBytes} bytes.
It reads bounded UTF-8 text from
stdout or stderr; offset/nextOffset are bytes. Follow nextOffset to read further.
Output and records have finite retention: truncated means a retained prefix only.
A missing record may have been cleaned; it does not prove a command never ran.

JSON: one stdout object {outcome,result} or {outcome,error,taskId?,runId?}; diagnostics
go to stderr. Errors preserve code/details/outcome. Exit codes: 0 management success
or accepted, 1 confirmed management failure, 2 usage error, 3 unconfirmed outcome.
Neither run exit 0 nor status exit 0 means the command succeeded; inspect its state.
On exit 3 query the printed taskId/runId. Never automatically replay a mutation.

Examples (create examples below use Linux/macOS syntax):
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

function scheduleOption(
  cron: string | undefined,
  at: string | undefined,
): TaskSchedule | undefined {
  if (cron !== undefined && at !== undefined) throw new Error("Choose --cron or --at, not both");
  if (cron !== undefined) return { kind: "cron", expression: cron };
  if (at !== undefined) return { kind: "once", at };
  return undefined;
}

function numberOption(value: string | undefined, key: string, fallback?: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`--${key} must be a non-negative integer`);
  return Number(value);
}

type ScheduleRequest = <T>(method: ScheduleMethod, params?: Record<string, unknown>) => Promise<T>;

type SchedulePlan = {
  taskId?: string;
  runId?: string;
  confirmId?: string;
  execute: (request: ScheduleRequest) => Promise<unknown>;
};

function parseSchedulePlan(args: string[]): SchedulePlan {
  const name = args[0];
  const parse = <T extends ParseArgsOptionsConfig>(options: T, positionalCount: number) => {
    const parsed = parseArgs({
      args: args.slice(1),
      options: { ...options, json: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length !== positionalCount)
      throw new Error(`Usage: kiteline-agent schedule ${usage[name as Command]}`);
    return parsed;
  };
  switch (name) {
    case "list": {
      const { values } = parse({ offset: { type: "string" } }, 0);
      const offset = numberOption(values.offset, "offset", 0);
      return { execute: (request) => request("tasks.list", { offset }) };
    }
    case "show": {
      const { positionals } = parse({}, 1);
      const taskId = positionals[0]!;
      return {
        taskId,
        execute: (request) => request("tasks.get", { taskId }),
      };
    }
    case "preview": {
      const { values } = parse(
        { cron: { type: "string" }, at: { type: "string" }, timezone: { type: "string" } },
        0,
      );
      const schedule = scheduleOption(values.cron, values.at);
      if (!schedule) throw new Error("--cron or --at is required");
      return {
        execute: (request) => request("tasks.preview", { schedule, timezone: values.timezone }),
      };
    }
    case "create": {
      const { values } = parse(
        {
          name: { type: "string" },
          command: { type: "string" },
          cron: { type: "string" },
          at: { type: "string" },
          cwd: { type: "string" },
          timezone: { type: "string" },
          "task-id": { type: "string" },
        },
        0,
      );
      const schedule = scheduleOption(values.cron, values.at);
      if (!schedule) throw new Error("--cron or --at is required");
      if (!values.name || !values.command) throw new Error("--name and --command are required");
      const input: ScheduledTaskInput = {
        name: values.name,
        command: values.command,
        cwd: values.cwd,
        timezone: values.timezone,
        schedule,
      };
      const taskId = values["task-id"] ?? randomUUID();
      return {
        taskId,
        execute: (request) => request("tasks.create", { taskId, input }),
      };
    }
    case "update": {
      const { values, positionals } = parse(
        {
          name: { type: "string" },
          command: { type: "string" },
          cron: { type: "string" },
          at: { type: "string" },
          cwd: { type: "string" },
          timezone: { type: "string" },
          "expected-revision": { type: "string" },
        },
        1,
      );
      const changes: Partial<ScheduledTaskInput> = {
        name: values.name,
        command: values.command,
        cwd: values.cwd,
        timezone: values.timezone,
        schedule: scheduleOption(values.cron, values.at),
      };
      if (Object.values(changes).every((value) => value === undefined))
        throw new Error("Provide at least one field to update");
      const revision = numberOption(values["expected-revision"], "expected-revision");
      const taskId = positionals[0]!;
      return {
        taskId,
        execute: async (request) => {
          const expectedRevision =
            revision ?? (await request<ScheduledTask>("tasks.get", { taskId })).revision;
          return request("tasks.update", { taskId, expectedRevision, changes });
        },
      };
    }
    case "run": {
      const { values, positionals } = parse({ "run-id": { type: "string" } }, 1);
      const taskId = positionals[0]!;
      const runId = values["run-id"] ?? randomUUID();
      return {
        taskId,
        runId,
        execute: (request) => request("tasks.run", { taskId, runId }),
      };
    }
    case "pause": {
      const { positionals } = parse({}, 1);
      const taskId = positionals[0]!;
      return {
        taskId,
        execute: (request) => request("tasks.pause", { taskId }),
      };
    }
    case "resume": {
      const { positionals } = parse({}, 1);
      const taskId = positionals[0]!;
      return {
        taskId,
        execute: (request) => request("tasks.resume", { taskId }),
      };
    }
    case "acknowledge": {
      const { values, positionals } = parse({ "run-id": { type: "string" } }, 1);
      const runId = values["run-id"];
      if (!runId) throw new Error("--run-id is required");
      const taskId = positionals[0]!;
      return {
        taskId,
        runId,
        execute: (request) => request("tasks.acknowledge", { taskId, runId }),
      };
    }
    case "delete": {
      const { values, positionals } = parse(
        { yes: { type: "boolean" }, "acknowledge-run": { type: "string" } },
        1,
      );
      const taskId = positionals[0]!;
      return {
        taskId,
        confirmId: values.yes ? undefined : taskId,
        execute: (request) =>
          request("tasks.delete", { taskId, acknowledgeRunId: values["acknowledge-run"] }),
      };
    }
    case "runs": {
      const { values, positionals } = parse({ offset: { type: "string" } }, 1);
      const offset = numberOption(values.offset, "offset", 0);
      const taskId = positionals[0]!;
      return {
        taskId,
        execute: (request) => request("runs.list", { taskId, offset }),
      };
    }
    case "status": {
      const { positionals } = parse({}, 1);
      const runId = positionals[0]!;
      return {
        runId,
        execute: (request) => request("runs.get", { runId }),
      };
    }
    case "stop": {
      const { positionals } = parse({}, 1);
      const runId = positionals[0]!;
      return {
        runId,
        execute: (request) => request("runs.stop", { runId }),
      };
    }
    case "output": {
      const { values, positionals } = parse(
        { stream: { type: "string" }, offset: { type: "string" }, limit: { type: "string" } },
        1,
      );
      const offset = numberOption(values.offset, "offset", 0);
      const limit = numberOption(values.limit, "limit");
      const runId = positionals[0]!;
      return {
        runId,
        execute: (request) =>
          request("runs.output", { runId, stream: values.stream ?? "stdout", offset, limit }),
      };
    }
    default:
      throw new Error("Unknown schedule subcommand; use kiteline-agent schedule --help");
  }
}

async function confirmDeletion(taskId: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("Use --yes to confirm deletion without a terminal");
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await reader.question(`Delete task ${taskId} and its retained results? [y/N] `);
    return answer.toLowerCase() === "y";
  } finally {
    reader.close();
  }
}

function reportError(
  error: unknown,
  json: boolean,
  { taskId, runId }: Pick<SchedulePlan, "taskId" | "runId"> = {},
) {
  const outcome = error instanceof OperationError ? error.outcome : "failed";
  const detail = asError(error);
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
  process.exitCode = outcome === "unknown" ? 3 : detail.code === "invalid_argument" ? 2 : 1;
}

export async function scheduleCli(args: string[]) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(help(args[0]));
    return;
  }
  const json = args.includes("--json");
  let plan: SchedulePlan;
  try {
    plan = parseSchedulePlan(args);
  } catch (error) {
    reportError(new AppError("invalid_argument", asError(error).message), json);
    return;
  }
  if (plan.confirmId !== undefined) {
    let confirmed: boolean;
    try {
      confirmed = await confirmDeletion(plan.confirmId);
    } catch (error) {
      reportError(new AppError("invalid_argument", asError(error).message), json);
      return;
    }
    if (!confirmed) {
      reportError(new AppError("cancelled", "Deletion cancelled"), json);
      return;
    }
  }
  try {
    const config = await agentConfig();
    const request: ScheduleRequest = (method, params = {}) => localRequest(config, method, params);
    const result = await plan.execute(request);
    console.log(
      JSON.stringify(json ? { outcome: "succeeded", result } : result, null, json ? undefined : 2),
    );
  } catch (error) {
    reportError(error, json, plan);
  }
}
