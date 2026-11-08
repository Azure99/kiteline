import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { ErrorNotice } from "../components/error-notice";
import { appModifier } from "../lib/app-modifier";
import { cn } from "../lib/utils";
import type { ComposeDrafts } from "./compose-drafts";

export function isComposeShortcut(event: KeyboardEvent | React.KeyboardEvent) {
  return event.key === "Enter" && event.shiftKey && (event.ctrlKey || event.metaKey);
}

export interface ComposeUpload {
  deviceId: string;
  workspaceId: string;
  workspacePath: string;
  files: File[];
  label: string;
  onWritten(path: string): void;
  finalFocus(): HTMLElement | null;
}

const Host = createContext<
  { drafts: ComposeDrafts; upload(request: ComposeUpload): void } | undefined
>(undefined);

export function ComposeProvider({
  drafts,
  upload,
  children,
}: {
  drafts: ComposeDrafts;
  upload(request: ComposeUpload): void;
  children: ReactNode;
}) {
  return <Host.Provider value={{ drafts, upload }}>{children}</Host.Provider>;
}

export function useComposeDraft(deviceId: string, workspaceId: string, sessionId: string) {
  const host = useContext(Host)!;
  const draft = host.drafts.get({ deviceId, workspaceId, sessionId });
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot);
  return { draft, ...state, upload: host.upload };
}

export function ComposePanel({
  deviceId,
  workspaceId,
  workspacePath,
  sessionId,
  sessionName,
  label,
  mobile,
  available,
  editor,
  onClose,
}: {
  deviceId: string;
  workspaceId: string;
  workspacePath: string;
  sessionId: string;
  sessionName: string;
  label: string;
  mobile: boolean;
  available: boolean;
  editor: RefObject<HTMLTextAreaElement | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { draft, text, sending, error, upload } = useComposeDraft(deviceId, workspaceId, sessionId);
  const panel = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [directoryDrop, setDirectoryDrop] = useState(false);

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
    if (!element || element.value !== draft.snapshot().text) return;
    const [start, end] = draft.selection;
    if (element.selectionStart !== start || element.selectionEnd !== end)
      element.setSelectionRange(start, end);
  }, [draft, editor, text]);

  async function send(enter: boolean) {
    if (!available) return;
    const delivered = await draft.send(enter);
    // Keep later edits open; a closed panel must not close a later instance either.
    if (delivered && panel.current && !draft.snapshot().text) onClose();
  }

  function choose(files: File[]) {
    if (!files.length) return;
    setDirectoryDrop(false);
    let written = false;
    upload({
      deviceId,
      workspaceId,
      workspacePath,
      files,
      label,
      // Paths arrive as absolute device paths; the program's cwd is unknown here.
      onWritten: (path) => {
        draft.insert((written ? "\n" : "") + path);
        written = true;
      },
      finalFocus: () => {
        const element = editor.current;
        element?.setSelectionRange(...draft.selection);
        return element;
      },
    });
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
        onPaste={(event) => {
          if (!event.clipboardData.files.length) return;
          event.preventDefault();
          choose(Array.from(event.clipboardData.files));
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          if (
            Array.from(event.dataTransfer.items).some(
              (item) => item.webkitGetAsEntry()?.isDirectory,
            )
          ) {
            setDirectoryDrop(true);
            return;
          }
          choose(Array.from(event.dataTransfer.files));
        }}
      />
      {directoryDrop && (
        <p role="alert" className="px-3 text-xs text-destructive">
          {t(($) => $.files.directoryDropUnsupported)}
        </p>
      )}
      {!!error && (
        <div role="alert" className="max-h-24 overflow-auto px-3 text-xs text-destructive">
          <ErrorNotice error={error} />
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1 border-t px-1 py-1">
        <IconButton
          label={t(($) => $.terminal.composeUpload)}
          onClick={() => picker.current?.click()}
        >
          <Paperclip />
        </IconButton>
        <span className="min-w-0 flex-1" />
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
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          choose(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
    </div>
  );
}
