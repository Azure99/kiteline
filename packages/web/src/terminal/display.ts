import { versionedPath } from "@kiteline/shared/protocol/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { deviceServiceLink } from "../lib/device-service";
import type { BrowserTerminalInput } from "@kiteline/shared/protocol/ipc";
import { terminalOutputCost } from "@kiteline/shared/protocol/ipc";
import { integer, limits, record, type TerminalMeta } from "@kiteline/shared/protocol";
import {
  forwardUserInput,
  freezeMouse,
  normalizePaste,
  adaptTerminalProfile,
  terminalOptions,
  initializeTerminalUnicode,
} from "@kiteline/shared/terminal";
import { ApiError, cancelChannel, openChannel } from "../lib/api";
import { i18n } from "../i18n";
import { retainReadonlyViewport } from "./clipped-screen";
import { isMobile } from "../lib/use-mobile";
import { isKeyboardOpen } from "../lib/viewport";
import { KeyboardViewport } from "./keyboard-viewport";
import { AuxiliaryInput, type Modifiers } from "./auxiliary-input";

const maxReceivedDimension = 10_000;
const fontSizeKey = "kiteline.terminal-font-size";
const clampFontSize = (value: number) => Math.max(10, Math.min(24, value));
const encoder = new TextEncoder();

export interface DisplayState {
  status: "connecting" | "ready" | "ended" | "error";
  error?: unknown;
  notice?: "connectionLost" | "inputLimit" | "pasteLimit";
  exitCode?: number | null;
  /** Ended because a session list no longer has it, not because an end frame arrived. */
  missing?: boolean;
  historyLimited?: boolean;
  historyGap?: boolean;
}
export interface TerminalTarget {
  deviceId: string;
  workspaceId: string;
  sessionId: string;
}
interface DisplayOptions {
  host: HTMLElement;
  target: TerminalTarget;
  history?: "retained" | "screen";
  events: {
    state: (state: DisplayState) => void;
    opened?: (terminal: Terminal) => void;
    title?: (title: string) => void;
    reading?: (value: boolean) => void;
    modifiers?: (value: Modifiers) => void;
  };
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
  private parsed: Promise<void> = Promise.resolve();
  private receiveStopped = false;
  private ready = false;
  private disposed = false;
  private snapshotRemaining = 0;
  private consumed = 0;
  private proposed?: { cols: number; rows: number };
  private effective?: { cols: number; rows: number; width: number; font: number };
  private keyboardViewport?: KeyboardViewport;
  private auxiliary?: AuxiliaryInput;
  private cleanups: (() => void)[] = [];
  state: DisplayState = { status: "connecting" };
  constructor(private options: DisplayOptions) {
    const { host, history = "retained" } = options;
    this.observer = new ResizeObserver(() => this.syncViewportAndInput());
    this.observer.observe(host);
    window.addEventListener("kiteline:viewport", this.viewportChanged);
    host.addEventListener("paste", this.onPaste, true);
    void this.connect(history);
  }
  private change(state: DisplayState) {
    this.state = state;
    if (!this.disposed) this.options.events.state(state);
  }
  private async connect(history: "retained" | "screen") {
    try {
      const channel = await openChannel(
        this.options.target.deviceId,
        "terminal.attach",
        {
          workspaceId: this.options.target.workspaceId,
          sessionId: this.options.target.sessionId,
          history,
        },
        this.abort.signal,
      );
      this.channelId = channel.channelId;
      if (this.disposed) {
        this.cancelChannel();
        return;
      }
      this.meta = channel.meta;
      const url = new URL(
        versionedPath(`/api/channels/${encodeURIComponent(channel.channelId)}/terminal`),
        location.href,
      );
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (this.disposed || this.receiveStopped) return;
        try {
          if (event.data instanceof ArrayBuffer) {
            const data = new Uint8Array(event.data);
            this.queue = this.queue
              .then(() => {
                if (!this.ready) return this.output(data);
                this.parsed = this.output(data).catch((error: unknown) => this.fail(error));
              })
              .catch((error: unknown) => this.fail(error));
          } else {
            const frame = record(JSON.parse(event.data));
            const credit = terminalOutputCost(encoder.encode(event.data).length);
            const ordered = frame.type !== "input.error" && frame.type !== "error";
            if (frame.type === "ended" || frame.type === "error") {
              this.receiveStopped = true;
              if (this.terminal) this.terminal.options.disableStdin = true;
            }
            this.queue = this.queue
              .then(async () => {
                await this.parsed;
                await this.frame(frame);
                if (ordered) this.acknowledge(credit);
              })
              .catch((error: unknown) => this.fail(error));
          }
        } catch (error) {
          this.fail(error);
        }
      };
      socket.onerror = () => {
        if (!this.receiveStopped) this.fail(new Error("Terminal connection failed"));
      };
      socket.onclose = () => {
        if (!this.receiveStopped && !this.disposed) {
          this.receiveStopped = true;
          this.ready = false;
          if (this.terminal) this.terminal.options.disableStdin = true;
          this.queue = this.queue.then(async () => {
            await this.parsed;
            this.change({
              ...this.state,
              status: "error",
              notice: "connectionLost",
              error: undefined,
            });
          });
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
        if (this.terminal) throw new Error("Invalid terminal restoration boundary");
        this.snapshotRemaining = integer(
          frame.snapshotBytes,
          "snapshotBytes",
          0,
          limits.terminalSnapshotBytes,
        );
        const styles = getComputedStyle(document.documentElement);
        const openLink = (_event: MouseEvent, uri: string) => {
          if (terminal.hasSelection()) return;
          if (/^https?:\/\//i.test(uri))
            window.open(
              deviceServiceLink(uri, this.options.target.deviceId)?.url ?? uri,
              "_blank",
              "noopener,noreferrer",
            );
        };
        const hoverLink = (_event: MouseEvent, uri: string) => {
          const target = deviceServiceLink(uri, this.options.target.deviceId);
          this.options.host.title = target
            ? i18n.t(($) => $.devices.openDevicePort, { port: target.port })
            : uri;
        };
        const leaveLink = () => this.options.host.removeAttribute("title");
        let savedFontSize = 0;
        try {
          savedFontSize = Number(localStorage.getItem(fontSizeKey));
        } catch {
          // Font preferences are optional when browser storage is unavailable.
        }
        const terminal = new Terminal({
          ...terminalOptions(
            integer(frame.historyLines, "historyLines", 0, limits.terminalHistoryLines),
          ),
          cols: integer(frame.cols, "cols", 1, maxReceivedDimension),
          rows: integer(frame.rows, "rows", 1, maxReceivedDimension),
          fontFamily: "'Cascadia Code', 'DejaVu Sans Mono', monospace",
          fontSize: clampFontSize(savedFontSize || (isMobile() ? 12 : 13)),
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
        initializeTerminalUnicode(terminal);
        terminal.loadAddon(this.fitAddon);
        terminal.loadAddon(new WebLinksAddon(openLink, { hover: hoverLink, leave: leaveLink }));
        adaptTerminalProfile(terminal);
        forwardUserInput(terminal, (text) => {
          const value = this.auxiliary ? this.auxiliary.forward(text) : text;
          if (value !== undefined) this.bytes(new TextEncoder().encode(value));
        });
        const binary = terminal.onBinary((value) =>
          this.bytes(Uint8Array.from(value, (character) => character.charCodeAt(0))),
        );
        this.cleanups.push(() => binary.dispose());
        terminal.open(this.options.host);
        this.auxiliary = new AuxiliaryInput(terminal, (value) =>
          this.options.events.modifiers?.(value),
        );
        this.keyboardViewport = new KeyboardViewport(terminal, this.reportReading);
        const selectionResize = terminal.onResize(() => terminal.clearSelection());
        this.cleanups.push(() => selectionResize.dispose());
        const readingEvents = [
          terminal.onScroll(this.reportReading),
          terminal.onWriteParsed(this.reportReading),
          terminal.buffer.onBufferChange(this.reportReading),
        ];
        this.options.host.addEventListener("scroll", this.reportReading);
        this.cleanups.push(() =>
          this.options.host.removeEventListener("scroll", this.reportReading),
        );
        this.cleanups.push(() => readingEvents.forEach((event) => event.dispose()));
        const titleSubscription = terminal.onTitleChange((title) =>
          this.options.events.title?.(title),
        );
        this.cleanups.push(() => titleSubscription.dispose());
        this.options.events.opened?.(terminal);
        this.change({
          status: "connecting",
          historyGap: !!frame.historyGap,
          historyLimited: !!frame.historyLimited,
        });
        break;
      }
      case "resize":
        {
          const cols = integer(frame.cols, "cols", 1, maxReceivedDimension);
          const rows = integer(frame.rows, "rows", 1, maxReceivedDimension);
          if (cols !== this.proposed?.cols || rows !== this.proposed?.rows)
            this.proposed = undefined;
          this.terminal?.resize(cols, rows);
        }
        break;
      case "ready":
        if (this.receiveStopped) return;
        if (!this.terminal || this.snapshotRemaining)
          throw new Error("Terminal restoration is incomplete");
        this.ready = true;
        this.change({ ...this.state, status: "ready" });
        break;
      case "ended":
        this.end({ exitCode: frame.exitCode === null ? null : Number(frame.exitCode) });
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
  retainScreen() {
    if (!this.terminal) return;
    this.terminal.options.disableStdin = true;
    freezeMouse(this.terminal);
    this.keyboardViewport?.dispose();
    this.keyboardViewport = undefined;
    // A retained recovery screen may subsequently receive sessionMissing/end.
    if (!this.options.host.classList.contains("terminal-readonly"))
      this.cleanups.push(retainReadonlyViewport(this.terminal));
    // The read-only viewport may now scroll; show "Back to bottom" without waiting for a resize.
    this.reportReading();
  }
  private end(result: Pick<DisplayState, "exitCode" | "missing">) {
    this.ready = false;
    this.retainScreen();
    this.change({ ...this.state, status: "ended", ...result, notice: undefined, error: undefined });
  }
  /** Keeps a disconnected display's last screen read-only once its session no longer exists. */
  sessionMissing() {
    if (this.disposed || this.state.status !== "error") return;
    this.end({ exitCode: null, missing: true });
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
    this.acknowledge(terminalOutputCost(bytes.length));
  }
  private acknowledge(credit: number) {
    this.consumed += credit;
    this.send({ type: "consumed", bytes: this.consumed });
  }
  private send(value: BrowserTerminalInput) {
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
    const socket = this.syncViewportAndInput();
    if (!socket) return;
    this.keyboardViewport?.followInput();
    if (
      data.length > limits.dataChunkBytes ||
      socket.bufferedAmount + data.length > limits.terminalPendingBytes
    ) {
      this.change({ ...this.state, notice: "inputLimit", error: undefined });
      return;
    }
    socket.send(data);
  }
  key(key: string) {
    this.auxiliary?.key(key);
  }
  toggleModifier(key: keyof Modifiers) {
    this.auxiliary?.toggle(key);
  }
  releaseModifiers() {
    this.auxiliary?.release();
  }
  changeFontSize(delta: number) {
    if (!this.terminal) return;
    const size = clampFontSize((this.terminal.options.fontSize ?? 13) + delta);
    this.terminal.options.fontSize = size;
    try {
      localStorage.setItem(fontSizeKey, String(size));
    } catch {
      // The current terminal still uses the selected size.
    }
    this.syncViewportAndInput();
  }
  paste(text: string) {
    if (!this.ready || this.terminal?.options.disableStdin || !this.meta) return;
    this.releaseModifiers();
    const encoder = new TextEncoder();
    if (
      encoder.encode(normalizePaste(text)).length > this.meta.terminalInputBytes ||
      encoder.encode(JSON.stringify({ type: "paste", text })).length > limits.controlMessageBytes
    ) {
      this.change({ ...this.state, notice: "pasteLimit", error: undefined });
      return;
    }
    try {
      if (!this.syncViewportAndInput()) return;
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
    this.options.events.reading?.(
      !!buffer &&
        ((buffer.type === "normal" && buffer.viewportY < buffer.baseY) ||
          this.keyboardViewport?.isReading() ||
          (this.options.host.classList.contains("terminal-readonly") &&
            this.options.host.scrollTop + this.options.host.clientHeight <
              this.options.host.scrollHeight - 1)),
    );
  };
  scrollToBottom() {
    this.keyboardViewport?.followInput();
    this.terminal?.scrollToBottom();
    if (this.options.host.classList.contains("terminal-readonly"))
      this.options.host.scrollTop = this.options.host.scrollHeight;
    this.reportReading();
  }
  syncViewportAndInput() {
    this.reportReading();
    const socket = this.socket;
    if (
      !this.ready ||
      this.receiveStopped ||
      !this.terminal ||
      this.disposed ||
      socket?.readyState !== WebSocket.OPEN
    )
      return;
    const bounds = this.options.host.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    let size = this.fitAddon.proposeDimensions();
    if (!size) return;
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
        return;
      }
    }
    this.terminal.options.disableStdin = false;
    return socket;
  }
  private viewportChanged = () => {
    this.syncViewportAndInput();
  };
  private fail(error: unknown) {
    if (this.disposed) return;
    this.receiveStopped = true;
    this.ready = false;
    if (this.terminal) this.terminal.options.disableStdin = true;
    this.socket?.close();
    this.cancelChannel();
    this.change({
      ...this.state,
      status: "error",
      error,
      notice: undefined,
    });
  }
  private cancelChannel() {
    if (this.channelId) {
      void cancelChannel(this.channelId).catch(() => {});
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
    this.auxiliary?.dispose();
    this.socket?.close();
    this.cancelChannel();
    this.options.host.removeEventListener("paste", this.onPaste, true);
    for (const cleanup of this.cleanups) cleanup();
    this.terminal?.dispose();
    this.options.host.replaceChildren();
  }
}
