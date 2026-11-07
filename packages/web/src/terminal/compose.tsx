import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { ErrorNotice } from "../components/error-notice";
import { appModifier } from "../lib/app-modifier";
import { cn } from "../lib/utils";
import type { ComposeDrafts } from "./compose-drafts";

export function isComposeShortcut(event: KeyboardEvent | React.KeyboardEvent) {
  return event.key === "Enter" && event.shiftKey && (event.ctrlKey || event.metaKey);
}

const Drafts = createContext<ComposeDrafts | undefined>(undefined);

export function ComposeProvider({
  drafts,
  children,
}: {
  drafts: ComposeDrafts;
  children: ReactNode;
}) {
  return <Drafts.Provider value={drafts}>{children}</Drafts.Provider>;
}

export function useComposeDraft(deviceId: string, workspaceId: string, sessionId: string) {
  const drafts = useContext(Drafts)!;
  const draft = drafts.get({ deviceId, workspaceId, sessionId });
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot);
  return { draft, ...state };
}

export function ComposePanel({
  deviceId,
  workspaceId,
  sessionId,
  sessionName,
  mobile,
  available,
  editor,
  onClose,
}: {
  deviceId: string;
  workspaceId: string;
  sessionId: string;
  sessionName: string;
  mobile: boolean;
  available: boolean;
  editor: RefObject<HTMLTextAreaElement | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { draft, text, sending, error } = useComposeDraft(deviceId, workspaceId, sessionId);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = editor.current;
    if (!element || mobile) return;
    // The panel grows over the terminal without changing its grid size.
    element.style.height = "auto";
    const limit = (panel.current?.parentElement?.clientHeight ?? 600) * 0.5;
    element.style.height = `${Math.min(element.scrollHeight + 2, limit)}px`;
  }, [text, mobile, editor]);

  useLayoutEffect(() => {
    const element = editor.current;
    if (element && element.value === draft.snapshot().text)
      element.setSelectionRange(...draft.selection);
  }, [draft, editor]);

  async function send(enter: boolean) {
    if (!available) return;
    const delivered = await draft.send(enter);
    // Keep later edits open; a closed panel must not close a later instance either.
    if (delivered && panel.current && !draft.snapshot().text) onClose();
  }

  return (
    <div
      ref={panel}
      className={cn(
        "absolute z-20 flex flex-col bg-background text-foreground",
        mobile ? "inset-0" : "inset-x-2 bottom-2 mx-auto max-w-[960px] rounded-md border shadow-lg",
      )}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          void send(true);
        }
      }}
    >
      <textarea
        ref={editor}
        aria-label={t(($) => $.terminal.composeLabel, { name: sessionName })}
        className={cn(
          "min-h-0 w-full resize-none bg-transparent px-3 py-2 font-mono text-[13px] leading-5 outline-none max-desk:text-base",
          mobile && "flex-1",
        )}
        rows={3}
        spellCheck={false}
        value={text}
        onChange={(event) =>
          draft.setText(event.target.value, [
            event.target.selectionStart,
            event.target.selectionEnd,
          ])
        }
        onSelect={(event) => {
          draft.selection = [event.currentTarget.selectionStart, event.currentTarget.selectionEnd];
        }}
      />
      {!!error && (
        <div role="alert" className="max-h-24 overflow-auto px-3 text-xs text-destructive">
          <ErrorNotice error={error} />
        </div>
      )}
      <div className="flex shrink-0 items-center justify-end gap-1 border-t px-1 py-1">
        <Button
          variant="ghost"
          className="min-h-7 px-2.5 py-1"
          title={t(($) => $.terminal.composeInsertHint)}
          disabled={!text || sending || !available}
          onClick={() => void send(false)}
        >
          {t(($) => $.terminal.composeInsert)}
        </Button>
        <Button
          className="min-h-7 px-2.5 py-1"
          title={t(($) => $.terminal.composeSendHint, { key: `${appModifier}+Enter` })}
          disabled={!text || sending || !available}
          onClick={() => void send(true)}
        >
          {t(($) => $.terminal.composeSend)}
        </Button>
        <IconButton label={t(($) => $.terminal.composeClose)} onClick={onClose}>
          <X />
        </IconButton>
      </div>
    </div>
  );
}
