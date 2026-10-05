import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { ErrorNotice } from "../components/error-notice";
import { browserLanguage, type Language } from "../i18n";
import { useCopyFeedback } from "../lib/use-copy-feedback";

export function TaskPrompt({
  onClose,
  trigger,
}: {
  onClose(): void;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const { t, i18n } = useTranslation();
  const [language, setLanguage] = useState<Language>(() =>
    browserLanguage(i18n.resolvedLanguage ?? "en"),
  );
  const { copied, error, pending, copy } = useCopyFeedback();
  const text = t(($) => $.schedules.promptTemplate, { lng: language });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent finalFocus={trigger}>
        <DialogHeader>
          <DialogTitle>{t(($) => $.schedules.agentPrompt)}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4">
          <div
            className="flex gap-1"
            role="group"
            aria-label={t(($) => $.schedules.promptLanguage)}
          >
            <Button
              variant={language === "zh-CN" ? "outline" : "ghost"}
              aria-pressed={language === "zh-CN"}
              onClick={() => setLanguage("zh-CN")}
            >
              中文
            </Button>
            <Button
              variant={language === "en" ? "outline" : "ghost"}
              aria-pressed={language === "en"}
              onClick={() => setLanguage("en")}
            >
              English
            </Button>
          </div>
          <Textarea
            readOnly
            rows={6}
            lang={language}
            value={text}
            aria-label={t(($) => $.schedules.promptText)}
            className="min-h-28 resize-none bg-muted/40 p-3"
          />
          {error?.id === text && (
            <p role="alert" className="break-words text-sm text-destructive">
              {t(($) => $.schedules.promptCopyFailed)} <ErrorNotice error={error.error} />
            </p>
          )}
        </div>
        <DialogFooter>
          <span role="status" className="min-w-0 flex-1 text-sm">
            {copied === text ? t(($) => $.common.copied) : ""}
          </span>
          <Button
            disabled={pending}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void copy(text)}
          >
            <Copy />
            {t(($) => $.schedules.copyPrompt)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
