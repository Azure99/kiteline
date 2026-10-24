import type { BrowserEvent } from "@kiteline/shared/protocol";
import { useTranslation } from "react-i18next";

export type ReceivedReport = Extract<BrowserEvent, { type: "terminal.notice" }>;
export { reportKey } from "@kiteline/shared/protocol";

export function ReportMark() {
  const { t } = useTranslation();
  // A plain element keeps its size inside buttons and menu items, which resize every svg.
  return (
    <span
      role="img"
      aria-label={t(($) => $.reports.pending)}
      className="size-2 shrink-0 rounded-full bg-primary"
    />
  );
}

export function ReportSummary({ report }: { report: ReceivedReport }) {
  const { t } = useTranslation();
  const text =
    report.notice.title ||
    report.notice.body ||
    t(($) => (report.notice.blocked ? $.reports.blocked : $.reports.notification));
  return (
    <span className="max-w-60 truncate text-xs text-muted-foreground" title={text}>
      {text}
    </span>
  );
}

export function ReportContent({ report }: { report: ReceivedReport }) {
  const { t, i18n } = useTranslation();
  const received = new Date(report.receivedAt);
  const sameDay = received.toDateString() === new Date().toDateString();
  const time = received.toTimeString().slice(0, 5);
  const date = `${String(received.getMonth() + 1).padStart(2, "0")}-${String(received.getDate()).padStart(2, "0")}`;
  return (
    <span className="block min-w-0 max-w-sm break-words text-left">
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{report.name}</span>
        <time
          className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
          dateTime={received.toISOString()}
          title={received.toLocaleString(i18n.resolvedLanguage)}
        >
          {sameDay ? time : `${date} ${time}`}
        </time>
      </span>
      <span className="block text-xs text-muted-foreground">
        {t(($) => (report.notice.blocked ? $.reports.blocked : $.reports.notification))}
      </span>
      {report.notice.title && <span className="block">{report.notice.title}</span>}
      {report.notice.body && (
        <span className="block whitespace-pre-wrap break-words text-muted-foreground">
          {report.notice.body}
        </span>
      )}
    </span>
  );
}
