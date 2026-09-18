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
import { rpc, errorMessage } from "../lib/api";
import type { Session } from "@kiteline/shared/protocol";
import type { Terminal } from "@xterm/xterm";
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
  const element = useRef<HTMLDivElement>(null);
  const display = useRef<TerminalDisplay>(undefined);
  const [terminal, setTerminal] = useState<Terminal>();
  const [reading, setReading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DisplayState>({ status: "connecting" });
  const [notice, setNotice] = useState("");
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
      let session = await rpc<Session>(
        deviceId,
        "sessions.recover",
        { workspaceId, sessionId },
        signal,
      );
      while (!signal.aborted && session.webStatus === "recovering") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await rpc<{ sessions: Session[] }>(
          deviceId,
          "sessions.list",
          { workspaceId },
          signal,
        );
        const current = result.sessions.find((value) => value.id === sessionId);
        if (!current) throw new Error("原任务已结束");
        session = current;
      }
      if (signal.aborted) return;
      if (session.webStatus !== "available") throw new Error(session.webReason ?? "终端恢复失败");
      redisplay();
    } catch (error) {
      if (!signal.aborted) setNotice(errorMessage(error));
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
      if (!signal.aborted) setNotice(errorMessage(error));
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
      setNotice(errorMessage(error));
    }
  }
  const auxiliary = (value: string) => {
    display.current?.input(value);
    display.current?.focus();
    setControl(false);
  };
  return (
    <section className="terminal-surface flex min-h-0 flex-1 flex-col" aria-label="终端显示">
      {(state.status !== "ready" ||
        state.message ||
        state.historyGap ||
        state.historyLimited ||
        notice) && (
        <div
          className="terminal-notice flex flex-wrap items-center gap-2 px-3 py-1 text-xs"
          role="status"
        >
          <span className="min-w-0 flex-1 break-words">
            {notice ||
              state.message ||
              (state.status === "connecting"
                ? "正在连接"
                : [state.historyGap && "历史存在缺口", state.historyLimited && "已减少较早历史"]
                    .filter(Boolean)
                    .join("；"))}
          </span>
          {state.status === "error" && (
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
                  ? "正在恢复"
                  : state.code === "recording_unavailable"
                    ? "恢复终端"
                    : "重新连接"}
              </Button>
              {["limit_exceeded", "timeout", "busy"].includes(state.code ?? "") && (
                <Button
                  variant="ghost"
                  onClick={() => redisplay("screen")}
                  title="仅本次显示省略较早滚屏"
                >
                  减少历史后重试
                </Button>
              )}
            </>
          )}
          {notice && (
            <IconButton label="关闭提示" onClick={() => setNotice("")}>
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
            <IconButton label="回到底部" onClick={() => display.current?.scrollToBottom()}>
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
            { icon: ArrowLeft, value: "D", label: "左" },
            { icon: ArrowDown, value: "B", label: "下" },
            { icon: ArrowUp, value: "A", label: "上" },
            { icon: ArrowRight, value: "C", label: "右" },
          ].map(({ icon: Glyph, value, label }) => {
            return (
              <IconButton
                key={label}
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
        <IconButton label="复制选区" onClick={() => void clipboard(true)}>
          <Copy />
        </IconButton>
        <IconButton
          label="粘贴"
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
              <DialogTitle>重绘程序</DialogTitle>
            </DialogHeader>
            <p className="px-5 py-4 text-sm text-muted-foreground">
              这会暂时调整任务尺寸，可能改变其他入口的画面和选区。
            </p>
            {notice && (
              <p role="alert" className="px-5 pb-4 text-sm text-destructive">
                {notice}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" disabled={redrawing} onClick={() => setRedrawDialog(false)}>
                取消
              </Button>
              <Button disabled={redrawing} onClick={() => void redraw()}>
                <RefreshCw />
                重绘
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
