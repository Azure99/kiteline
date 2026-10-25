import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";
import type { DiskText } from "./content";
import { ReadOnlyReader, type ReadOnlyReaderHandle } from "./read-only-reader";

export function DiskReader({ disk }: { disk: DiskText }) {
  const { t } = useTranslation();
  const reader = useRef<ReadOnlyReaderHandle>(null);
  return (
    <section className="flex h-[206px] min-h-0 min-w-0 shrink-0 flex-col overflow-hidden rounded border border-border max-desk:h-[302px]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t(($) => $.files.diskSnapshot)}
        </span>
        <Button variant="outline" onClick={() => reader.current?.openSearch()}>
          {t(($) => $.files.findInReading)}
        </Button>
      </div>
      <ReadOnlyReader
        ref={reader}
        text={disk.text}
        path={disk.target.path}
        label={t(($) => $.files.diskText)}
      />
    </section>
  );
}
