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
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  X,
} from "lucide-react";
import { TerminalDisplay, type DisplayState } from "./display";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { api, ApiError, rpc } from "../lib/api";
import { useWebCompatible, webCompatible } from "../lib/release";
import { Terminal } from "@xterm/xterm";
import { ErrorNotice } from "../components/error-notice";
import { TouchControls } from "./touch-controls";
import { terminalFileLinks } from "./file-links";
import { showFile } from "../files/navigation";
import { useMobile } from "../lib/use-mobile";
import { cn } from "../lib/utils";
import { terminalKeyboard } from "./keyboard-input";
import { releasedModifiers, type Modifiers } from "./auxiliary-input";
import { TerminalSearch } from "./terminal-search";
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
}
export function TerminalView({
  deviceId,
  workspaceId,
  workspacePath,
  sessionId,
  ref,
  onCapabilities,
  searchHost,
  searchActive,
}: {
  deviceId: string;
  workspaceId: string;
  workspacePath: string;
  sessionId: string;
  ref?: Ref<TerminalActions>;
  onCapabilities?(id: string, value: TerminalCapabilities | undefined): void;
  searchHost: HTMLDivElement | null;
  searchActive: boolean;
}) {
  const { t } = useTranslation();
  const compatible = useWebCompatible();

  const element = useRef<HTMLDivElement>(null);
  const display = useRef<TerminalDisplay>(undefined);
  const [title, setTitle] = useState("");
  const [terminal, setTerminal] = useState<Terminal>();
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
  const [reading, setReading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DisplayState>({ status: "connecting" });
  const code = state.error instanceof ApiError ? state.error.code : undefined;
  const screenRetry =
    state.status === "error" && ["limit_exceeded", "timeout", "busy"].includes(code ?? "");
  const [notice, setNotice] = useState<unknown>();
  const [modifiers, setModifiers] = useState<Modifiers>(releasedModifiers);
  const [expanded, setExpanded] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!searchOpen || !searchActive || !searchHost) return;
    const controls = searchHost.querySelector<HTMLElement>("[data-search-controls]")!;
    controls.style.visibility = "hidden";
    return () => {
      controls.style.visibility = "";
    };
  }, [searchOpen, searchActive, searchHost]);
  const mobile = useMobile();
  const input = useRef<() => void>(() => {});
  useEffect(() => {
    if (!mobile) display.current?.releaseModifiers();
  }, [mobile]);
  useEffect(
    () =>
      onCapabilities?.(sessionId, {
        ready: state.status === "ready",
        hasTerminal: !!terminal,
        title,
      }),
    [onCapabilities, sessionId, state.status, terminal, title],
  );
  useEffect(() => () => onCapabilities?.(sessionId, undefined), [onCapabilities, sessionId]);
  const [history, setHistory] = useState<"retained" | "screen">("retained");
  const [recovering, setRecovering] = useState(false);
  const [redrawDialog, setRedrawDialog] = useState(false);
  const [redrawing, setRedrawing] = useState(false);
  const operations = useRef(new AbortController());
  useEffect(() => {
    operations.current = new AbortController();
    return () => operations.current.abort();
  }, []);
  function redisplay(scope: "retained" | "screen" = "retained") {
    if (!webCompatible()) return;
    const signal = operations.current.signal;
    void api("/api/session", { signal })
      .then(() => {
        if (signal.aborted || !webCompatible()) return;
        setNotice("");
        setHistory(scope);
        setState({ status: "connecting" });
        setAttempt((value) => value + 1);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) setNotice(error);
      });
  }
  useImperativeHandle(ref, () => ({
    redraw: () => setRedrawDialog(true),
    fontSize: (delta) => display.current?.changeFontSize(delta),
    focus: () => display.current?.focus(),
    search: () => {
      if (!terminal) return;
      setSearchOpen(true);
      searchInput.current?.focus();
    },
  }));
  async function recover() {
    const signal = operations.current.signal;
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
      if (signal.aborted) return;
      if (session.webStatus !== "available")
        throw new Error(session.webReason ?? "Terminal recovery failed");
      redisplay();
    } catch (error) {
      if (!signal.aborted) setNotice(error);
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
    const current = new TerminalDisplay(
      element.current!,
      deviceId,
      workspaceId,
      sessionId,
      setState,
      history,
      {
        opened: setTerminal,
        title: setTitle,
        reading: setReading,
        modifiers: setModifiers,
      },
    );
    display.current = current;
    return () => {
      current.dispose();
      setTitle("");
      display.current = undefined;
      setTerminal(undefined);
      setReading(false);
    };
  }, [deviceId, workspaceId, sessionId, attempt, history]);
  useLayoutEffect(() => {
    if (state.status === "ready") display.current?.resize();
  }, [state.status]);
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
    const current = display.current;
    try {
      current?.focus();
      current?.paste(await navigator.clipboard.readText());
    } catch (error) {
      setNotice(error);
    }
  }
  const auxiliary = useCallback(
    (value: string) => {
      display.current?.key(value);
      if (!mobile) display.current?.focus();
    },
    [mobile],
  );
  const arrowRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = arrowRoot.current!;
    let timer = 0;
    let held: { id: number; button: HTMLElement; key: string } | undefined;
    const stop = () => {
      clearTimeout(timer);
      held = undefined;
    };
    const repeat = () => {
      if (!held) return;
      auxiliary(held.key);
      timer = window.setTimeout(repeat, 80);
    };
    const down = (event: PointerEvent) => {
      const button = (event.target as Element).closest<HTMLElement>("[data-repeat-arrow]");
      if (
        !button ||
        event.pointerType !== "touch" ||
        !event.isPrimary ||
        held ||
        !searchActive ||
        state.status !== "ready"
      )
        return;
      event.preventDefault();
      held = { id: event.pointerId, button, key: button.dataset.repeatArrow! };
      auxiliary(held.key);
      if (mobile) navigator.vibrate?.(10);
      timer = window.setTimeout(repeat, 400);
    };
    const move = (event: PointerEvent) => {
      if (!held || held.id !== event.pointerId) return;
      const box = held.button.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX >= box.right ||
        event.clientY < box.top ||
        event.clientY >= box.bottom
      )
        stop();
    };
    const end = (event: PointerEvent) => {
      if (held?.id === event.pointerId) stop();
    };
    // Cancel the gesture's click even if its terminal is replaced before release.
    const preventArrowDefault = (event: Event) => {
      if ((event.target as Element).closest("[data-repeat-arrow]")) event.preventDefault();
    };
    const visibility = () => {
      if (document.hidden) stop();
    };
    root.addEventListener("pointerdown", down);
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    root.addEventListener("lostpointercapture", end);
    root.addEventListener("touchstart", preventArrowDefault, { passive: false });
    root.addEventListener("contextmenu", preventArrowDefault);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop();
      root.removeEventListener("pointerdown", down);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerup", end);
      root.removeEventListener("pointercancel", end);
      root.removeEventListener("lostpointercapture", end);
      root.removeEventListener("touchstart", preventArrowDefault);
      root.removeEventListener("contextmenu", preventArrowDefault);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [auxiliary, mobile, searchActive, state.status, terminal, expanded]);
  return (
    <section
      className="terminal-surface flex min-h-0 flex-1 flex-col"
      aria-label={t(($) => $.terminal.display)}
    >
      {!!(
        state.status !== "ready" ||
        state.error ||
        state.notice ||
        state.historyGap ||
        state.historyLimited ||
        notice
      ) && (
        <div
          className="terminal-notice flex flex-wrap items-start gap-2 px-3 py-1 text-xs"
          data-two-actions={screenRetry}
          data-compact={
            !notice &&
            !state.error &&
            !state.notice &&
            (state.status === "ended" || state.status === "connecting")
          }
          role="status"
        >
          <div className="min-w-0 flex-1 break-words">
            {notice || state.error ? (
              <ErrorNotice error={notice || state.error} />
            ) : state.notice ? (
              t(($) => $.terminal[state.notice!])
            ) : state.status === "ended" ? (
              state.exitCode == null ? (
                t(($) => $.terminal.ended)
              ) : (
                t(($) => $.terminal.endedCode, { code: state.exitCode })
              )
            ) : state.status === "connecting" ? (
              t(($) => $.common.connecting)
            ) : state.historyGap && state.historyLimited ? (
              t(($) => $.terminal.historyGapLimited)
            ) : state.historyGap ? (
              t(($) => $.terminal.historyGap)
            ) : state.historyLimited ? (
              t(($) => $.terminal.historyLimited)
            ) : null}
          </div>
          {!!(state.status === "error" && code !== "not_found") && (
            <>
              <Button
                variant="ghost"
                disabled={recovering || !compatible}
                onClick={() => (code === "recording_unavailable" ? void recover() : redisplay())}
              >
                <RefreshCw />
                {recovering
                  ? t(($) => $.terminal.recovering)
                  : code === "recording_unavailable"
                    ? t(($) => $.terminal.recover)
                    : t(($) => $.terminal.reconnect)}
              </Button>
              {screenRetry && (
                <Button
                  variant="ghost"
                  onClick={() => redisplay("screen")}
                  title={t(($) => $.terminal.screenOnlyHint)}
                >
                  {t(($) => $.terminal.screenOnly)}
                </Button>
              )}
            </>
          )}
          {!!notice && (
            <IconButton label={t(($) => $.common.dismiss)} onClick={() => setNotice("")}>
              <X />
            </IconButton>
          )}
        </div>
      )}
      <div
        className={cn(
          "terminal-viewport relative flex min-h-0 flex-1",
          state.status === "ended" && "flex-col",
        )}
      >
        <div ref={element} className="terminal-canvas min-h-0 min-w-0 flex-1" />
        {searchOpen &&
          searchHost &&
          createPortal(
            <TerminalSearch
              terminal={terminal}
              active={searchActive}
              inputRef={searchInput}
              onClose={() => {
                setSearchOpen(false);
                terminal?.focus();
              }}
            />,
            searchHost,
          )}
        {terminal && (
          <TouchControls
            terminal={terminal}
            deviceId={deviceId}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
            onPaste={
              state.status === "ready" && typeof navigator.clipboard?.readText === "function"
                ? paste
                : undefined
            }
            onTap={() => {
              input.current();
            }}
          />
        )}
        {reading && (
          <div className="absolute bottom-3 right-4 rounded bg-[#39414c] shadow">
            <IconButton
              label={t(($) => $.terminal.bottom)}
              onPointerDown={(event) => {
                if (event.pointerType === "mouse") event.preventDefault();
              }}
              onClick={() => display.current?.scrollToBottom()}
            >
              <ArrowDown />
            </IconButton>
          </div>
        )}
      </div>
      <div
        ref={arrowRoot}
        className="terminal-aux shrink-0 border-t"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          if (
            mobile &&
            event.target instanceof Element &&
            event.target.closest("button:not(:disabled)")
          )
            navigator.vibrate?.(10);
        }}
      >
        {expanded && (
          <div className="terminal-aux-row">
            {[
              ["Tab", "TAB"],
              ["/", "/"],
              ["@", "@"],
              ["PageUp", "PGUP"],
              ["ArrowUp", ""],
              ["PageDown", "PGDN"],
              ["Escape", "ESC"],
            ].map(([key, label]) =>
              key === "ArrowUp" ? (
                <IconButton
                  key={key}
                  className="aux-key touch-none"
                  data-repeat-arrow={key}
                  label={t(($) => $.terminal.up)}
                  disabled={state.status !== "ready"}
                  onClick={() => auxiliary(key!)}
                >
                  <ArrowUp />
                </IconButton>
              ) : (
                <button
                  key={key}
                  className="aux-key"
                  disabled={state.status !== "ready"}
                  onClick={() => auxiliary(key!)}
                >
                  {label}
                </button>
              ),
            )}
          </div>
        )}
        <div className="terminal-aux-row">
          {(["shiftKey", "ctrlKey", "altKey"] as const).map((key) => (
            <button
              key={key}
              className="aux-key"
              aria-pressed={modifiers[key]}
              disabled={state.status !== "ready"}
              onClick={() => display.current?.toggleModifier(key)}
            >
              {key.slice(0, -3).toUpperCase()}
            </button>
          ))}
          {[
            { icon: ArrowLeft, value: "ArrowLeft", label: t(($) => $.terminal.left) },
            { icon: ArrowDown, value: "ArrowDown", label: t(($) => $.terminal.down) },
            { icon: ArrowRight, value: "ArrowRight", label: t(($) => $.terminal.right) },
          ].map(({ icon: Glyph, value, label }) => {
            return (
              <IconButton
                key={value}
                className="aux-key touch-none"
                data-repeat-arrow={value}
                label={label}
                disabled={state.status !== "ready"}
                onClick={() => auxiliary(value)}
              >
                <Glyph />
              </IconButton>
            );
          })}
          <IconButton
            className="aux-key"
            label={expanded ? t(($) => $.terminal.collapseKeys) : t(($) => $.terminal.expandKeys)}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown /> : <ChevronUp />}
          </IconButton>
        </div>
      </div>
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
