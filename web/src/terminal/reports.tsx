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
  return (
    <span className="block min-w-0 max-w-sm break-words text-left">
      <span className="block font-medium">{report.name}</span>
      <span className="block text-xs text-muted-foreground">
        {t(($) => $.reports.received)} ·{" "}
        <time dateTime={new Date(report.receivedAt).toISOString()}>
          {new Date(report.receivedAt).toLocaleString(i18n.resolvedLanguage)}
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
