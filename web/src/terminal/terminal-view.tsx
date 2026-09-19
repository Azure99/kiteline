import { useTranslation } from "react-i18next";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Copy,
  RefreshCw,
  X,
} from "lucide-react";
import { TerminalDisplay, type DisplayState } from "./display";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { rpc } from "../lib/api";
import { Terminal } from "@xterm/xterm";
import { ErrorNotice } from "../components/error-notice";
import { TouchControls } from "./touch-controls";
import { useMobile } from "../lib/use-mobile";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import "@xterm/xterm/css/xterm.css";

export interface TerminalActions {
  redisplay(): void;
  redraw(): void;
  fontSize(delta: number): void;
  focus(): void;
}
export function TerminalView({
  deviceId,
  workspaceId,
  sessionId,
  ref,
  onStatus,
}: {
  deviceId: string;
  workspaceId: string;
  sessionId: string;
  ref?: Ref<TerminalActions>;
  onStatus?: (status: DisplayState["status"]) => void;
}) {
  const { t } = useTranslation();

  const element = useRef<HTMLDivElement>(null);
  const display = useRef<TerminalDisplay>(undefined);
  const [terminal, setTerminal] = useState<Terminal>();
  const [reading, setReading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DisplayState>({ status: "connecting" });
  const [notice, setNotice] = useState<unknown>();
  const [ctrl, setCtrl] = useState(false);
  const mobile = useMobile();
  const control = useRef(false);
  function setControl(value: boolean) {
    control.current = value;
    setCtrl(value);
  }
  useEffect(() => {
    if (!mobile) setControl(false);
  }, [mobile]);
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
    setNotice("");
    setHistory(scope);
    setState({ status: "connecting" });
    setAttempt((value) => value + 1);
  }
  useImperativeHandle(ref, () => ({
    redisplay,
    redraw: () => setRedrawDialog(true),
    fontSize: (delta) => display.current?.changeFontSize(delta),
    focus: () => display.current?.focus(),
  }));
  useEffect(() => {
    onStatus?.(state.status);
  }, [state.status, onStatus]);
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
        reading: setReading,
        control: () => {
          const value = control.current;
          if (value) setControl(false);
          return value;
        },
      },
    );
    display.current = current;
    return () => {
      current.dispose();
      display.current = undefined;
      setTerminal(undefined);
      setReading(false);
    };
  }, [deviceId, workspaceId, sessionId, attempt, history]);
  useEffect(() => {
    Terminal.strings.promptLabel = t(($) => $.terminal.inputLabel);
    Terminal.strings.tooMuchOutput = t(($) => $.terminal.tooMuchOutput);
    terminal?.textarea?.setAttribute("aria-label", Terminal.strings.promptLabel);
    element.current?.removeAttribute("title");
  }, [terminal, t]);
  async function clipboard(copy: boolean) {
    try {
      if (copy) {
        const text = display.current?.terminal?.getSelection();
        if (text) await navigator.clipboard.writeText(text);
      } else display.current?.paste(await navigator.clipboard.readText());
      if (!copy) {
        setControl(false);
        display.current?.focus();
      }
    } catch (error) {
      setNotice(error);
    }
  }
  const auxiliary = (value: string) => {
    display.current?.input(value);
    display.current?.focus();
    setControl(false);
  };
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
          {!!(state.status === "error") && (
            <>
              <Button
                variant="ghost"
                disabled={recovering}
                onClick={() =>
                  state.code === "recording_unavailable" ? void recover() : redisplay()
                }
              >
                <RefreshCw />
                {recovering
                  ? t(($) => $.terminal.recovering)
                  : state.code === "recording_unavailable"
                    ? t(($) => $.terminal.recover)
                    : t(($) => $.terminal.reconnect)}
              </Button>
              {["limit_exceeded", "timeout", "busy"].includes(state.code ?? "") && (
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
      <div className="relative flex min-h-0 flex-1">
        <div ref={element} className="terminal-canvas min-h-0 min-w-0 flex-1" />
        {terminal && <TouchControls terminal={terminal} deviceId={deviceId} onError={setNotice} />}
        {reading && (
          <div className="absolute bottom-3 right-4 rounded bg-[#39414c] shadow">
            <IconButton
              label={t(($) => $.terminal.bottom)}
              onClick={() => display.current?.scrollToBottom()}
            >
              <ArrowDown />
            </IconButton>
          </div>
        )}
      </div>
      <div
        className="terminal-aux flex shrink-0 items-center gap-0.5 border-t px-1.5 py-0.5"
        onPointerDown={(event) => event.preventDefault()}
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          <button className="aux-key" onClick={() => auxiliary("\x1b")}>
            Esc
          </button>
          <button className="aux-key" onClick={() => auxiliary("\t")}>
            Tab
          </button>
          <button
            className="aux-key"
            aria-pressed={ctrl}
            onClick={() => {
              setControl(!ctrl);
              display.current?.focus();
            }}
          >
            Ctrl
          </button>
          {ctrl && (
            <>
              {["C", "D", "B", "L"].map((key) => (
                <button
                  key={key}
                  className="aux-key"
                  onClick={() => auxiliary(String.fromCharCode(key.charCodeAt(0) - 64))}
                >
                  {key}
                </button>
              ))}
            </>
          )}
          {[
            { icon: ArrowLeft, value: "D", label: t(($) => $.terminal.left) },
            { icon: ArrowDown, value: "B", label: t(($) => $.terminal.down) },
            { icon: ArrowUp, value: "A", label: t(($) => $.terminal.up) },
            { icon: ArrowRight, value: "C", label: t(($) => $.terminal.right) },
          ].map(({ icon: Glyph, value, label }) => {
            return (
              <IconButton
                key={value}
                label={label}
                onClick={() =>
                  auxiliary(
                    ctrl
                      ? `\x1b[1;5${value}`
                      : `\x1b${display.current?.terminal?.modes.applicationCursorKeysMode ? "O" : "["}${value}`,
                  )
                }
              >
                <Glyph />
              </IconButton>
            );
          })}
        </div>
        <IconButton label={t(($) => $.terminal.copySelection)} onClick={() => void clipboard(true)}>
          <Copy />
        </IconButton>
        <IconButton
          label={t(($) => $.terminal.paste)}
          disabled={state.status !== "ready"}
          onClick={() => void clipboard(false)}
        >
          <ClipboardPaste />
        </IconButton>
      </div>
      <Dialog
        open={redrawDialog}
        onOpenChange={(open) => {
          if (!redrawing) setRedrawDialog(open);
        }}
      >
        {redrawDialog && (
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
        )}
      </Dialog>
    </section>
  );
}
