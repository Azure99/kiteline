import { AppError, asError, terminalProfile } from "@kiteline/shared/protocol";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CreateTerminal,
  RecoverTerminal,
  TerminalIdentity,
  RecorderConfig,
  RecorderMessage,
  TerminalFrame,
} from "@kiteline/shared/ipc";
import { tmux } from "@kiteline/shared/terminal/node";
import { Control } from "./control.js";
import { Model } from "./model.js";
import { Attachment } from "./attachment.js";
import { InputQueue } from "./input.js";

interface Display {
  attachment: Attachment;
  abort: AbortController;
  unsubscribe?: () => void;
  ready: boolean;
}
export class RecordedSession {
  readonly model: Model;
  readonly control: Control;
  readonly input: InputQueue;
  readonly displays = new Map<string, Display>();
  private ended = false;
  private failed = false;
  private starting?: Promise<TerminalIdentity>;
  private initialized: boolean;
  constructor(
    readonly options: CreateTerminal | RecoverTerminal,
    readonly config: RecorderConfig,
    private emit: (message: RecorderMessage, owner?: string) => boolean,
    private release: () => void,
  ) {
    this.initialized = "shell" in options;
    this.model = new Model(options.cols, options.rows, options.historyLines, (error) =>
      this.fault(error),
    );
    this.control = new Control(
      options,
      {
        output: (data) => {
          if (this.initialized) this.model.output(data);
        },
        resize: (cols, rows) => {
          if (this.initialized) this.model.resize(cols, rows);
        },
        dead: (code) => this.finish(code),
        fault: (error) => this.fault(error),
      },
      config.channelPairTimeout,
    );
    this.input = new InputQueue(
      this.control,
      this.model,
      config,
      (id, frame) => {
        this.frame(id, frame);
      },
      () => this.redrawTask(),
    );
  }
  start() {
    return (this.starting ??= this.initialize());
  }
  private async initialize() {
    const identity = await this.control.start();
    if (!this.initialized) {
      await this.control.command("delete-buffer -b kiteline-web-input").catch((error: unknown) => {
        if (
          !(error instanceof AppError) ||
          error.code !== "command_failed" ||
          error.message !== "unknown buffer: kiteline-web-input"
        )
          throw error;
      });
      const snapshot = await this.control.capture();
      this.model.resize(snapshot.cols, snapshot.rows);
      this.model.output(Buffer.from(snapshot.data));
      await this.model.checkpointNow();
      this.initialized = true;
      await this.input.redraw();
      await this.model.checkpointNow();
    }
    if (this.failed || this.ended)
      throw new AppError("recording_unavailable", "Terminal ended or recording interrupted");
    return identity;
  }
  private async redrawTask() {
    const { cols, rows } = await this.model.ordered(() => ({
      cols: this.model.terminal.cols,
      rows: this.model.terminal.rows,
    }));
    try {
      await this.control.resize(cols, rows + 1);
      await this.model.waitForSize(cols, rows + 1, this.config.channelPairTimeout);
      await delay(80);
    } finally {
      await this.control.resize(cols, rows);
      await this.model.waitForSize(cols, rows, this.config.channelPairTimeout);
    }
  }
  private frame(id: string, frame: TerminalFrame) {
    if (frame.type === "ready") {
      const display = this.displays.get(id);
      if (display) display.ready = true;
    }
    return this.emit(
      { type: "frame", sessionId: this.options.sessionId, attachmentId: id, frame },
      frame.type === "error" || frame.type === "ended" ? undefined : id,
    );
  }
  async attach(id: string, profile: string, history: "retained" | "screen", historyGap: boolean) {
    if (profile !== terminalProfile)
      throw new AppError(
        "unsupported",
        "Terminal component versions differ; upgrade all components together",
      );
    if (this.ended || this.failed)
      throw new AppError("recording_unavailable", "Terminal recording is unavailable");
    if (this.displays.has(id)) throw new AppError("conflict", "Display is already attached");
    const abort = new AbortController();
    const attachment = new Attachment(
      id,
      this.config.terminalStallTimeout,
      (piece) =>
        Buffer.isBuffer(piece)
          ? this.emit(
              {
                type: "bytes",
                sessionId: this.options.sessionId,
                attachmentId: id,
                dataBase64: piece.toString("base64"),
              },
              id,
            )
          : this.frame(id, piece),
      () => {
        const display = this.displays.get(id);
        this.displays.delete(id);
        display?.unsubscribe?.();
        abort.abort(new AppError("cancelled", "Display closed"));
        this.input.detach(id);
        this.maybeRelease();
      },
    );
    const display: Display = { attachment, abort, ready: false };
    this.displays.set(id, display);
    try {
      display.unsubscribe = await this.model.attach(
        history,
        this.config.channelPairTimeout,
        (snapshot) => attachment.start(snapshot, this.options.historyLines, historyGap),
        attachment.output,
        abort.signal,
      );
      if (abort.signal.aborted) display.unsubscribe();
    } catch (error) {
      attachment.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  private maybeRelease() {
    if ((this.ended || this.failed) && !this.displays.size) this.release();
  }
  detach(id: string) {
    this.displays.get(id)?.attachment.close();
  }
  consumed(id: string, bytes: number) {
    this.displays.get(id)?.attachment.acknowledge(bytes);
  }
  acceptsInput(id: string) {
    return !this.ended && !this.failed && this.displays.get(id)?.ready;
  }
  private finish(exitCode: number | null) {
    void this.model.ordered(() => {
      if (this.ended || this.failed) return;
      this.ended = true;
      this.input.close();
      this.control.dispose();
      for (const display of this.displays.values()) display.attachment.end(exitCode);
      this.emit({ type: "ended", sessionId: this.options.sessionId, exitCode });
      void this.model.dispose();
      this.maybeRelease();
    });
  }
  fault(error: Error) {
    if (this.ended || this.failed) return;
    this.failed = true;
    this.input.close();
    this.control.dispose(error);
    const fault = new AppError("recording_unavailable", error.message);
    for (const display of this.displays.values()) display.attachment.fail(fault);
    this.emit({ type: "fault", sessionId: this.options.sessionId, error: asError(fault) });
    void this.model.dispose();
    this.maybeRelease();
  }
  async end() {
    await this.starting?.catch(() => {});
    this.control.dispose();
    await tmux(
      this.options.socket,
      ["kill-server"],
      undefined,
      AbortSignal.timeout(this.config.channelPairTimeout),
    );
    this.finish(null);
  }
  async close() {
    this.failed = true;
    this.input.close();
    this.control.dispose();
    for (const display of this.displays.values()) display.attachment.close();
    await this.model.dispose();
  }
}
