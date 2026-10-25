import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs } from "@base-ui/react/tabs";
import { Copy, RefreshCw, Square } from "lucide-react";
import { taskRunActive, type TaskRun } from "@kiteline/shared/protocol";
import { ApiError, rpc } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { ErrorNotice } from "../components/error-notice";
import { taskTime } from "./form";
import { outputText } from "./output-text";

type Stream = "stdout" | "stderr";
type Output = { chunks: { offset: number; text: string }[]; nextOffset: number; carry: string };

export function RunDetail({
  deviceId,
  taskId,
  runId,
  online,
}: {
  deviceId: string;
  taskId: string;
  runId: string;
  online: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [run, setRun] = useState<TaskRun>();
  const [error, setError] = useState<unknown>();
  const [actionError, setActionError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [stream, setStream] = useState<Stream>("stdout");
  const stderrTab = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<Stream>();
  const [outputChanged, setOutputChanged] = useState(false);
  const outputs = useRef<Record<Stream, Output>>({
    stdout: { chunks: [], nextOffset: 0, carry: "" },
    stderr: { chunks: [], nextOffset: 0, carry: "" },
  });
  const [output, setOutput] = useState(outputs.current);
  useEffect(() => {
    if (!online) return;
    let disposed = false,
      inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    let abort = new AbortController();
    async function poll() {
      if (disposed || document.hidden || inFlight) return;
      inFlight = true;
      abort = new AbortController();
      let again = true,
        more = false;
      try {
        const next = await rpc(deviceId, "runs.get", { runId }, abort.signal);
        if (next.taskId !== taskId)
          throw new ApiError("not_found", "Run does not belong to this task");
        if (disposed || abort.signal.aborted) return;
        setRun(next);
        let complete = true;
        for (const name of ["stdout", "stderr"] as const) {
          const previous = outputs.current[name];
          const storedBytes = next.output[name === "stdout" ? "stdoutBytes" : "stderrBytes"];
          const piece = await rpc(
            deviceId,
            "runs.output",
            {
              runId,
              stream: name,
              offset: storedBytes < previous.nextOffset ? 0 : previous.nextOffset,
            },
            abort.signal,
          );
          if (disposed || abort.signal.aborted) return;
          const reset = piece.offset !== previous.nextOffset;
          if (reset) setOutputChanged(true);
          const final = piece.finished && piece.nextOffset >= piece.storedBytes;
          if (piece.text || reset || (final && previous.carry)) {
            const clean = outputText(reset ? "" : previous.carry, piece.text, final);
            outputs.current = {
              ...outputs.current,
              [name]: {
                chunks: [
                  ...(reset ? [] : previous.chunks),
                  ...(clean.text ? [{ offset: piece.offset, text: clean.text }] : []),
                ],
                nextOffset: piece.nextOffset,
                carry: clean.carry,
              },
            };
            setOutput(outputs.current);
          }
          if (!final) complete = false;
          if (piece.nextOffset < piece.storedBytes && piece.nextOffset > piece.offset) more = true;
        }
        again = taskRunActive(next.state) || !complete;
        setError(undefined);
      } catch (cause) {
        if (!disposed && !abort.signal.aborted) {
          setError(cause);
          if (cause instanceof ApiError && cause.code === "not_found") again = false;
        }
      } finally {
        inFlight = false;
        if (!disposed && !document.hidden && again)
          timer = setTimeout(() => void poll(), more ? 0 : outputPollMs);
      }
    }
    function visibility() {
      clearTimeout(timer);
      if (document.hidden) abort.abort();
      else void poll();
    }
    void poll();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [deviceId, taskId, runId, online, refresh]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  async function stop() {
    if (!online || busy || !window.confirm(t(($) => $.schedules.stopConfirm))) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await rpc(deviceId, "runs.stop", { runId });
    } catch (cause) {
      setActionError(cause);
    } finally {
      setBusy(false);
      setRefresh((n) => n + 1);
    }
  }
  async function copy() {
    try {
      await copyText(output[stream].chunks.map((chunk) => chunk.text).join(""));
      setCopied(stream);
    } catch (cause) {
      setActionError(cause);
    }
  }
  const notStarted = run?.state === "skipped" || run?.reasonCode === "start_failed";
  const missing = error instanceof ApiError && error.code === "not_found";
  return (
    <Tabs.Root
      value={stream}
      onValueChange={(value) => setStream(value as Stream)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="scroll-area max-h-[45%] shrink-0 space-y-2 overflow-auto border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
            {t(($) => $.schedules.runId)}: {runId}
          </span>
          <IconButton
            label={t(($) => $.common.refresh)}
            disabled={!online}
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw />
          </IconButton>
          {run && taskRunActive(run.state) && (
            <Button variant="outline" disabled={!online || busy} onClick={() => void stop()}>
              <Square />
              {t(($) => $.schedules.stop)}
            </Button>
          )}
        </div>
        {run && (
          <>
            <h2 className="break-words text-base font-semibold">{run.parameters.name}</h2>
            <div className="flex flex-wrap gap-3 text-sm">
              <strong>{t(($) => $.schedules[`state_${run.state}`])}</strong>
              <span>{t(($) => $.schedules[run.trigger])}</span>
              {run.exitCode != null && (
                <span>{t(($) => $.schedules.exit, { code: run.exitCode })}</span>
              )}
              {run.signal && <span>{t(($) => $.schedules.signal, { signal: run.signal })}</span>}
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                {t(($) => $.schedules.accepted)}: {taskTime(run.acceptedAt, i18n.resolvedLanguage)}
              </p>
              {run.startedAt && (
                <p>
                  {t(($) => $.schedules.started)}: {taskTime(run.startedAt, i18n.resolvedLanguage)}
                </p>
              )}
              {run.endedAt && (
                <p>
                  {t(($) => $.schedules.ended)}: {taskTime(run.endedAt, i18n.resolvedLanguage)}
                </p>
              )}
              {run.reasonCode && <p>{t(($) => $.schedules[`reason_${run.reasonCode!}`])}</p>}
            </div>
            <details className="text-xs">
              <summary className="min-h-9 cursor-pointer py-2">
                {t(($) => $.schedules.runParameters)}
              </summary>
              <p className="break-all">{run.parameters.cwd}</p>
              <pre className="whitespace-pre-wrap break-words py-2">{run.parameters.command}</pre>
              {run.pid !== undefined && <p>PID: {run.pid}</p>}
            </details>
            {notStarted && run.reasonCode !== "start_failed" && (
              <p role="status" className="text-sm">
                {t(($) => $.schedules.commandNotStarted)}
              </p>
            )}
            {run.output.truncated && (
              <p role="status" className="text-sm text-destructive">
                {t(($) => $.schedules.truncated)}
              </p>
            )}
            {run.output.error && (
              <p role="status" className="text-sm text-destructive">
                {t(($) => $.schedules.outputError)}
              </p>
            )}
            {(run.diagnostic || run.output.error) && (
              <pre className="whitespace-pre-wrap break-words text-xs text-destructive">
                {[run.diagnostic, run.output.error].filter(Boolean).join("\n")}
              </pre>
            )}
          </>
        )}
        {!!(error || actionError) && (
          <div role="alert" className="break-words text-sm text-destructive">
            {missing && <p>{t(($) => $.schedules.missingRun)}</p>}
            <ErrorNotice error={actionError ?? error} />
          </div>
        )}
        {outputChanged && (
          <p role="status" className="text-sm text-muted-foreground">
            {t(($) => $.schedules.outputChanged)}
          </p>
        )}
        {!run && !error && online && (
          <p className="text-sm text-muted-foreground">{t(($) => $.common.loading)}</p>
        )}
      </div>
      {!notStarted && (
        <>
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3">
            <Tabs.List className="flex gap-1" aria-label={t(($) => $.schedules.runs)}>
              {(["stdout", "stderr"] as const).map((name) => (
                <Tabs.Tab
                  key={name}
                  ref={name === "stderr" ? stderrTab : undefined}
                  value={name}
                  render={<Button variant={stream === name ? "outline" : "ghost"} />}
                >
                  <span className="flex flex-col items-start">
                    <span>{name}</span>
                    {run && (
                      <span className="text-xs font-normal text-muted-foreground">
                        {t(($) => $.schedules.retainedOutputBytes, {
                          bytes: run.output[name === "stdout" ? "stdoutBytes" : "stderrBytes"],
                        })}
                      </span>
                    )}
                  </span>
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <span className="flex-1" />
            <span role="status" className="text-xs text-muted-foreground">
              {copied === stream ? t(($) => $.common.copied) : ""}
            </span>
            <IconButton
              label={t(($) => $.common.copy)}
              disabled={!output[stream].chunks.length}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => void copy()}
            >
              <Copy />
            </IconButton>
          </div>
          {(["stdout", "stderr"] as const).map((name) => (
            <Tabs.Panel
              key={name}
              value={name}
              keepMounted
              tabIndex={-1}
              className={stream === name ? "flex min-h-0 flex-1 flex-col" : "hidden"}
            >
              <OutputText
                hidden={stream !== name}
                chunks={output[name].chunks}
                truncated={run?.output.truncated === true && !run.output.error}
                empty={
                  <>
                    {t(($) => $.schedules.noOutput, { stream: name })}
                    {name === "stdout" && output.stderr.chunks.length > 0 && (
                      <>
                        <br />
                        <Button
                          variant="outline"
                          className="mt-3 font-sans"
                          onClick={() => {
                            setStream("stderr");
                            stderrTab.current?.focus();
                          }}
                        >
                          {t(($) => $.schedules.viewStderr)}
                        </Button>
                      </>
                    )}
                  </>
                }
              />
            </Tabs.Panel>
          ))}
        </>
      )}
    </Tabs.Root>
  );
}

function OutputText({
  chunks,
  hidden,
  empty,
  truncated,
}: {
  chunks: Output["chunks"];
  hidden: boolean;
  empty: ReactNode;
  truncated: boolean;
}) {
  const { t } = useTranslation();
  const element = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);
  useLayoutEffect(() => {
    if (!hidden && following && window.getSelection()?.isCollapsed !== false && element.current)
      element.current.scrollTop = element.current.scrollHeight;
  }, [chunks, hidden, following, truncated]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <pre
        ref={element}
        hidden={hidden}
        tabIndex={0}
        className="scroll-area min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-sm"
        onScroll={(e) => {
          const el = e.currentTarget;
          const next = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (next !== following) setFollowing(next);
        }}
      >
        {chunks.length ? (
          chunks.map((chunk) => <span key={chunk.offset}>{chunk.text}</span>)
        ) : (
          <span className="text-muted-foreground">{empty}</span>
        )}
        {truncated && (
          <span className="block pt-4 font-sans text-xs text-muted-foreground">
            {t(($) => $.schedules.truncated)}
          </span>
        )}
      </pre>
      {!following && (
        <Button
          variant="outline"
          className="absolute right-4 bottom-3 shadow"
          onClick={() => {
            setFollowing(true);
            if (element.current) element.current.scrollTop = element.current.scrollHeight;
          }}
        >
          {t(($) => $.schedules.followLatest)}
        </Button>
      )}
    </div>
  );
}

const outputPollMs = 2000;
