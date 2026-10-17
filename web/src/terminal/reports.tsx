import type { BrowserEvent } from "@kiteline/shared/protocol";
import { useTranslation } from "react-i18next";

export type ReceivedReport = Extract<BrowserEvent, { type: "terminal.notice" }> & {
  receivedAt: number;
};

export function reportKey(source: Pick<ReceivedReport, "deviceId" | "workspaceId" | "sessionId">) {
  return JSON.stringify([source.deviceId, source.workspaceId, source.sessionId]);
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
      {report.notice.title && <span className="block">{report.notice.title}</span>}
      <span className="block whitespace-pre-wrap break-all text-muted-foreground">
        {report.notice.body ||
          (!report.notice.title &&
            t(($) => (report.notice.blocked ? $.reports.blocked : $.reports.notification)))}
      </span>
    </span>
  );
}
