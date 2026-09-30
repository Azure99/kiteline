import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import type { Writable } from "node:stream";
import { AppError, limits } from "@kiteline/shared/protocol";
import { readLines } from "@kiteline/shared/stdio";
import {
  exitCodeFormat,
  msysDirectory,
  msysPath,
  shellWords,
  terminalPreset,
  tmuxBinary,
  tmuxEnvironment,
  tmuxSession,
} from "@kiteline/shared/terminal/node";
import { paneCommand } from "@kiteline/shared/terminal/windows";
import { spawnJob, type JobChild } from "@kiteline/shared/windows/job";
import type { TerminalSource, TerminalIdentity } from "@kiteline/shared/ipc";

interface Pending {
  resolve: (result: string[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
interface ControlEvents {
  output: (data: Buffer) => void;
  resize: (cols: number, rows: number) => void;
  dead: (code: number | null) => void;
  fault: (error: Error) => void;
}
function decodeOutput(value: Buffer) {
  const result = Buffer.allocUnsafe(value.length);
  let length = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === 92) {
      const digits = value.subarray(index + 1, index + 4).toString("ascii");
      if (!/^[0-7]{3}$/.test(digits)) throw new Error("Invalid tmux output escape");
      result[length++] = Number.parseInt(digits, 8);
      index += 3;
    } else result[length++] = value[index]!;
  }
  return result.subarray(0, length);
}
export class Control {
  private child?: ChildProcessWithoutNullStreams;
  private job?: JobChild;
  private stdin?: Writable;
  private starting?: Promise<TerminalIdentity>;
  private stopped?: Promise<void>;
  private pending: Pending[] = [];
  private block?: { guard: string; lines: string[]; bytes: number; pending: Pending };
  private disposed = false;
  private stderr = "";
  private initializing = true;
  private initialDeath?: number | null;
  identity?: TerminalIdentity;
  constructor(
    private options: TerminalSource,
    private events: ControlEvents,
    private timeout: number,
  ) {}

  start() {
    return (this.starting ??= this.initialize().catch((error: unknown) => {
      this.dispose(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }));
  }
  private async initialize(): Promise<TerminalIdentity> {
    const o = this.options;
    const creating = o.type === "create";
    const config = join(dirname(this.options.socket), "tmux.conf");
    if (creating && process.platform !== "win32")
      await writeFile(config, terminalPreset(o), { mode: 0o600 });
    if (this.disposed) throw new AppError("cancelled", "Terminal creation interrupted");
    const started = this.expect();
    void started.catch(() => {});
    const command = creating
      ? [
          "new-session",
          "-P",
          "-F",
          "#{pane_id} #{window_id} #{pane_width} #{pane_height}",
          "-s",
          tmuxSession,
          "-x",
          String(o.cols),
          "-y",
          String(o.rows),
          // tmux removes one escape before a trailing argv semicolon.
          ...(process.platform === "win32"
            ? paneCommand(o.socket)
            : o.command === undefined
              ? [o.shell, "-l"]
              : [o.shell, "-lc", o.command]
          ).map((value) => value.replace(/;$/, "\\;")),
        ]
      : ["attach-session", "-E", "-t", tmuxSession];
    if (!creating) this.identity = o;
    let stdout;
    let stderr;
    if (process.platform === "win32") {
      const args = ["-N", "-S", msysPath(o.socket), "-f", msysPath(config), "-u", "-C", ...command];
      this.job = await spawnJob(
        join(msysDirectory, "usr/bin/script.exe"),
        [
          "-qef",
          "-E",
          "never",
          "-c",
          "/usr/bin/stty raw -echo && exec " + shellWords([msysPath(tmuxBinary), ...args]),
          "/dev/null",
        ],
        { cwd: creating ? o.workspacePath : undefined, env: tmuxEnvironment() },
      );
      const job = this.job;
      this.stdin = job.stdin!;
      stdout = job.stdout!;
      stderr = job.stderr!;
      const drained = Promise.all([
        finished(stdout, { writable: false, cleanup: true }),
        finished(stderr, { writable: false, cleanup: true }),
      ]);
      void drained.catch(() => {});
      this.stopped = (async () => {
        await job.exited;
        await job.stop();
        await drained;
      })().then(
        () => this.fail(new Error(this.stderr.trim() || "tmux control connection closed")),
        (error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))),
      );
    } else {
      this.child = spawn(tmuxBinary, ["-S", o.socket, "-f", config, "-u", "-C", ...command], {
        // -c expands tmux formats; the new private server inherits this literal cwd.
        cwd: creating ? o.workspacePath : undefined,
        env: tmuxEnvironment(),
        stdio: "pipe",
      });
      this.stdin = this.child.stdin;
      stdout = this.child.stdout;
      stderr = this.child.stderr;
      this.child.on("error", (error) => this.fail(error));
      this.stopped = new Promise<void>((resolve) => {
        this.child!.on("close", () => {
          this.fail(new Error(this.stderr.trim() || "tmux control connection closed"));
          resolve();
        });
      });
    }
    this.stdin.on("error", (error) => this.fail(error));
    stderr.on("data", (data: Buffer) => {
      if (this.stderr.length < 8192) this.stderr += data.toString();
    });
    readLines(
      stdout,
      (line) => this.line(line),
      (error) => this.fail(error),
    );
    if (this.disposed) {
      this.terminate();
      throw new AppError("cancelled", "Terminal creation interrupted");
    }
    const output = await started;
    const identity = creating
      ? output
      : await this.command(
          `display-message -p -t ${tmuxSession} '#{pane_id} #{window_id} #{pane_width} #{pane_height}'`,
        );
    const match = /^(%\d+) (@\d+) (\d+) (\d+)$/.exec(identity[0] ?? "");
    if (!match) throw new Error("tmux did not return the terminal identity");
    this.identity = {
      socket: o.socket,
      paneId: match[1]!,
      windowId: match[2]!,
    };
    await this.command(`refresh-client -B 'life:%*:#{pane_dead} ${exitCodeFormat}'`);
    const life = await this.command(
      `display-message -p -t ${this.identity.paneId} '#{pane_dead} ${exitCodeFormat}'`,
    );
    this.life(life[0] ?? "");
    this.initializing = false;
    if (this.initialDeath !== undefined) this.events.dead(this.initialDeath);
    return this.identity;
  }
  async capture() {
    const pane = this.identity!.paneId;
    const format = await this.command(
      `display-message -p -t ${pane} '#{pane_width} #{pane_height} #{alternate_on} #{cursor_x} #{cursor_y} #{cursor_flag} #{keypad_cursor_flag}'`,
    );
    const fields = format[0]?.split(" ").map(Number);
    if (!fields || fields.length !== 7 || fields.some((value) => !Number.isSafeInteger(value)))
      throw new AppError("io_error", "Could not read the existing terminal screen");
    const [cols, rows, alternate, x, y, cursor, applicationCursor] = fields as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const lines = await this.command(`capture-pane -p -e -t ${pane}`);
    const data =
      "\x1bc" +
      (alternate ? "\x1b[?1049h" : "") +
      "\x1b[?7l" +
      lines
        .slice(0, rows)
        .map((line, index) => `\x1b[${index + 1};1H${line}\x1b[0m`)
        .join("") +
      `\x1b[?7h\x1b[${y + 1};${x + 1}H\x1b[?25${cursor ? "h" : "l"}\x1b[?1${applicationCursor ? "h" : "l"}`;
    return { cols, rows, data };
  }
  private expect() {
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new AppError("timeout", "tmux control command timed out")),
        this.timeout,
      );
      this.pending.push({ resolve, reject, timer });
    });
  }
  command(value: string) {
    if (this.disposed)
      return Promise.reject(new AppError("recording_unavailable", "Recording interrupted"));
    const result = this.expect();
    this.stdin!.write(value + "\n");
    return result;
  }
  async resize(cols: number, rows: number) {
    if (!this.identity) throw new AppError("busy", "Terminal is still being created");
    await this.command(`select-window -t ${this.identity.windowId}`);
    await this.command(`refresh-client -C ${cols}x${rows}`);
  }
  private life(value: string) {
    const match = /^1(?: (\d*))?$/.exec(value.trimEnd());
    if (match) {
      const value = match[1] ? Number(match[1]) : null;
      const code = value !== null && value <= 0xffffffff ? value : null;
      if (this.initializing) this.initialDeath = code;
      else this.events.dead(code);
    }
  }
  private line(line: Buffer) {
    if (this.disposed) return;
    const text = line.toString("utf8");
    if (this.block) {
      const block = this.block;
      if (text === `%end ${block.guard}` || text === `%error ${block.guard}`) {
        this.block = undefined;
        clearTimeout(block.pending.timer);
        if (text.startsWith("%error "))
          block.pending.reject(new AppError("command_failed", block.lines.join("\n")));
        else block.pending.resolve(block.lines);
      } else {
        block.bytes += line.length;
        if (block.bytes > limits.controlMessageBytes)
          throw new AppError("limit_exceeded", "tmux command result exceeds the size limit");
        block.lines.push(text);
      }
      return;
    }
    if (text.startsWith("%begin ")) {
      const pending = this.pending.shift();
      if (!pending) throw new Error("tmux command stream lost its request boundary");
      this.block = { guard: text.slice(7), lines: [], bytes: 0, pending };
      return;
    }
    const output = /^%output (%\d+) /.exec(text);
    if (output) {
      if (this.identity && output[1] !== this.identity.paneId)
        throw new Error("An unexpected pane appeared in the managed terminal");
      this.events.output(decodeOutput(line.subarray(output[0].length)));
      return;
    }
    if (text.startsWith("%layout-change ")) {
      const layout = /^%layout-change (@\d+) [^,]+,(\d+)x(\d+),0,0,(\d+) /.exec(text);
      if (
        !layout ||
        (this.identity &&
          (layout[1] !== this.identity.windowId || `%${layout[4]}` !== this.identity.paneId))
      )
        throw new Error("Managed terminal layout changed");
      this.events.resize(Number(layout[2]), Number(layout[3]));
      return;
    }
    if (text.startsWith("%subscription-changed life ")) {
      const life = /^%subscription-changed life \$\d+ (@\d+) \d+ (%\d+) : (.*)$/.exec(text);
      if (
        life &&
        (!this.identity || (life[1] === this.identity.windowId && life[2] === this.identity.paneId))
      )
        this.life(life[3]!);
    } else if (/^%(?:pause|continue|extended-output|exit)(?: |$)/.test(text))
      throw new Error(`Terminal recording interrupted: ${text}`);
  }
  private fail(error: Error) {
    if (this.disposed) return;
    this.dispose(error);
    this.events.fault(error);
  }
  dispose(error = new Error("Control closed")) {
    if (this.disposed) return;
    this.disposed = true;
    if (this.block) {
      clearTimeout(this.block.pending.timer);
      this.block.pending.reject(error);
      this.block = undefined;
    }
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.terminate();
  }
  private terminate() {
    this.job?.terminate();
    this.child?.kill("SIGTERM");
  }
  async close() {
    this.dispose();
    await this.starting?.catch(() => {});
    await this.stopped;
  }
}
