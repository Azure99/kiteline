import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { ArrowDown, ClipboardPaste, Copy, RefreshCw, TextSelect } from "lucide-react";
import { TerminalScreens, type TerminalScreenSnapshot } from "./screens";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { api, rpc } from "../lib/api";
import { useWebCompatible, webCompatible } from "../lib/release";
import { Terminal } from "@xterm/xterm";
import { ErrorNotice } from "../components/error-notice";
import { TouchControls } from "./touch-controls";
import { terminalFileLinks } from "./file-links";
import { showFile } from "../files/navigation";
import { useMobile } from "../lib/use-mobile";
import { cn } from "../lib/utils";
import { terminalKeyboard } from "./keyboard-input";
import { releasedModifiers } from "./auxiliary-input";
import { TerminalSearch } from "./terminal-search";
import { TerminalAuxKeys } from "./terminal-aux-keys";
import { TerminalNotice } from "./terminal-notice";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { ContextMenuContent } from "../components/ui/context-menu";
import { MenuItem } from "../components/ui/menu";
import { copyText } from "../lib/clipboard";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

export interface TerminalActions {
  redraw(): void;
  fontSize(delta: number): void;
  focus(): void;
  search(): void;
}
export interface TerminalCapabilities {
  title?: string;
  ready: boolean;
  hasTerminal: boolean;
  searchOpen: boolean;
}
export function TerminalView({
  deviceId,
  deviceName,
  workspaceId,
  workspacePath,
  sessionId,
  sessionName,
  sessionMissing,
  ref,
  onCapabilities,
  onClose,
  searchHost,
  paneActive,
}: {
  deviceId: string;
  deviceName: string;
  workspaceId: string;
  workspacePath: string;
  sessionId: string;
  sessionName: string;
  /** A successful session list no longer contains this session. */
  sessionMissing: boolean;
  ref?: Ref<TerminalActions>;
  onCapabilities(id: string, value: TerminalCapabilities | undefined): void;
  onClose(): void;
  searchHost: HTMLDivElement | null;
  paneActive: boolean;
}) {
  const { t } = useTranslation();
  const compatible = useWebCompatible();

  const element = useRef<HTMLDivElement>(null);
  const screens = useRef<TerminalScreens>(undefined);
  const [snapshot, setSnapshot] = useState<TerminalScreenSnapshot>({
    title: "",
    reading: false,
    modifiers: releasedModifiers,
    state: { status: "connecting" },
  });
  const { terminal, title, reading, modifiers, state } = snapshot;
  useEffect(() => {
    if (!terminal) return;
    const canvas = element.current!;
    const provider = terminal.registerLinkProvider(
      terminalFileLinks(
        terminal,
        workspacePath,
        (target) => showFile({ deviceId, workspaceId, path: target.path }, target.line),
        () => {
          canvas.title = t(($) => $.terminal.openFileHint);
        },
        () => canvas.removeAttribute("title"),
      ),
    );
    return () => provider.dispose();
  }, [terminal, deviceId, workspaceId, workspacePath, t]);
  const preflight = useRef(false);
  const [notice, setNotice] = useState<unknown>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [contextSelection, setContextSelection] = useState("");
  const [copyNotice, setCopyNotice] = useState<object>();
  useEffect(() => {
    if (!copyNotice) return;
    const timer = window.setTimeout(() => setCopyNotice(undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [copyNotice]);
  const contextMenu = useRef<ContextMenuPrimitive.Root.Actions>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const mobile = useMobile();
  const canPaste = state.status === "ready" && typeof navigator.clipboard?.readText === "function";
  const input = useRef<() => void>(() => {});
  useEffect(() => {
    if (mobile) contextMenu.current?.close();
  }, [mobile]);
  useEffect(() => {
    if (!mobile) screens.current?.display?.releaseModifiers();
  }, [mobile]);
  useEffect(
    () =>
      onCapabilities(sessionId, {
        ready: state.status === "ready",
        hasTerminal: !!terminal,
        title,
        searchOpen,
      }),
    [onCapabilities, sessionId, state.status, terminal, title, searchOpen],
  );
  useEffect(() => () => onCapabilities(sessionId, undefined), [onCapabilities, sessionId]);
  const [recovering, setRecovering] = useState(false);
  const [redrawDialog, setRedrawDialog] = useState(false);
  const [redrawing, setRedrawing] = useState(false);
  const operations = useRef(new AbortController());
  useEffect(() => {
    operations.current = new AbortController();
    return () => operations.current.abort();
  }, []);
  function redisplay(scope: "retained" | "screen" = "retained") {
    const current = screens.current;
    if (!webCompatible() || preflight.current || !current || current.connecting) return;
    preflight.current = true;
    const signal = operations.current.signal;
    void api("/api/session", { signal })
      .then(() => {
        if (
          signal.aborted ||
          screens.current !== current ||
          !webCompatible() ||
          current.display?.state.status === "ready"
        )
          return;
        setNotice("");
        current.restore(scope);
      })
      .catch((error: unknown) => {
        if (!signal.aborted && screens.current === current) setNotice(error);
      })
      .finally(() => {
        preflight.current = false;
      });
  }
  useImperativeHandle(ref, () => ({
    redraw: () => setRedrawDialog(true),
    fontSize: (delta) => screens.current?.display?.changeFontSize(delta),
    focus: () => screens.current?.display?.focus(),
    search: () => {
      if (!terminal) return;
      setSearchOpen(true);
      searchInput.current?.focus();
    },
  }));
  async function recover() {
    const signal = operations.current.signal;
    const display = screens.current?.display;
    setRecovering(true);
    try {
      let session = await rpc(deviceId, "sessions.recover", { workspaceId, sessionId }, signal);
      while (!signal.aborted && session.webStatus === "recovering") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await rpc(deviceId, "sessions.list", { workspaceId }, signal);
        const current = result.sessions.find((value) => value.id === sessionId);
        if (!current) throw new Error("The original task has ended");
        session = current;
      }
      if (signal.aborted || screens.current?.display !== display) return;
      if (session.webStatus !== "available")
        throw new Error(session.webReason ?? "Terminal recovery failed");
      redisplay();
    } catch (error) {
      if (!signal.aborted && screens.current?.display === display) setNotice(error);
    } finally {
      if (!signal.aborted) setRecovering(false);
    }
  }
  async function redraw() {
    const signal = operations.current.signal;
    setRedrawing(true);
    setNotice("");
    try {
      await rpc(deviceId, "sessions.redraw", { workspaceId, sessionId }, signal);
      if (!signal.aborted) setRedrawDialog(false);
    } catch (error) {
      if (!signal.aborted) setNotice(error);
    } finally {
      if (!signal.aborted) setRedrawing(false);
    }
  }
  useEffect(() => {
    const current = new TerminalScreens(
      element.current!,
      { deviceId, workspaceId, sessionId },
      setSnapshot,
    );
    screens.current = current;
    return () => {
      screens.current = undefined;
      current.dispose();
    };
  }, [deviceId, workspaceId, sessionId]);
  useLayoutEffect(() => {
    if (state.status === "ready") screens.current?.display?.syncViewportAndInput();
  }, [terminal, state.status]);
  useEffect(() => {
    if (sessionMissing && state.status === "error") screens.current?.display?.sessionMissing();
  }, [sessionMissing, state.status]);
  useEffect(() => {
    Terminal.strings.promptLabel = t(($) => $.terminal.inputLabel);
    Terminal.strings.tooMuchOutput = t(($) => $.terminal.tooMuchOutput);
    terminal?.textarea?.setAttribute("aria-label", Terminal.strings.promptLabel);
    element.current?.removeAttribute("title");
  }, [terminal, t]);
  useEffect(() => {
    if (!terminal?.textarea) return;
    const keyboard = terminalKeyboard(terminal, mobile);
    input.current = keyboard.activate;
    return () => {
      keyboard.dispose();
      input.current = () => {};
    };
  }, [terminal, mobile]);
  async function paste() {
    const current = screens.current?.display;
    try {
      if (!mobile) current?.focus();
      current?.paste(await navigator.clipboard.readText());
    } catch (error) {
      setNotice(error);
    }
  }
  async function copySelection() {
    try {
      await copyText(contextSelection);
      setCopyNotice({});
    } catch (error) {
      setNotice(error);
    }
  }
  const auxiliary = useCallback(
    (value: string) => {
      screens.current?.display?.key(value);
      if (!mobile) screens.current?.display?.focus();
    },
    [mobile],
  );
  return (
    <section
      className="terminal-surface flex min-h-0 flex-1 flex-col"
      aria-label={t(($) => $.terminal.display)}
    >
      <TerminalNotice
        state={state}
        notice={notice}
        recovering={recovering}
        compatible={compatible}
        onRecover={recover}
        onRestore={redisplay}
        onClose={onClose}
        onDismiss={() => setNotice("")}
      />
      <div
        className={cn(
          "terminal-viewport relative flex min-h-0 flex-1",
          state.status === "ended" && "flex-col",
        )}
      >
        <ContextMenuPrimitive.Root
          actionsRef={contextMenu}
          disabled={mobile}
          onOpenChange={(open) => {
            if (open) setContextSelection(terminal?.getSelection() ?? "");
          }}
        >
          <ContextMenuPrimitive.Trigger
            render={<div ref={element} className="relative min-h-0 min-w-0 flex-1" />}
          />
          <ContextMenuContent>
            <MenuItem disabled={!contextSelection} onClick={() => void copySelection()}>
              <Copy />
              {t(($) => $.terminal.copySelected)}
            </MenuItem>
            <MenuItem disabled={!canPaste} onClick={() => void paste()}>
              <ClipboardPaste />
              {t(($) => $.terminal.paste)}
            </MenuItem>
            <MenuItem disabled={!terminal} onClick={() => terminal?.selectAll()}>
              <TextSelect />
              {t(($) => $.terminal.selectAll)}
            </MenuItem>
          </ContextMenuContent>
        </ContextMenuPrimitive.Root>
        {searchOpen &&
          searchHost &&
          createPortal(
            <TerminalSearch
              terminal={terminal}
              targetName={sessionName}
              active={paneActive}
              inputRef={searchInput}
              onClose={() => {
                setSearchOpen(false);
                if (terminal?.options.disableStdin) terminal.focus();
                else input.current();
              }}
            />,
            searchHost,
          )}
        {terminal && (
          <TouchControls
            terminal={terminal}
            deviceId={deviceId}
            deviceName={deviceName}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
            onPaste={canPaste ? paste : undefined}
            onTap={() => {
              input.current();
            }}
          />
        )}
        {copyNotice && (
          <span
            role="status"
            className="pointer-events-none absolute bottom-3 left-3 rounded bg-[var(--terminal-chrome)] px-2 py-1 text-xs text-[var(--terminal-chrome-foreground)] shadow"
          >
            {t(($) => $.common.copied)}
          </span>
        )}
        {reading && (
          <div className="absolute bottom-3 right-4 rounded bg-[var(--terminal-chrome)] shadow">
            <IconButton
              label={t(($) => $.terminal.bottom)}
              onPointerDown={(event) => {
                if (event.pointerType === "mouse") event.preventDefault();
              }}
              onClick={() => screens.current?.display?.scrollToBottom()}
            >
              <ArrowDown />
            </IconButton>
          </div>
        )}
      </div>
      <TerminalAuxKeys
        terminal={terminal}
        paneActive={paneActive}
        hidden={searchOpen && paneActive}
        available={state.status === "ready"}
        mobile={mobile}
        modifiers={modifiers}
        onKey={auxiliary}
        onToggleModifier={(key) => screens.current?.display?.toggleModifier(key)}
      />
      <Dialog
        open={redrawDialog}
        onOpenChange={(open) => {
          if (!redrawing) setRedrawDialog(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.terminal.redrawProgram)}</DialogTitle>
          </DialogHeader>
          <p className="px-5 py-4 text-sm text-muted-foreground">
            {t(($) => $.terminal.redrawHint)}
          </p>
          {!!notice && (
            <div role="alert" className="px-5 pb-4 text-sm text-destructive">
              <ErrorNotice error={notice} />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={redrawing} onClick={() => setRedrawDialog(false)}>
              {t(($) => $.common.cancel)}
            </Button>
            <Button disabled={redrawing} onClick={() => void redraw()}>
              <RefreshCw />
              {t(($) => $.terminal.redraw)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
