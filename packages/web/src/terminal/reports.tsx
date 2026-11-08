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
