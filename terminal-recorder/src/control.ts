import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError, limits } from "@kiteline/shared/protocol";
import { readLines } from "@kiteline/shared/stdio";
import { tmuxBinary, tmuxEnvironment } from "@kiteline/shared/terminal/node";
import type { CreateTerminal, RecoverTerminal, TerminalIdentity } from "@kiteline/shared/ipc";

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
function preset(options: CreateTerminal) {
  return [
    "set -g status off",
    "set -g window-size latest",
    "set -g default-terminal tmux-256color",
    `set -g history-limit ${options.historyLines}`,
    `set -g default-size ${options.cols}x${options.rows}`,
    "set -g remain-on-exit on",
    "set -g mouse on",
    "set -g allow-passthrough off",
    "set -g set-clipboard external",
    "unbind-key -a -T prefix",
    "bind-key -T prefix C-b send-prefix",
    "bind-key -T prefix d detach-client",
    "bind-key -T prefix [ copy-mode",
    "bind-key -T prefix ] paste-buffer -p",
    "bind-key -T root MouseDown3Pane send-keys -M",
    "unbind-key -T root M-MouseDown3Pane",
    "",
  ].join("\n");
}

export class Control {
  private child!: ChildProcessWithoutNullStreams;
  private pending: Pending[] = [];
  private block?: { guard: string; lines: string[]; bytes: number; pending: Pending };
  private disposed = false;
  private stderr = "";
  private initializing = true;
  private initialDeath?: number | null;
  identity?: TerminalIdentity;
  constructor(
    private options: CreateTerminal | RecoverTerminal,
    private events: ControlEvents,
    private timeout: number,
  ) {}

  async start(): Promise<TerminalIdentity> {
    const o = this.options;
    const creating = "shell" in o;
    const config = join(dirname(this.options.socket), "tmux.conf");
    if (creating) await writeFile(config, preset(o), { mode: 0o600 });
    if (this.disposed) throw new AppError("cancelled", "Terminal creation interrupted");
    const started = this.expect();
    const command = creating
      ? [
          "new-session",
          "-P",
          "-F",
          "#{pane_id} #{window_id} #{pane_width} #{pane_height}",
          "-s",
          o.tmuxSession,
          "-x",
          String(o.cols),
          "-y",
          String(o.rows),
          "-c",
          o.workspacePath,
          ...(o.command === undefined ? [o.shell, "-l"] : [o.shell, "-lc", o.command]),
        ]
      : ["attach-session", "-E", "-t", o.tmuxSession];
    if (!creating) this.identity = o;
    this.child = spawn(tmuxBinary, ["-S", o.socket, "-f", config, "-u", "-C", ...command], {
      env: tmuxEnvironment(),
      stdio: "pipe",
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (data: Buffer) => {
      if (this.stderr.length < 8192) this.stderr += data.toString();
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", () =>
      this.fail(new Error(this.stderr.trim() || "tmux control connection closed")),
    );
    readLines(
      this.child.stdout,
      (line) => this.line(line),
      (error) => this.fail(error),
    );
    const output = await started;
    const identity = creating
      ? output
      : await this.command(
          `display-message -p -t ${o.tmuxSession} '#{pane_id} #{window_id} #{pane_width} #{pane_height}'`,
        );
    const match = /^(%\d+) (@\d+) (\d+) (\d+)$/.exec(identity[0] ?? "");
    if (!match) throw new Error("tmux did not return the terminal identity");
    this.identity = {
      socket: o.socket,
      tmuxSession: o.tmuxSession,
      paneId: match[1]!,
      windowId: match[2]!,
    };
    await this.command("refresh-client -B 'life:%*:#{pane_dead} #{pane_dead_status}'");
    const life = await this.command(
      `display-message -p -t ${this.identity.paneId} '#{pane_dead} #{pane_dead_status}'`,
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
    this.child.stdin.write(value + "\n");
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
      const code = match[1] ? Number(match[1]) : null;
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
    this.child?.kill("SIGTERM");
  }
}
