import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Device, ScheduledTask, ScheduledTaskInput } from "@kiteline/shared/protocol";
import { Save } from "lucide-react";
import { ApiError, rpc } from "../lib/api";
import { newId } from "../lib/id";
import { ErrorNotice } from "../components/error-notice";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { formSchedule, scheduleForm, taskChanges, taskTime, type SchedulePreset } from "./form";

export const scheduleSelectClass =
  "min-h-9 w-full min-w-0 rounded border border-border bg-background px-2 text-sm max-[959px]:min-h-11";

export function TaskEditor({
  devices,
  unavailableDevices,
  connected,
  initialDeviceId,
  task,
  onClose,
  onSaved,
}: {
  devices: Device[];
  unavailableDevices: string[];
  connected: boolean;
  initialDeviceId?: string;
  task?: ScheduledTask;
  onClose: () => void;
  onSaved: (deviceId: string, taskId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [deviceId, setDeviceId] = useState(
    initialDeviceId ??
      devices.find((d) => d.status === "online" && !unavailableDevices.includes(d.id))?.id ??
      "",
  );
  const device = devices.find((d) => d.id === deviceId);
  const enabled =
    connected && device?.status === "online" && !unavailableDevices.includes(deviceId);
  const [taskId] = useState(() => task?.id ?? newId());
  const [baseline, setBaseline] = useState(task);
  const [name, setName] = useState(task?.name ?? "");
  const [command, setCommand] = useState(task?.command ?? "");
  const [cwd, setCwd] = useState(task?.cwd ?? "");
  const [timezone, setTimezone] = useState(task?.timezone ?? "");
  const [form, setForm] = useState(() => scheduleForm(task?.schedule));
  const [preview, setPreview] = useState<{ timezone: string; nextRunAts: string[] }>();
  const [previewError, setPreviewError] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [current, setCurrent] = useState<ScheduledTask>();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const parsed = useMemo(() => {
    try {
      return { schedule: formSchedule(form, task?.schedule) };
    } catch (error) {
      return { error };
    }
  }, [form, task?.schedule]);
  useEffect(() => {
    const abort = new AbortController();
    setPreview(undefined);
    setPreviewError(undefined);
    if (!parsed.schedule || !enabled) return;
    const schedule = parsed.schedule;
    if (
      baseline?.schedule &&
      JSON.stringify(baseline?.schedule) === JSON.stringify(schedule) &&
      schedule.kind === "once" &&
      new Date(schedule.at).valueOf() <= Date.now()
    ) {
      setPreview({ timezone: timezone || baseline.timezone, nextRunAts: [] });
      return;
    }
    const timer = setTimeout(() => {
      void rpc(
        deviceId,
        "tasks.preview",
        { schedule, timezone: timezone || undefined },
        abort.signal,
      )
        .then((result) => {
          if (!abort.signal.aborted) setPreview(result);
        })
        .catch((cause: unknown) => {
          if (!abort.signal.aborted) setPreviewError(cause);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [deviceId, enabled, parsed.schedule, timezone, baseline?.schedule, baseline?.timezone]);
  const unknown = uncertain;
  async function save() {
    if (!parsed.schedule || !enabled || busy || unknown) return;
    setBusy(true);
    setError(undefined);
    try {
      if (baseline && !cwd) throw new ApiError("invalid_argument", "Working directory is required");
      const input: ScheduledTaskInput = {
        name,
        command,
        cwd: cwd || undefined,
        timezone: timezone || preview?.timezone,
        schedule: parsed.schedule,
      };
      if (baseline)
        await rpc(deviceId, "tasks.update", {
          taskId,
          expectedRevision: baseline.revision,
          changes: taskChanges(baseline, input),
        });
      else await rpc(deviceId, "tasks.create", { taskId, input });
      if (alive.current) onSaved(deviceId, taskId);
    } catch (cause) {
      if (alive.current) {
        setError(cause);
        if (cause instanceof ApiError && cause.outcome === "unknown") setUncertain(true);
        if (cause instanceof ApiError && cause.code === "conflict") setConflict(true);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function readCurrent() {
    setBusy(true);
    try {
      const result = await rpc(deviceId, "tasks.get", { taskId });
      if (!alive.current) return;
      setBaseline(result);
      setCurrent(result);
      if (!baseline) {
        if (!cwd) setCwd(result.cwd);
        if (!timezone) setTimezone(result.timezone);
      }
      setUncertain(false);
      setConflict(false);
      setError(undefined);
    } catch (cause) {
      if (alive.current) setError(cause);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {task ? t(($) => $.schedules.editTask) : t(($) => $.schedules.newTask)}
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="scroll-area min-h-0 overflow-auto p-5">
            <fieldset disabled={busy || unknown} className="min-w-0 space-y-4">
              <label className="block space-y-1 text-sm">
                <span>{t(($) => $.schedules.device)}</span>
                <select
                  className={scheduleSelectClass}
                  value={deviceId}
                  disabled={!!baseline}
                  required
                  onChange={(event) => {
                    setDeviceId(event.target.value);
                    setTimezone("");
                  }}
                >
                  <option value="" disabled>
                    {t(($) => $.schedules.device)}
                  </option>
                  {devices.map((d) => (
                    <option
                      key={d.id}
                      value={d.id}
                      disabled={d.status !== "online" || unavailableDevices.includes(d.id)}
                    >
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-sm">
                <span>{t(($) => $.common.name)}</span>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={256}
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>{t(($) => $.schedules.schedule)}</span>
                <select
                  className={scheduleSelectClass}
                  value={form.preset}
                  onChange={(e) => setForm({ ...form, preset: e.target.value as SchedulePreset })}
                >
                  {(["once", "hourly", "daily", "weekly", "cron"] as const).map((kind) => (
                    <option key={kind} value={kind}>
                      {t(($) => $.schedules[kind])}
                    </option>
                  ))}
                </select>
              </label>
              {form.preset === "once" && (
                <label className="block space-y-1 text-sm">
                  <span>{t(($) => $.schedules.onceTime, { timezone: browserTimezone })}</span>
                  <Input
                    type="datetime-local"
                    value={form.once}
                    required
                    onChange={(e) => setForm({ ...form, once: e.target.value })}
                  />
                </label>
              )}
              {(form.preset === "daily" || form.preset === "weekly") && (
                <label className="block space-y-1 text-sm">
                  <span>{t(($) => $.schedules.time)}</span>
                  <Input
                    type="time"
                    value={form.time}
                    required
                    onChange={(e) => setForm({ ...form, time: e.target.value })}
                  />
                </label>
              )}
              {form.preset === "weekly" && (
                <label className="block space-y-1 text-sm">
                  <span>{t(($) => $.schedules.weekday)}</span>
                  <select
                    className={scheduleSelectClass}
                    value={form.weekday}
                    onChange={(e) => setForm({ ...form, weekday: e.target.value })}
                  >
                    {(["1", "2", "3", "4", "5", "6", "0"] as const).map((day) => (
                      <option key={day} value={day}>
                        {t(($) => $.schedules[`weekday_${day}`])}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {form.preset === "cron" && (
                <label className="block space-y-1 text-sm">
                  <span>{t(($) => $.schedules.cron)}</span>
                  <Input
                    className="font-mono"
                    value={form.cron}
                    required
                    onChange={(e) => setForm({ ...form, cron: e.target.value })}
                  />
                </label>
              )}
              <label className="block space-y-1 text-sm">
                <span>{t(($) => $.schedules.command)}</span>
                <Textarea
                  className="min-h-24 font-mono"
                  value={command}
                  required
                  onChange={(e) => setCommand(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <details className="text-sm">
                <summary className="min-h-9 cursor-pointer py-2">
                  {t(($) => $.schedules.advanced)}
                </summary>
                <div className="mt-2 space-y-3">
                  <label className="block space-y-1">
                    <span>{t(($) => $.schedules.cwd)}</span>
                    <Input
                      value={cwd}
                      placeholder={t(($) => $.schedules.home)}
                      onChange={(e) => setCwd(e.target.value)}
                    />
                  </label>
                  {!!device?.snapshot?.workspaces.length && (
                    <select
                      aria-label={t(($) => $.schedules.fromWorkspace)}
                      className={scheduleSelectClass}
                      value=""
                      onChange={(e) => setCwd(e.target.value)}
                    >
                      <option value="">{t(($) => $.schedules.fromWorkspace)}</option>
                      {device.snapshot.workspaces.map((w) => (
                        <option key={w.id} value={w.path}>
                          {w.name} · {w.path}
                        </option>
                      ))}
                    </select>
                  )}
                  <label className="block space-y-1">
                    <span>{t(($) => $.schedules.timezone)}</span>
                    <Input
                      value={timezone}
                      placeholder={preview?.timezone ?? t(($) => $.schedules.deviceTimezone)}
                      onChange={(e) => setTimezone(e.target.value)}
                    />
                  </label>
                </div>
              </details>
              {preview && (
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>{t(($) => $.schedules.preview, { timezone: preview.timezone })}</p>
                  {preview.nextRunAts.slice(0, 3).map((at) => (
                    <p key={at}>{taskTime(at, i18n.resolvedLanguage, preview.timezone)}</p>
                  ))}
                  {!preview.nextRunAts.length && <p>{t(($) => $.schedules.noNext)}</p>}
                </div>
              )}
              {!!(parsed.error || previewError) && (
                <div className="break-words text-sm text-destructive" role="alert">
                  <ErrorNotice error={parsed.error ?? previewError} />
                </div>
              )}
            </fieldset>
          </div>
          {!!error && (
            <div className="max-h-40 overflow-auto px-5 pb-3 text-sm text-destructive" role="alert">
              <ErrorNotice error={error} />
              {(unknown || conflict) && (
                <div className="mt-2 space-y-2">
                  <p>
                    {unknown
                      ? `${t(($) => $.schedules.taskId)}: ${taskId}`
                      : t(($) => $.schedules.conflict)}
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy || !enabled}
                    onClick={() => void readCurrent()}
                  >
                    {unknown
                      ? t(($) => $.schedules.queryResult)
                      : t(($) => $.schedules.readCurrent)}
                  </Button>
                </div>
              )}
            </div>
          )}
          {current && (
            <details className="max-h-40 overflow-auto px-5 pb-3 text-xs">
              <summary>{t(($) => $.schedules.currentDefinition)}</summary>
              <dl className="space-y-2 break-words">
                <div>
                  <dt>{t(($) => $.common.name)}</dt>
                  <dd>{current.name}</dd>
                </div>
                <div>
                  <dt>{t(($) => $.schedules.command)}</dt>
                  <dd className="whitespace-pre-wrap font-mono">{current.command}</dd>
                </div>
                <div>
                  <dt>{t(($) => $.schedules.cwd)}</dt>
                  <dd>{current.cwd}</dd>
                </div>
                <div>
                  <dt>{t(($) => $.schedules.schedule)}</dt>
                  <dd>
                    {current.schedule.kind === "cron"
                      ? current.schedule.expression
                      : taskTime(current.schedule.at, i18n.resolvedLanguage, current.timezone)}
                  </dd>
                </div>
                <div>
                  <dt>{t(($) => $.schedules.timezone)}</dt>
                  <dd>{current.timezone}</dd>
                </div>
              </dl>
            </details>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t(($) => $.common.cancel)}
            </Button>
            <Button
              type="submit"
              disabled={busy || !enabled || !parsed.schedule || unknown || !!previewError}
            >
              <Save />
              {t(($) => $.common.save)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
