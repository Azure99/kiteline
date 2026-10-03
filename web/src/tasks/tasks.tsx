import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Bot, CalendarClock, Plus, RefreshCw } from "lucide-react";
import type {
  BrowserEvent,
  Device,
  DeviceTaskSummary,
  ScheduledTask,
} from "@kiteline/shared/protocol";
import { api } from "../lib/api";
import { currentPath, navigate, tasksPath, type TasksRoute } from "../lib/navigation";
import { webCompatible, useServerVersion } from "../lib/release";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { ErrorNotice } from "../components/error-notice";
import { scheduleSelectClass, TaskEditor } from "./task-editor";
import { TaskDetail } from "./task-detail";
import { RunDetail } from "./run-detail";
import { taskTime } from "./form";
import { TaskPrompt } from "./task-prompt";

export function TasksPage({
  devices,
  connected,
  route,
}: {
  devices: Device[];
  connected: boolean;
  route: TasksRoute;
}) {
  const { t, i18n } = useTranslation();
  const [prompt, setPrompt] = useState(false);
  const promptTrigger = useRef<HTMLButtonElement>(null);
  const serverVersion = useServerVersion();
  const [summaries, setSummaries] = useState<DeviceTaskSummary[]>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [editor, setEditor] = useState<{
    deviceId?: string;
    task?: ScheduledTask;
    origin: string;
    filter?: string;
  }>();
  const request = useRef<AbortController>(undefined);
  const refresh = useCallback(async () => {
    request.current?.abort();
    if (!connected || document.hidden || !webCompatible()) return;
    const abort = new AbortController();
    request.current = abort;
    setLoading(true);
    try {
      const next = await api<{ devices: DeviceTaskSummary[] }>("/api/tasks", {
        signal: abort.signal,
      });
      if (!abort.signal.aborted) {
        setSummaries(next.devices);
        setFresh(true);
        setError(undefined);
      }
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause);
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }, [connected]);
  useEffect(() => {
    setFresh(false);
    const changed = (event: Event) => {
      const message = (event as CustomEvent<BrowserEvent>).detail;
      if (message.type === "tasks.changed" || message.type === "devices.changed") void refresh();
    };
    const visible = () => {
      void refresh();
    };
    void refresh();
    window.addEventListener("kiteline:event", changed);
    window.addEventListener("kiteline:connected", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      request.current?.abort();
      window.removeEventListener("kiteline:event", changed);
      window.removeEventListener("kiteline:connected", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, serverVersion]);
  const selected = devices.find((d) => d.id === route.deviceId);
  const summary = summaries?.find((s) => s.deviceId === route.deviceId);
  const available = connected && fresh && webCompatible();
  const storageError = summary?.snapshot?.storageError;
  const unavailableDevices = devices
    .filter((device) => {
      const group = summaries?.find((item) => item.deviceId === device.id);
      return !group?.current || group.snapshot?.storageError;
    })
    .map((device) => device.id);
  const online =
    available && selected?.status === "online" && summary?.current === true && !storageError;
  const hasDetail = !!route.deviceId && !!route.taskId;
  const origin = currentPath();
  function select(next: TasksRoute) {
    navigate(tasksPath(next));
  }
  function selectRun(runId: string) {
    if (currentPath() === origin) select({ ...route, runId });
  }
  const filtered = devices.filter((d) => !route.filter || d.id === route.filter);
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t(($) => $.schedules.title)}>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <CalendarClock className="shrink-0 text-muted-foreground" size={18} />
        <h1 className="min-w-0 flex-1 text-base font-semibold">{t(($) => $.schedules.title)}</h1>
        <IconButton
          label={t(($) => $.common.refresh)}
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw />
        </IconButton>
        <Button
          disabled={
            !available ||
            !devices.some((d) => d.status === "online" && !unavailableDevices.includes(d.id))
          }
          onClick={() => setEditor({ deviceId: route.filter, origin, filter: route.filter })}
        >
          <Plus />
          {t(($) => $.schedules.newTask)}
        </Button>
      </header>
      {!!error && (
        <div
          role="alert"
          className="break-words border-b border-border p-3 text-sm text-destructive"
        >
          <ErrorNotice error={error} />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          className={`flex min-h-0 w-80 shrink-0 flex-col border-r border-border max-[959px]:w-full ${hasDetail ? "max-[959px]:hidden" : ""}`}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border p-3">
            <select
              className={`${scheduleSelectClass} min-w-0 flex-1`}
              aria-label={t(($) => $.schedules.device)}
              value={route.filter ?? ""}
              onChange={(e) => select({ filter: e.target.value || undefined })}
            >
              <option value="">{t(($) => $.schedules.allDevices)}</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <IconButton
              ref={promptTrigger}
              label={t(($) => $.schedules.agentPrompt)}
              onClick={() => setPrompt(true)}
            >
              <Bot />
            </IconButton>
          </div>
          <div className="scroll-area min-h-0 flex-1 overflow-auto">
            {!summaries && !error && (
              <p className="p-4 text-sm text-muted-foreground">{t(($) => $.common.loading)}</p>
            )}
            {summaries && !filtered.length && (
              <p className="p-4 text-sm text-muted-foreground">{t(($) => $.schedules.noTasks)}</p>
            )}
            {summaries &&
              filtered.map((device) => {
                const group = summaries.find((s) => s.deviceId === device.id);
                const current = available && device.status === "online" && group?.current;
                return (
                  <div key={device.id} className="border-b border-border">
                    <div className="space-y-1 bg-muted/50 px-3 py-2">
                      <p className="break-words text-xs font-medium">{device.name}</p>
                      {!current && group?.snapshot && (
                        <p className="text-xs text-muted-foreground">
                          {group?.observedAt
                            ? t(($) => $.schedules.stale, {
                                time: taskTime(group.observedAt, i18n.resolvedLanguage),
                              })
                            : t(($) => $.schedules.unobserved)}
                        </p>
                      )}
                    </div>
                    {!group?.snapshot ? (
                      <p className="p-3 text-sm text-muted-foreground">
                        {t(($) => $.schedules.unobserved)}
                      </p>
                    ) : group.snapshot.storageError ? (
                      <p role="status" className="p-3 text-sm text-destructive">
                        {t(($) => $.schedules.storageError)}
                      </p>
                    ) : !group.snapshot.items.length ? (
                      <p className="p-3 text-sm text-muted-foreground">
                        {t(($) => $.schedules.noTasks)}
                      </p>
                    ) : (
                      group.snapshot.items.map((task) => {
                        const result = task.currentRun ?? task.latestRun;
                        return (
                          <button
                            key={task.id}
                            className={`block min-h-16 w-full space-y-1 border-t border-border px-3 py-2 text-left ${route.deviceId === device.id && route.taskId === task.id ? "bg-primary-soft shadow-[inset_3px_0_var(--primary)]" : "hover:bg-muted"}`}
                            aria-current={
                              route.deviceId === device.id && route.taskId === task.id
                                ? "true"
                                : undefined
                            }
                            onClick={() =>
                              select({ filter: route.filter, deviceId: device.id, taskId: task.id })
                            }
                          >
                            <span className="block truncate text-sm font-medium" title={task.name}>
                              {task.name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {task.reviewRunId
                                ? t(($) => $.schedules.reviewRequired)
                                : t(($) => $.schedules[`state_${task.state}`])}
                              {result && (
                                <>
                                  {" · "}
                                  <span
                                    className={
                                      result.state === "failed"
                                        ? "text-destructive"
                                        : result.state === "unknown"
                                          ? "text-[#8c6515]"
                                          : undefined
                                    }
                                  >
                                    {t(($) => $.schedules[`state_${result.state}`])}
                                  </span>
                                </>
                              )}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {task.nextRunAt
                                ? t(($) => $.schedules.next, {
                                    time: taskTime(task.nextRunAt, i18n.resolvedLanguage),
                                  })
                                : t(($) => $.schedules.noNext)}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                );
              })}
          </div>
        </div>
        <div
          className={`flex min-h-0 min-w-0 flex-1 flex-col ${hasDetail ? "" : "max-[959px]:hidden"}`}
        >
          {hasDetail ? (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1">
                <IconButton
                  label={
                    route.runId ? t(($) => $.schedules.backTask) : t(($) => $.schedules.backList)
                  }
                  onClick={() =>
                    select(route.runId ? { ...route, runId: undefined } : { filter: route.filter })
                  }
                >
                  <ArrowLeft />
                </IconButton>
                <span className="min-w-0 truncate text-sm">{selected?.name ?? route.deviceId}</span>
              </div>
              {!online && !storageError && (
                <p
                  role="status"
                  className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground"
                >
                  {t(($) => $.schedules.disconnected)}
                </p>
              )}
              {storageError ? (
                <p role="status" className="p-4 text-sm text-destructive">
                  {t(($) => $.schedules.storageError)}
                </p>
              ) : route.runId ? (
                <RunDetail
                  key={`${route.deviceId}:${route.taskId}:${route.runId}`}
                  deviceId={route.deviceId!}
                  taskId={route.taskId!}
                  runId={route.runId}
                  online={online}
                />
              ) : (
                <TaskDetail
                  key={`${route.deviceId}:${route.taskId}`}
                  deviceId={route.deviceId!}
                  taskId={route.taskId!}
                  online={online}
                  revision={summary?.snapshot?.revision}
                  onEdit={(task) =>
                    setEditor({ deviceId: route.deviceId, task, origin, filter: route.filter })
                  }
                  onRun={selectRun}
                  onDelete={() => {
                    if (currentPath() === origin) select({ filter: route.filter });
                  }}
                />
              )}
            </>
          ) : (
            <p className="m-auto p-5 text-sm text-muted-foreground">
              {t(($) => $.schedules.chooseTask)}
            </p>
          )}
        </div>
      </div>
      {prompt && <TaskPrompt trigger={promptTrigger} onClose={() => setPrompt(false)} />}
      {editor && (
        <TaskEditor
          devices={devices}
          unavailableDevices={unavailableDevices}
          connected={available}
          initialDeviceId={editor.deviceId}
          task={editor.task}
          onClose={() => setEditor(undefined)}
          onSaved={(deviceId, taskId) => {
            setEditor(undefined);
            void refresh();
            if (currentPath() === editor.origin)
              select({ filter: editor.filter, deviceId, taskId });
          }}
        />
      )}
    </section>
  );
}
