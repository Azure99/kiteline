import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { deviceServiceLink } from "../lib/device-service";
import {
  integer,
  limits,
  record,
  terminalProfile,
  type TerminalMeta,
} from "@kiteline/shared/protocol";
import {
  forwardUserInput,
  freezeMouse,
  normalizePaste,
  adaptTerminalScrolling,
  terminalOptions,
} from "@kiteline/shared/terminal";
import { ApiError, api, post } from "../lib/api";
import { i18n } from "../i18n";
import { retainReadonlyViewport } from "./readonly-viewport";
import { versionedPath } from "../lib/release";
import { isKeyboardOpen } from "../lib/viewport";
import { KeyboardViewport } from "./keyboard-viewport";

export interface DisplayState {
  status: "connecting" | "ready" | "ended" | "error";
  error?: unknown;
  notice?: "connectionLost" | "inputLimit" | "pasteLimit";
  exitCode?: number | null;
  code?: string;
  historyLimited?: boolean;
  historyGap?: boolean;
}
export class TerminalDisplay {
  terminal?: Terminal;
  private fitAddon = new FitAddon();
  private socket?: WebSocket;
  private channelId?: string;
  private meta?: TerminalMeta;
  private abort = new AbortController();
  private observer: ResizeObserver;
  private queue: Promise<unknown> = Promise.resolve();
  private receivedEnd = false;
  private finalFrame = false;
  private connectionLost = false;
  private ready = false;
  private disposed = false;
  private snapshotRemaining = 0;
  private consumed = 0;
  private proposed?: { cols: number; rows: number };
  private effective?: { cols: number; rows: number; width: number; font: number };
  private keyboardViewport?: KeyboardViewport;
  private cleanups: (() => void)[] = [];
  state: DisplayState = { status: "connecting" };
  constructor(
    private element: HTMLElement,
    private deviceId: string,
    private workspaceId: string,
    private sessionId: string,
    private onState: (state: DisplayState) => void,
    history: "retained" | "screen" = "retained",
    private interaction?: {
      opened: (terminal: Terminal) => void;
      reading: (value: boolean) => void;
      control: () => boolean;
    },
  ) {
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(element);
    window.addEventListener("kiteline:viewport", this.viewportChanged);
    element.addEventListener("paste", this.onPaste, true);
    void this.connect(history);
  }
  private change(state: DisplayState) {
    this.state = state;
    if (!this.disposed) this.onState(state);
  }
  private async connect(history: "retained" | "screen") {
    try {
      const channel = await post<{ channelId: string; meta: TerminalMeta }>(
        `/api/devices/${encodeURIComponent(this.deviceId)}/channels`,
        {
          kind: "terminal.attach",
          params: {
            workspaceId: this.workspaceId,
            sessionId: this.sessionId,
            terminalProfile,
            history,
          },
        },
        this.abort.signal,
        false,
      );
      this.channelId = channel.channelId;
      if (this.disposed) {
        this.cancelChannel();
        return;
      }
      this.meta = channel.meta;
      if (channel.meta.terminalProfile !== terminalProfile)
        throw new Error("Terminal component versions differ; upgrade them together");
      const url = new URL(
        versionedPath(`/api/channels/${encodeURIComponent(channel.channelId)}/terminal`),
        location.href,
      );
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (this.disposed || this.finalFrame) return;
        try {
          if (event.data instanceof ArrayBuffer) {
            if (event.data.byteLength > limits.dataChunkBytes)
              throw new Error("Terminal data frame exceeds its limit");
            const data = new Uint8Array(event.data);
            this.queue = this.queue
              .then(() => this.output(data))
              .catch((error: unknown) => this.fail(error));
          } else {
            if (
              typeof event.data !== "string" ||
              new TextEncoder().encode(event.data).length > limits.controlMessageBytes
            )
              throw new Error("Invalid terminal control frame");
            const frame = record(JSON.parse(event.data));
            if (frame.type === "ended" || frame.type === "error") {
              this.finalFrame = true;
              this.receivedEnd = frame.type === "ended";
              this.connectionLost = frame.type === "error";
              if (this.terminal) this.terminal.options.disableStdin = true;
            }
            this.queue = this.queue
              .then(() => this.frame(frame))
              .catch((error: unknown) => this.fail(error));
          }
        } catch (error) {
          this.fail(error);
        }
      };
      socket.onerror = () => {
        if (!this.finalFrame) this.fail(new Error("Terminal connection failed"));
      };
      socket.onclose = () => {
        if (!this.finalFrame && !this.disposed) {
          this.connectionLost = true;
          this.ready = false;
          if (this.terminal) this.terminal.options.disableStdin = true;
          this.queue = this.queue.then(() =>
            this.change({
              ...this.state,
              status: "error",
              notice: "connectionLost",
              error: undefined,
            }),
          );
        }
      };
    } catch (error) {
      if (!this.disposed) this.fail(error);
    }
  }
  private frame(frame: Record<string, unknown>) {
    if (this.disposed) return;
    switch (frame.type) {
      case "restore.begin": {
        if (this.terminal || frame.terminalProfile !== terminalProfile)
          throw new Error("Invalid terminal restoration boundary");
        this.snapshotRemaining = integer(
          frame.snapshotBytes,
          "snapshotBytes",
          0,
          limits.terminalSnapshotBytes,
        );
        const styles = getComputedStyle(document.documentElement);
        const openLink = (_event: MouseEvent, uri: string) => {
          if (/^https?:\/\//i.test(uri))
            window.open(
              deviceServiceLink(uri, this.deviceId)?.url ?? uri,
              "_blank",
              "noopener,noreferrer",
            );
        };
        const hoverLink = (_event: MouseEvent, uri: string) => {
          const target = deviceServiceLink(uri, this.deviceId);
          this.element.title = target
            ? i18n.t(($) => $.devices.openService, { device: this.deviceId, port: target.port })
            : uri;
        };
        const leaveLink = () => this.element.removeAttribute("title");
        const terminal = new Terminal({
          ...terminalOptions(integer(frame.historyLines, "historyLines", 0, 50000)),
          cols: integer(frame.cols, "cols", 1, 10000),
          rows: integer(frame.rows, "rows", 1, 10000),
          fontFamily: "'Cascadia Code', 'DejaVu Sans Mono', monospace",
          fontSize: Math.max(
            10,
            Math.min(
              24,
              Number(localStorage.getItem("kiteline.terminal-font-size")) ||
                (matchMedia("(max-width: 959px)").matches ? 12 : 13),
            ),
          ),
          lineHeight: 1.2,
          cursorBlink: true,
          disableStdin: true,
          theme: {
            background: styles.getPropertyValue("--terminal").trim(),
            foreground: styles.getPropertyValue("--terminal-foreground").trim(),
            cursor: "#a8c4ef",
            selectionBackground: "#52719588",
          },
          linkHandler: { activate: openLink, hover: hoverLink, leave: leaveLink },
        });
        this.terminal = terminal;
        terminal.unicode.activeVersion = "6";
        terminal.loadAddon(this.fitAddon);
        terminal.loadAddon(new WebLinksAddon(openLink, { hover: hoverLink, leave: leaveLink }));
        const scroll = adaptTerminalScrolling(terminal);
        const source = forwardUserInput(terminal, (text) => {
          const control = this.interaction?.control();
          if (control && text.length === 1 && text.charCodeAt(0) <= 127) {
            if (/[ @-_a-z?]/.test(text))
              text = String.fromCharCode(
                text === "?" ? 127 : text.toUpperCase().charCodeAt(0) & 31,
              );
          }
          this.bytes(new TextEncoder().encode(text));
        });
        const binary = terminal.onBinary((value) =>
          this.bytes(Uint8Array.from(value, (character) => character.charCodeAt(0))),
        );
        this.cleanups.push(
          () => scroll.dispose(),
          () => source.dispose(),
          () => binary.dispose(),
        );
        terminal.open(this.element);
        this.keyboardViewport = new KeyboardViewport(terminal, this.reportReading);
        const readingEvents = [
          terminal.onScroll(this.reportReading),
          terminal.onWriteParsed(this.reportReading),
          terminal.buffer.onBufferChange(this.reportReading),
        ];
        this.element.addEventListener("scroll", this.reportReading);
        this.cleanups.push(() => this.element.removeEventListener("scroll", this.reportReading));
        this.cleanups.push(() => readingEvents.forEach((event) => event.dispose()));
        this.interaction?.opened(terminal);
        this.change({
          status: "connecting",
          historyGap: !!frame.historyGap,
          historyLimited: !!frame.historyLimited,
        });
        break;
      }
      case "resize":
        {
          const cols = integer(frame.cols, "cols", 1, 10000);
          const rows = integer(frame.rows, "rows", 1, 10000);
          if (cols !== this.proposed?.cols || rows !== this.proposed?.rows)
            this.proposed = undefined;
          this.terminal?.resize(cols, rows);
        }
        break;
      case "ready":
        if (this.connectionLost || this.receivedEnd) return;
        if (!this.terminal || this.snapshotRemaining)
          throw new Error("Terminal restoration is incomplete");
        this.ready = true;
        this.change({ ...this.state, status: "ready" });
        break;
      case "ended":
        this.ready = false;
        if (this.terminal) {
          this.terminal.options.disableStdin = true;
          freezeMouse(this.terminal);
          this.keyboardViewport?.dispose();
          this.keyboardViewport = undefined;
          this.cleanups.push(retainReadonlyViewport(this.terminal));
        }
        this.change({
          ...this.state,
          status: "ended",
          exitCode: frame.exitCode === null ? null : Number(frame.exitCode),
          notice: undefined,
          error: undefined,
        });
        break;
      case "error":
        this.fail(new ApiError(String(frame.code), String(frame.message), "failed", frame.details));
        break;
      case "input.error":
        this.change({
          ...this.state,
          error: new ApiError(
            String(frame.code),
            String(frame.message),
            frame.outcome === "unknown" ? "unknown" : "failed",
            frame.details,
          ),
          notice: undefined,
        });
        break;
      default:
        throw new Error("Invalid terminal message");
    }
  }
  private async output(bytes: Uint8Array) {
    const terminal = this.terminal;
    if (this.disposed) return;
    if (!terminal) throw new Error("Missing terminal restoration boundary");
    if (this.snapshotRemaining) {
      if (bytes.length > this.snapshotRemaining)
        throw new Error("Terminal snapshot length mismatch");
      this.snapshotRemaining -= bytes.length;
    }
    await new Promise<void>((resolve) => terminal.write(bytes, resolve));
    this.consumed += bytes.length;
    this.send({ type: "consumed", bytes: this.consumed });
  }
  private send(value: object) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(value);
    if (
      this.socket.bufferedAmount + new TextEncoder().encode(text).length >
      limits.terminalPendingBytes
    )
      throw new Error("Terminal send queue exceeds its limit");
    this.socket.send(text);
  }
  private bytes(data: Uint8Array) {
    if (
      !this.ready ||
      this.receivedEnd ||
      this.terminal?.options.disableStdin ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    if (!this.resize()) return;
    this.keyboardViewport?.followInput();
    if (
      data.length > limits.dataChunkBytes ||
      this.socket.bufferedAmount + data.length > limits.terminalPendingBytes
    ) {
      this.change({ ...this.state, notice: "inputLimit", error: undefined });
      return;
    }
    this.socket.send(data);
  }
  input(text: string) {
    this.terminal?.input(text, true);
  }
  changeFontSize(delta: number) {
    if (!this.terminal) return;
    const size = Math.max(10, Math.min(24, (this.terminal.options.fontSize ?? 13) + delta));
    this.terminal.options.fontSize = size;
    localStorage.setItem("kiteline.terminal-font-size", String(size));
    this.resize();
  }
  paste(text: string) {
    if (!this.ready || this.receivedEnd || this.terminal?.options.disableStdin || !this.meta)
      return;
    const encoder = new TextEncoder();
    if (
      encoder.encode(normalizePaste(text)).length > this.meta.terminalInputBytes ||
      encoder.encode(JSON.stringify({ type: "paste", text })).length > this.meta.controlMessageBytes
    ) {
      this.change({ ...this.state, notice: "pasteLimit", error: undefined });
      return;
    }
    try {
      if (!this.resize()) return;
      this.send({ type: "paste", text });
      this.keyboardViewport?.followInput();
      this.terminal?.scrollToBottom();
    } catch (error) {
      this.change({ ...this.state, error, notice: undefined });
    }
  }
  private onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    this.paste(event.clipboardData?.getData("text/plain") ?? "");
  };
  focus() {
    this.terminal?.focus();
  }
  private reportReading = () => {
    const buffer = this.terminal?.buffer.active;
    this.interaction?.reading(
      !!buffer &&
        ((buffer.type === "normal" && buffer.viewportY < buffer.baseY) ||
          this.keyboardViewport?.isReading() ||
          (this.receivedEnd &&
            this.element.scrollTop + this.element.clientHeight < this.element.scrollHeight - 1)),
    );
  };
  scrollToBottom() {
    this.keyboardViewport?.followInput();
    this.terminal?.scrollToBottom();
    if (this.receivedEnd) this.element.scrollTop = this.element.scrollHeight;
    this.reportReading();
  }
  resize() {
    this.reportReading();
    if (
      !this.ready ||
      this.receivedEnd ||
      this.connectionLost ||
      !this.terminal ||
      this.disposed ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return false;
    const bounds = this.element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    let size = this.fitAddon.proposeDimensions();
    if (!size) return false;
    const font = this.terminal.options.fontSize!;
    const keyboard = isKeyboardOpen();
    if (keyboard) {
      if (
        this.effective &&
        Math.abs(this.effective.width - bounds.width) < 1 &&
        this.effective.font === font
      ) {
        size = { cols: this.effective.cols, rows: this.effective.rows };
      } else if (!this.effective) size.rows = this.terminal.rows;
    }
    size.cols = Math.min(limits.terminalMaxCols, size.cols);
    size.rows = Math.min(limits.terminalMaxRows, size.rows);
    this.effective = { ...size, width: bounds.width, font };
    this.keyboardViewport?.update(keyboard);
    if (size.cols !== this.proposed?.cols || size.rows !== this.proposed?.rows) {
      try {
        this.send({ type: "resize", ...size });
        this.proposed = size;
      } catch (error) {
        this.fail(error);
        return false;
      }
    }
    this.terminal.options.disableStdin = false;
    return true;
  }
  private viewportChanged = () => {
    this.resize();
  };
  private fail(error: unknown) {
    if (this.disposed) return;
    this.finalFrame = true;
    this.connectionLost = true;
    this.ready = false;
    if (this.terminal) this.terminal.options.disableStdin = true;
    this.socket?.close();
    this.cancelChannel();
    this.change({
      ...this.state,
      status: "error",
      code: error instanceof ApiError ? error.code : undefined,
      error,
      notice: undefined,
    });
  }
  private cancelChannel() {
    if (this.channelId) {
      void api(`/api/channels/${encodeURIComponent(this.channelId)}`, { method: "DELETE" }).catch(
        () => {},
      );
      this.channelId = undefined;
    }
  }
  dispose() {
    this.disposed = true;
    this.ready = false;
    this.abort.abort();
    this.observer.disconnect();
    window.removeEventListener("kiteline:viewport", this.viewportChanged);
    this.keyboardViewport?.dispose();
    this.socket?.close();
    this.cancelChannel();
    this.element.removeEventListener("paste", this.onPaste, true);
    for (const cleanup of this.cleanups) cleanup();
    this.terminal?.dispose();
    this.element.replaceChildren();
  }
}
