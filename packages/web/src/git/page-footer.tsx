import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "../components/icon-button";

export function PageFooter({
  summary,
  previousLabel,
  previousDisabled,
  onPrevious,
  nextLabel,
  nextDisabled,
  onNext,
}: {
  summary: ReactNode;
  previousLabel: string;
  previousDisabled: boolean;
  onPrevious: () => void;
  nextLabel: string;
  nextDisabled: boolean;
  onNext: () => void;
}) {
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-1 border-t border-border px-3 text-xs text-muted-foreground">
      <span className="mr-auto">{summary}</span>
      <IconButton label={previousLabel} disabled={previousDisabled} onClick={onPrevious}>
        <ChevronLeft />
      </IconButton>
      <IconButton label={nextLabel} disabled={nextDisabled} onClick={onNext}>
        <ChevronRight />
      </IconButton>
    </div>
  );
}
