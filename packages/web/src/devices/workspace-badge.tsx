import { Popover } from "@base-ui/react/popover";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ProgramStatusRecord } from "@kiteline/shared/protocol";
import { ErrorNotice } from "../components/error-notice";
import { rpc } from "../lib/api";
import {
  badgeBuckets,
  badgeCounts,
  type TerminalStatus,
  type WorkspaceStatus,
} from "./workspace-status";
import { entryState, statusEntries, type StatusEntry } from "./workspace-status-entries";
import type { ReceivedReport } from "../terminal/reports";

type Translate = ReturnType<typeof useTranslation>["t"];

export function WorkspaceBadge({
  name,
  status,
  onOpen,
}: {
  name: string;
  status: WorkspaceStatus;
  onOpen(terminal: TerminalStatus): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ terminal: TerminalStatus; reading?: RecordsReading }>();
  const list = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<string | undefined>(undefined);
  const counts = badgeCounts(status);
  const present = badgeBuckets.filter((bucket) => counts[bucket]);
  const visible = present.length > 0;
  const selected = status.terminals.find(
    (terminal) => terminal.sessionId === detail?.terminal.sessionId,
  );
  useEffect(() => {
    if (!visible) {
      setOpen(false);
      setDetail(undefined);
    } else if (detail && !selected) {
      setDetail(undefined);
    }
  }, [visible, detail, selected]);
  useLayoutEffect(() => {
    if (detail || !returnFocus.current) return;
    const sessionId = returnFocus.current;
    returnFocus.current = undefined;
    // Restore within the commit so the popup's removed-element recovery does not take focus.
    list.current?.querySelector<HTMLElement>(`[data-detail="${sessionId}"]`)?.focus();
  }, [detail]);
  if (!visible) return null;
  const label = [
    name,
    ...present.map((bucket) => t(($) => $.status[`count_${bucket}`], { count: counts[bucket] })),
  ].join(" · ");
  function back(sessionId: string) {
    returnFocus.current = sessionId;
    setDetail(undefined);
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // Opening a detail is a click; a pointer drifting out while selecting must not close it.
        if (!next && selected && details.reason === "trigger-hover") {
          details.cancel();
          return;
        }
        setOpen(next);
        if (!next) setDetail(undefined);
      }}
    >
      <Popover.Trigger
        openOnHover
        delay={150}
        closeDelay={200}
        aria-label={label}
        data-stale={status.stale ? "" : undefined}
        className="workspace-badge"
      >
        {present.map((bucket) => (
          <span key={bucket} className="status-count" data-bucket={bucket}>
            {counts[bucket]}
          </span>
        ))}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="right" align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="status-popup">
            {selected ? (
              <TerminalDetail
                key={selected.sessionId}
                terminal={{ ...detail!.terminal, current: selected.current }}
                initialReading={detail!.reading}
                offline={status.offline}
                onBack={() => back(selected.sessionId)}
                onOpen={onOpen}
              />
            ) : (
              open && (
                <div ref={list}>
                  {status.offline && (
                    <p className="px-2 pb-1 text-xs text-muted-foreground">
                      {t(($) => $.common.offline)}
                    </p>
                  )}
                  {status.error !== undefined && (
                    <div className="px-2 pb-1 text-xs text-destructive" role="alert">
                      <ErrorNotice error={status.error} />
                    </div>
                  )}
                  {status.terminals.map((terminal) => (
                    <TerminalRow
                      key={terminal.sessionId}
                      terminal={terminal}
                      onOpen={onOpen}
                      onDetail={(reading) => setDetail({ terminal, reading })}
                    />
                  ))}
                </div>
              )
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function stateLabel(t: Translate, state: ProgramStatusRecord["state"]) {
  return t(($) => $.status[`level_${state}`]);
}

function entryLabel(t: Translate, lead: StatusEntry | undefined) {
  const state = entryState(lead);
  if (state === "notice") return t(($) => $.status.notice);
  return lead?.type === "program" && state === "blocked" && lead.record.kind
    ? t(($) => $.status[`kind_${lead.record.kind!}`])
    : stateLabel(t, state);
}

/** One item per terminal, with a labeled notification preview for an empty done. */
function TerminalRow({
  terminal,
  onOpen,
  onDetail,
}: {
  terminal: TerminalStatus;
  onOpen(terminal: TerminalStatus): void;
  onDetail(reading?: RecordsReading): void;
}) {
  const { t } = useTranslation();
  const reading = useRecords(terminal, { followSummary: true });
  const { lead, preview, more } = statusEntries(terminal, reading?.records);
  const pending = terminal.current && !reading;
  // A failed read leaves the summary, which looks like any other previous value; the detail
  // shows the error.
  const stale =
    (!terminal.current && Boolean(terminal.summary?.states.length)) || reading?.error !== undefined;
  const state = entryState(lead);
  const count = pending ? 0 : more;
  const lines = pending || preview || count ? 2 : 1;
  return (
    <div className="status-row" data-lines={lines} data-stale={stale ? "" : undefined}>
      <Popover.Close className="status-row-main" onClick={() => onOpen(terminal)}>
        <span className="status-row-name">{terminal.name}</span>
        <span className="status-row-state" data-level-text={state}>
          {entryLabel(t, lead)}
        </span>
        {preview && (
          <span className="status-row-preview">
            {preview.notification && (
              <span className="text-primary">
                {t(($) => $.status.notice)}{" "}
                <time dateTime={new Date(preview.notification.receivedAt).toISOString()}>
                  {clock(preview.notification.receivedAt)}
                </time>{" "}
                ·{" "}
              </span>
            )}
            {preview.text}
          </span>
        )}
      </Popover.Close>
      <button
        type="button"
        className="status-row-detail"
        data-detail={terminal.sessionId}
        aria-label={
          count
            ? t(($) => $.status.detailsMore, { name: terminal.name, count })
            : t(($) => $.status.details, { name: terminal.name })
        }
        onClick={() => onDetail(reading)}
      >
        <ChevronRight />
        {count > 0 && (
          <span title={t(($) => $.status.moreItems, { count })}>
            {t(($) => $.status.moreCount, { count })}
          </span>
        )}
      </button>
    </div>
  );
}

interface RecordsReading {
  records?: ProgramStatusRecord[];
  error?: unknown;
}

/** List changes start a new reading; a detail retains its entry reading until reconnection. */
function useRecords(
  terminal: TerminalStatus,
  {
    followSummary = false,
    initialReading,
  }: { followSummary?: boolean; initialReading?: RecordsReading } = {},
) {
  const { current, deviceId, workspaceId, sessionId } = terminal;
  const revision = followSummary
    ? JSON.stringify([
        terminal.summary?.states,
        terminal.summary?.records,
        terminal.report?.noticeId,
      ])
    : "";
  const [reading, setReading] = useState<{ revision: string; value?: RecordsReading }>(() => ({
    revision,
    value: current ? initialReading : undefined,
  }));
  const entryReading = useRef(current ? initialReading : undefined);
  useEffect(() => {
    if (!current) {
      entryReading.current = undefined;
      setReading({ revision });
      return;
    }
    if (entryReading.current) return;
    setReading({ revision });
    const controller = new AbortController();
    void rpc(deviceId, "sessions.snapshot", { workspaceId, sessionId }, controller.signal).then(
      (snapshot) => {
        if (!controller.signal.aborted && snapshot.reason !== "unchanged") {
          setReading({ revision, value: { records: snapshot.programStatus ?? [] } });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setReading({ revision, value: { error } });
      },
    );
    return () => controller.abort();
  }, [current, deviceId, workspaceId, sessionId, revision]);
  // Hide a previous summary's body in the render that schedules its replacement read.
  return current && reading.revision === revision ? reading.value : undefined;
}

function TerminalDetail({
  terminal,
  initialReading,
  offline,
  onBack,
  onOpen,
}: {
  terminal: TerminalStatus;
  initialReading?: RecordsReading;
  offline: boolean;
  onBack(): void;
  onOpen(terminal: TerminalStatus): void;
}) {
  const { t } = useTranslation();
  const reading = useRecords(terminal, { initialReading });
  const { entries } = statusEntries(terminal, reading?.records);
  const stale = !terminal.current && Boolean(terminal.summary?.states.length);
  return (
    <div className="status-detail">
      <div className="status-detail-head">
        <button
          type="button"
          className="status-back"
          aria-label={t(($) => $.status.back)}
          autoFocus
          onClick={onBack}
        >
          <ChevronLeft />
        </button>
        <span className="min-w-0 flex-1 truncate font-medium">{terminal.name}</span>
        {(offline || stale) && (
          <span className="text-xs text-muted-foreground">
            {offline ? t(($) => $.common.offline) : t(($) => $.status.previous)}
          </span>
        )}
        <Popover.Close className="status-open" onClick={() => onOpen(terminal)}>
          {t(($) => $.status.openTerminal)}
        </Popover.Close>
      </div>
      {reading?.error !== undefined && (
        <div className="px-2 text-xs text-destructive" role="alert">
          <ErrorNotice error={reading.error} />
        </div>
      )}
      {entries.map((entry) => {
        if (entry.type === "summary")
          return (
            <section key="summary" className="status-record" data-stale={stale ? "" : undefined}>
              <p className="text-xs">
                {entry.states.map((state) => (
                  <span key={state} className="mr-2" data-level-text={state}>
                    {stateLabel(t, state)}
                  </span>
                ))}
              </p>
            </section>
          );
        if (entry.type === "report")
          return (
            <section key="report" className="status-record">
              <ReportLine report={entry.report} />
              {entry.report.notice.title && (
                <p className="font-medium">{entry.report.notice.title}</p>
              )}
              {entry.report.notice.body && (
                <StatusMessage
                  name={entry.report.notice.title || terminal.name}
                  text={entry.report.notice.body}
                />
              )}
            </section>
          );
        const { record } = entry;
        return (
          <section key={`program:${record.id}`} className="status-record">
            <p className="text-xs" data-level-text={record.state}>
              {entryLabel(t, entry)}
              {record.progress !== undefined && ` ${record.progress}%`}
              {entry.app && <span className="text-muted-foreground"> · {entry.app}</span>}
            </p>
            {record.title && <p className="font-medium">{record.title}</p>}
            {entry.report && <ReportLine report={entry.report} />}
            {record.msg && <StatusMessage name={record.title || terminal.name} text={record.msg} />}
          </section>
        );
      })}
    </div>
  );
}

/** The historical notification's kind and server receipt time. */
function ReportLine({ report }: { report: ReceivedReport }) {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-muted-foreground">
      {t(($) => (report.notice.blocked ? $.status.noticeBlocked : $.status.notice))}{" "}
      <time dateTime={new Date(report.receivedAt).toISOString()}>{clock(report.receivedAt)}</time>
    </p>
  );
}

function StatusMessage({ name, text }: { name: string; text: string }) {
  const { t } = useTranslation();
  const message = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = message.current!;
    let previousWidth = -1;
    function fitHeight() {
      const width = element.clientWidth;
      if (width === previousWidth) return;
      previousWidth = width;
      element.style.height = "0px";
      element.style.height = `${element.scrollHeight}px`;
    }
    fitHeight();
    const observer = new ResizeObserver(fitHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <textarea
      ref={message}
      className="status-message"
      aria-label={t(($) => $.status.details, { name })}
      readOnly
      rows={1}
      wrap="soft"
      value={text}
    />
  );
}

function clock(time: number) {
  const value = new Date(time);
  const sameDay = value.toDateString() === new Date().toDateString();
  const hm = value.toTimeString().slice(0, 5);
  return sameDay ? hm : `${value.getMonth() + 1}-${value.getDate()} ${hm}`;
}
