import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Pause, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import type { ScheduledTask, TaskRunSummary } from "@kiteline/shared/protocol";
import { ApiError, rpc } from "../lib/api";
import { newId } from "../lib/id";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { ErrorNotice } from "../components/error-notice";
import { taskTime } from "./form";

export function TaskDetail({
  deviceId,
  taskId,
  online,
  revision,
  onEdit,
  onRun,
  onDelete,
}: {
  deviceId: string;
  taskId: string;
  online: boolean;
  revision?: number;
  onEdit: (task: ScheduledTask) => void;
  onRun: (runId: string) => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [task, setTask] = useState<ScheduledTask>();
  const [runs, setRuns] = useState<{ items: TaskRunSummary[]; total: number }>();
  const [readError, setReadError] = useState<unknown>();
  const [actionError, setActionError] = useState<unknown>();
  const [uncertainRun, setUncertainRun] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  const readRequest = useRef<AbortController>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!online) return;
    async function load() {
      readRequest.current?.abort();
      if (document.hidden) return;
      const abort = new AbortController();
      readRequest.current = abort;
      try {
        const [definition, history] = await Promise.all([
          rpc(deviceId, "tasks.get", { taskId }, abort.signal),
          rpc(deviceId, "runs.list", { taskId }, abort.signal),
        ]);
        if (abort.signal.aborted) return;
        setTask(definition);
        setRuns(history);
        setReadError(undefined);
      } catch (error) {
        if (!abort.signal.aborted) setReadError(error);
      }
    }
    void load();
    document.addEventListener("visibilitychange", load);
    return () => {
      readRequest.current?.abort();
      document.removeEventListener("visibilitychange", load);
    };
  }, [deviceId, taskId, online, revision, refresh]);
  async function more() {
    if (!runs || loadingMore) return;
    readRequest.current?.abort();
    const abort = new AbortController();
    readRequest.current = abort;
    setLoadingMore(true);
    try {
      const page = await rpc(
        deviceId,
        "runs.list",
        { taskId, offset: runs.items.length },
        abort.signal,
      );
      if (!abort.signal.aborted)
        setRuns({ items: [...runs.items, ...page.items], total: page.total });
    } catch (error) {
      if (!abort.signal.aborted) setReadError(error);
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  }
  async function act(kind: "run" | "pause" | "resume" | "acknowledge" | "delete") {
    if (!task || busy || !online) return;
    const confirmation = [
      kind === "delete" ? t(($) => $.schedules.deleteConfirm, { name: task.name }) : "",
      (kind === "delete" || kind === "acknowledge") && task.reviewRunId
        ? t(($) => $.schedules.acknowledge, { id: task.reviewRunId })
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (confirmation && !window.confirm(confirmation)) return;
    const runId = kind === "run" ? newId() : undefined;
    setBusy(true);
    setActionError(undefined);
    try {
      if (runId) {
        await rpc(deviceId, "tasks.run", { taskId, runId });
        if (alive.current) onRun(runId);
      } else if (kind === "pause") await rpc(deviceId, "tasks.pause", { taskId });
      else if (kind === "resume") await rpc(deviceId, "tasks.resume", { taskId });
      else if (kind === "acknowledge" && task.reviewRunId)
        await rpc(deviceId, "tasks.acknowledge", { taskId, runId: task.reviewRunId });
      else if (kind === "delete") {
        await rpc(deviceId, "tasks.delete", { taskId, acknowledgeRunId: task.reviewRunId });
        if (alive.current) onDelete();
      }
      if (alive.current) setRefresh((n) => n + 1);
    } catch (error) {
      if (alive.current) {
        setActionError(error);
        if (runId && error instanceof ApiError && error.outcome === "unknown")
          setUncertainRun(runId);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="scroll-area min-h-0 flex-1 space-y-4 overflow-auto p-4">
      {!!readError && (
        <div role="alert" className="break-words text-sm text-destructive">
          <ErrorNotice error={readError} />
          <Button variant="outline" disabled={!online} onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw />
            {t(($) => $.common.retry)}
          </Button>
        </div>
      )}
      {!task && !readError && (
        <p className="text-sm text-muted-foreground">
          {online ? t(($) => $.common.loading) : t(($) => $.common.deviceOffline)}
        </p>
      )}
      {task && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 flex-1 break-words text-base font-semibold">{task.name}</h2>
            <span className="text-xs text-muted-foreground">
              {task.reviewRunId
                ? t(($) => $.schedules.reviewRequired)
                : t(($) => $.schedules[`state_${task.state}`])}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              disabled={!online || busy || !!uncertainRun || !!task.reviewRunId}
              onClick={() => void act("run")}
            >
              <Play />
              {t(($) => $.schedules.run)}
            </Button>
            <IconButton
              disabled={!online || busy}
              label={
                task.reviewRunId
                  ? t(($) => $.schedules.confirmReview)
                  : task.state === "active"
                    ? t(($) => $.schedules.pause)
                    : t(($) => $.schedules.resume)
              }
              onClick={() =>
                void act(
                  task.reviewRunId ? "acknowledge" : task.state === "active" ? "pause" : "resume",
                )
              }
            >
              {task.reviewRunId ? <Check /> : task.state === "active" ? <Pause /> : <Play />}
            </IconButton>
            <IconButton
              disabled={!online || busy}
              label={t(($) => $.schedules.editTask)}
              onClick={() => onEdit(task)}
            >
              <Pencil />
            </IconButton>
            <IconButton
              disabled={!online || busy}
              label={t(($) => $.common.delete)}
              onClick={() => void act("delete")}
            >
              <Trash2 />
            </IconButton>
          </div>
          {task.reviewRunId && (
            <p role="status" className="text-sm text-destructive">
              {t(($) => $.schedules.pendingReview)}{" "}
              <button
                className="break-all underline"
                onClick={() => task.reviewRunId && onRun(task.reviewRunId)}
              >
                {task.reviewRunId}
              </button>
            </p>
          )}
          {!!actionError && (
            <div role="alert" className="break-words text-sm text-destructive">
              <ErrorNotice error={actionError} />
              {!uncertainRun &&
                actionError instanceof ApiError &&
                actionError.outcome === "unknown" && (
                  <Button
                    variant="outline"
                    disabled={!online}
                    onClick={() => {
                      setActionError(undefined);
                      setRefresh((n) => n + 1);
                    }}
                  >
                    {t(($) => $.schedules.queryResult)}
                  </Button>
                )}
            </div>
          )}
          {uncertainRun && (
            <div className="space-y-2 text-sm">
              <p className="break-all">
                {t(($) => $.schedules.runId)}: {uncertainRun}
              </p>
              <Button variant="outline" onClick={() => onRun(uncertainRun)}>
                {t(($) => $.schedules.queryResult)}
              </Button>
            </div>
          )}
          <div className="space-y-2 text-xs text-muted-foreground">
            <p className="break-words">
              {task.nextRunAt
                ? t(($) => $.schedules.next, {
                    time: taskTime(task.nextRunAt, i18n.resolvedLanguage, task.timezone),
                  })
                : t(($) => $.schedules.noNext)}
              {task.onceStatus && ` · ${t(($) => $.schedules[`once_${task.onceStatus!}`])}`}
            </p>
            <p className="break-all">
              {task.schedule.kind === "cron"
                ? task.schedule.expression
                : taskTime(task.schedule.at, i18n.resolvedLanguage, task.timezone)}{" "}
              · {task.timezone}
            </p>
            <p className="break-all">
              {t(($) => $.schedules.cwd)}: {task.cwd}
            </p>
            <p className="break-all">
              {t(($) => $.schedules.taskId)}: {task.id}
            </p>
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted p-3 text-sm">
            {task.command}
          </pre>
          <section aria-label={t(($) => $.schedules.runs)}>
            <h3 className="mb-2 text-sm font-medium">{t(($) => $.schedules.runs)}</h3>
            <div className="divide-y divide-border border-y border-border">
              {runs?.items.map((run) => (
                <button
                  key={run.id}
                  className="flex min-h-12 w-full items-center gap-2 py-2 text-left hover:bg-muted"
                  onClick={() => onRun(run.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">
                      {taskTime(run.acceptedAt, i18n.resolvedLanguage, task.timezone)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(($) => $.schedules[run.trigger])} ·{" "}
                      {t(($) => $.schedules[`state_${run.state}`])}
                    </span>
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
            {runs?.items.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">{t(($) => $.schedules.noRuns)}</p>
            )}
            {runs && runs.items.length < runs.total && (
              <Button variant="ghost" disabled={!online || loadingMore} onClick={() => void more()}>
                {t(($) => $.common.more)}
              </Button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
