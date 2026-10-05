# Scheduled tasks

[中文](scheduled-tasks.md)

Scheduled tasks are stored on a device and executed by its agent. They run noninteractive commands in the background according to a schedule, such as periodically running a script or AI CLI. This guide explains how the owner can manage the same tasks in the web app and with `kiteline-agent schedule` on the device. For the underlying behavior, see [Scheduled-task contract (Chinese)](../design/scheduled-tasks.md).

## Create and edit tasks

Open “Scheduled Tasks” from the top bar, home page or device details. Tasks are listed by device. The device selector at the top can show one device or “All devices”. For an offline device, the list shows the latest summary saved by the server (“Last observed {{time}}. Current state is unavailable.”). Tasks cannot be edited or run while the device is offline.

Click “New task” to open the form:

| Field                | Description                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| “Device”             | The device that owns the task; cannot change after saving                                              |
| “Name”               | Required                                                                                               |
| “Schedule”           | “Once”, “Every hour”, “Daily”, “Weekly” or “Cron (five fields)”; see [Schedule rules](#schedule-rules) |
| “Command”            | Required; command text passed to the shell                                                             |
| “Working directory”  | Defaults to “Device HOME” when empty; “Choose workspace directory” fills in a workspace's path         |
| “Schedule time zone” | Defaults to “Device time zone” when empty                                                              |

“Working directory” and “Schedule time zone” are inside the collapsed “Working directory and schedule time zone” section. Common intervals are converted to Cron expressions in the schedule time zone:

| Interval     | Meaning                                        | Expression  |
| ------------ | ---------------------------------------------- | ----------- |
| “Every hour” | Minute 0 of every hour                         | `0 * * * *` |
| “Daily”      | The specified “Time” each day                  | `M H * * *` |
| “Weekly”     | The specified “Time” on the selected “Weekday” | `M H * * D` |

“Next runs · browser local” below the form shows the next 3 run times calculated by the device, displayed in the browser's time zone with the offset. Preview and save use the same rules: if the preview reports an error, saving will also fail.

The working directory must already exist on the device. It is checked when creating a task or changing that directory. If it is later deleted or moved, the run fails with “Command could not start”.

### Edit and delete

Click “Edit task” in task details. Saving submits only changed fields. An active run keeps the command and working directory it started with; edits take effect on the next run.

If another browser or the command line changes the task after you open the form, saving fails with “The task changed elsewhere. Read the current definition before saving your edits.” Your input is kept. Click “Read current definition” to view “Current definition”, check it, and save again. If a connection interruption leaves the save result unclear, the form shows “Task ID” and a “Check result” button. Use it to check whether the task was saved instead of submitting again.

Click “Delete” and confirm to delete the task definition and its retained run records. Files written by the command remain. A task cannot be deleted while a run is unfinished; stop that run first.

## Schedule rules

### Cron expressions

Use five numeric fields: minute, hour, day of month, month and day of week. Each can contain `*`, a number, a list (`1,15`), a range (`1-5`) or a step (`*/10`). Days of the week use 0 through 6, with 0 meaning Sunday. English names such as `MON`, a seconds field, and forms such as `@daily` are not accepted. Expressions have a length limit (see [Limits](reference.en.md#limits)) and must have at least one future occurrence.

If both day of month and day of week are restricted, either condition can trigger a run. For example, `0 9 13 * 5` runs at 09:00 on the 13th of each month and every Friday.

### One-time schedules

Enter “Date and time (browser local)” in the browser's time zone. The CLI `--at` option requires an ISO 8601 timestamp with seconds and either `Z` or an offset such as `+08:00`, for example `2027-01-05T09:00:00+08:00`. `2027-01-05T09:00+08:00` is rejected. The time must be in the future.

A one-time schedule runs at most once. Its status progresses from “Pending” to “Plan consumed” or “Missed”. If the scheduled occurrence is skipped because “Previous run was still active” or “Device run capacity was reached”, it also becomes “Plan consumed”: the command did not run and will not run later. Change its time to schedule it again if needed. “Run now” does not consume the one-time schedule. Changing the scheduled time creates a new one-time schedule and returns its status to “Pending”.

### Schedule time zone

Cron expressions are interpreted in the task's schedule time zone. Use an IANA name such as `Asia/Shanghai`; fixed offsets such as `+08:00` are rejected. If omitted, the device's time zone at save time is stored with the task. It does not subsequently follow changes to the browser or device time zone. This setting determines only when a run starts; the command's `TZ` environment variable still comes from the agent.

During daylight-saving transitions, nonexistent local times are skipped, and repeated local times run only once.

### Missed runs

If the agent is stopped or the task is paused at a scheduled time, that occurrence is skipped and is not made up later. When the agent starts or the task resumes, the next occurrence is calculated from the current time.

If the agent is running but its timer fires later than the lateness tolerance (see [Limits](reference.en.md#limits), for example after waking from sleep), the run is recorded as “Skipped” with “Scheduled time was missed”. If a one-time schedule passes while the agent is stopped or the task is paused, it does not run. When the agent next starts, or the task is resumed or edited, the schedule becomes “Missed” and a “Skipped” record is retained.

## Execution environment

Commands run noninteractively using the agent's configured shell: `SHELL -c COMMAND` on Linux and macOS, and PowerShell 7 with `-Command` on Windows. See [Shell](reference.en.md#shell) for defaults and complete arguments.

- The shell is neither a login shell nor an interactive shell. If your command depends on settings from `~/.bashrc`, `~/.profile` or a PowerShell profile, include them in the command or the agent's startup environment.
- Standard input is closed and there is no terminal (PTY). Programs requiring a terminal or human confirmation fail or immediately reach end of input. Use your AI CLI's noninteractive mode.
- The command runs as the agent's operating-system user and inherits its environment, including `HOME`, `PATH`, proxy variables, SSH agent and Git credentials. It does not inherit the environment or current directory of the shell that runs `kiteline-agent schedule`. For an agent running as a background service, the service configuration supplies the environment; see [Run in the background](devices.en.md#run-in-the-background).
- The default working directory is the project user's HOME (the user profile directory on Windows).
- There is no default runtime limit. A command runs until it exits or is stopped. Exceeding output limits does not stop it.
- Commands run in a separate process group on Linux and macOS, or a Job on Windows. Stopping affects every process in that group or Job. Commands should complete their work in the foreground. On Linux and macOS, background processes that detach themselves from the process group are outside the stop operation's control.
- Scheduled tasks do not run in tmux and cannot be attached to. View results in run records.

Exit code 0 produces “Succeeded”. A nonzero exit produces “Failed” with “Command exited unsuccessfully”. An unavailable working directory or shell that prevents startup produces “Failed” with “Command could not start”.

## Run and stop

- **Run now.** Click “Run now” in task details. Once the device accepts it, the run details open. A successful request means only that the run was accepted. Closing the browser or CLI does not stop it.
- **Concurrency.** Each task can have only one run at a time, and each device has a simultaneous-run limit (see [Limits](reference.en.md#limits)). If these conditions are not met, “Run now” reports “The resource is busy.” Scheduled runs are not queued; they are recorded as “Skipped” with “Previous run was still active” or “Device run capacity was reached”.
- **Pause and resume.** “Pause schedule” stops future scheduled runs without affecting an active run. “Run now” remains available while paused. “Resume schedule” recalculates the next occurrence from the current time.
- **Stop.** In run details, click “Stop run” and confirm “Stop this run? Changes already made by the command will remain.” Linux and macOS send `SIGTERM` to the entire process group, then `SIGKILL` if it has not ended after the stop grace period (see [Limits](reference.en.md#limits)). Windows immediately terminates the whole Job. The run moves through “Stopping” to “Stopped”, with “Stop requested”.
- **Normal agent shutdown.** When the agent stops through Ctrl-C, a service manager or before an upgrade, active runs stop in the same way and are recorded as “Stopped” with “Agent stopped”. Definitions and records remain, and scheduling continues when the agent starts again.
- **No automatic retries.** Failed or skipped runs are not retried. The next scheduled occurrence proceeds normally.

If the result of “Run now” is unclear, the page shows “Run ID” and a “Check result” button. First use it to check whether the run started, then decide whether to run again. See [Result semantics (Chinese)](../design/protocol.md#结果语义).

## Run records and output

“Recent runs” in task details lists records newest first. Run details show:

- Status, trigger (“Manual” or “Scheduled”), reason, “Exit code” or “Signal”;
- “Accepted”, “Started” and “Ended” times;
- “Command and environment”: the command, working directory and PID used for this run;
- stdout and stderr separately, without a shared chronological order between them.

While run details are visible, the web app reads new output every 2 seconds. Reading earlier output does not pull you back to the bottom.

Output and records have retention limits; see [Limits](reference.en.md#limits) for values:

- Each run has a combined stdout and stderr limit. Excess output is not saved, the command keeps running, and details show “Output is incomplete or exceeds retention limits.”
- Each task retains only its latest `taskHistoryRuns` finished records, including “Skipped” records.
- Total output on a device is limited. Before a new run, if remaining capacity is less than one run's output allowance, the agent deletes finished records containing output, oldest first, until enough space is available. If deleting all eligible records would still be insufficient, it deletes none and truncates the new run's output earlier. Active runs and runs needing review are not deleted.

Records are stored under `tasks/` in the agent data directory (see [File locations](reference.en.md#file-locations)), survive restarts and upgrades, and are deleted by `uninstall --purge-state`. Opening a cleared record shows “Run not found or already cleared. Check the previous execution before running again.” A missing record does not prove the command never ran. Files written by the command remain where it wrote them; files inside a workspace can be viewed in “Files”.

## Review after an agent restart

If the agent ends unexpectedly (killed process, crash or power loss), active runs have no trustworthy final result. At its next startup, the agent:

1. Marks those runs “Unknown”, with “Previous result is unconfirmed”;
2. Pauses their tasks, showing “Needs review” and “Check the previous process. Confirming the review keeps this task paused.”;
3. Rejects scheduled runs and “Run now” for each task until review is complete. The previous run continues to occupy a device run slot.

To review:

1. Open the run ID in the notice and inspect the command and PID in “Command and environment”. On Linux and macOS, the command runs in a separate process group and may survive the agent. Check the PID and command to determine whether it is still running, and stop it yourself if needed. On Windows, its Job and all processes end with the agent.
2. Check any effects the command already produced, such as partially written files.
3. Click “Confirm review” and confirm “I have checked run … and confirmed that no previous process remains. Continue?” The task stays paused and the record remains “Unknown”.
4. Click “Resume schedule” when you want scheduling to continue.

You can also delete a task that needs review. Its deletion confirmation includes the same review confirmation.

If the agent cannot read files under `tasks/` at startup, the device's task feature shows “Scheduled task storage is unavailable on this device.” The agent log identifies the failing file in a message beginning `Scheduled task storage:`. Terminals, files and Git remain available. Repair or move the failing file and restart the agent. The agent does not automatically repair or delete these files.

## Command line

`kiteline-agent schedule` manages the same tasks locally on the device. It connects to the running agent through a local socket or named pipe, so it must run as the same operating-system user and resolve to the same runtime directory. It does not start the agent. When the agent is not running, every command except `--help` exits with an error. `--help` is always available and includes the complete rules and examples.

See [kiteline-agent commands](reference.en.md#kiteline-agent-commands) for Windows invocation forms. To read the JSON list in PowerShell 7:

```powershell
& "$PSHOME\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\kiteline-agent\kiteline-agent.ps1" schedule list --json | ConvertFrom-Json
```

| Subcommand                            | Purpose                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `list [--offset N]`                   | List tasks in pages                                                         |
| `show TASK_ID`                        | View a task definition                                                      |
| `create`                              | Create a task; requires `--name`, `--command` and either `--cron` or `--at` |
| `update TASK_ID`                      | Change only the supplied fields                                             |
| `preview`                             | Calculate upcoming times from `--cron` or `--at` and `--timezone`           |
| `run TASK_ID [--run-id ID]`           | Run now                                                                     |
| `pause TASK_ID`, `resume TASK_ID`     | Pause or resume scheduling                                                  |
| `acknowledge TASK_ID --run-id RUN_ID` | Confirm review                                                              |
| `runs TASK_ID [--offset N]`           | List run records in pages                                                   |
| `status RUN_ID`                       | View a run's status, exit code and signal                                   |
| `output RUN_ID`                       | Read output                                                                 |
| `stop RUN_ID`                         | Stop a run                                                                  |
| `delete TASK_ID`                      | Delete a task and its records                                               |

```sh
kiteline-agent schedule preview --cron '0 9 * * 1-5' --timezone Asia/Shanghai --json
kiteline-agent schedule create --name 'Daily review' --cron '0 9 * * 1-5' --timezone Asia/Shanghai --cwd '/srv/My Project' --command './daily-review.sh' --json
kiteline-agent schedule run TASK_ID --json
kiteline-agent schedule status RUN_ID --json
kiteline-agent schedule output RUN_ID --stream stdout --offset 0 --json
```

### Arguments and output

- Fields for `create` and `update`: `--name`, `--command`, either `--cron EXPR` or `--at ISO_DATE`, `--cwd PATH` (an existing absolute directory path), and `--timezone IANA_ZONE`.
- By default, `update` reads the task's current revision before submitting. With `--expected-revision N`, a change since that revision produces a conflict. Read and check the task again before updating.
- `output --stream` accepts `stdout` (default) or `stderr`. `--offset` is a byte offset, and `--limit` is the number of bytes to read (range in [Limits](reference.en.md#limits)). The result's `nextOffset` is the starting point for the next read.
- `delete` asks for confirmation in a terminal; without a terminal, `--yes` is required. A task needing review also requires `--acknowledge-run RUN_ID`.
- With `--json`, standard output contains exactly one JSON object: `{"outcome":"succeeded","result":…}` on success, or `{"outcome":…,"error":{…},"taskId":…,"runId":…}` on failure. Diagnostics go to standard error. Without `--json`, the result JSON is pretty-printed.

### IDs

Task and run IDs contain letters, digits, `_` and `-`, have a length limit (see [Limits](reference.en.md#limits)), and are unique without regard to case. Callers can supply IDs with `create --task-id` and `run --run-id`; omitted IDs are generated automatically. An ID stays unchanged throughout the task or record's lifetime and is used for queries, stopping and review.

### Exit codes

| Exit code | Meaning                                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | The management operation succeeded, or the run was accepted                                                                                                     |
| 1         | The management operation definitely failed, for example because the resource is busy, the revision conflicts, the object is missing or the agent is not running |
| 2         | Incorrect usage or invalid arguments, such as an invalid Cron expression or a working directory that is not a directory                                         |
| 3         | Result unconfirmed: the request was sent but no result was received                                                                                             |

Exit code 0 from `run` or `status` does not mean the command succeeded; inspect the run's status and exit code. For exit code 3, query the `taskId` or `runId` in the output instead of immediately resending the operation.

### Let an AI CLI manage tasks

“Agent prompt” on the “Scheduled Tasks” page provides a prompt template. Choose “中文” or “English”, then click “Copy prompt”. Give it and your request to an AI CLI in the device terminal. It will read `kiteline-agent schedule --help` first, then create and manage tasks through the command line.
