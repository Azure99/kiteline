import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmux } from "@kiteline/shared/terminal/node";
import { Control } from "../src/control.js";

test.each(["C#Sharp", "literal#(printf changed)", "end;", "space ' \" $"])(
  "login Shell starts in the literal workspace %s",
  async (name) => {
    const root = await mkdtemp("/var/tmp/kiteline-create-");
    const workspacePath = join(root, name);
    const socket = join(root, "tmux.sock");
    const faults: Error[] = [];
    const control = new Control(
      {
        type: "create",
        sessionId: "literal",
        socket,
        tmuxSession: "kiteline",
        workspacePath,
        shell: "/bin/bash",
        cols: 80,
        rows: 24,
        historyLines: 100,
      },
      { output: () => {}, resize: () => {}, dead: () => {}, fault: (error) => faults.push(error) },
      3000,
    );
    try {
      await mkdir(workspacePath);
      await control.start();
      const [pid] = await control.command("display-message -p '#{pane_pid}'");
      expect(await readlink(`/proc/${pid}/cwd`)).toBe(workspacePath);
      expect(faults).toEqual([]);
    } finally {
      control.dispose();
      await tmux(socket, ["kill-server"]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  { command: "printf %s \\;", result: ";" },
  { command: "printf OK;", result: "OK" },
])("shortcut data keeps its trailing semicolon: $command", async ({ command, result }) => {
  const root = await mkdtemp("/var/tmp/kiteline-create-");
  const workspacePath = join(root, "C#Sharp;");
  const shell = join(root, "shell;");
  const socket = join(root, "tmux.sock");
  const faults: Error[] = [];
  let end!: (code: number | null) => void;
  const ended = new Promise<number | null>((resolve) => (end = resolve));
  const control = new Control(
    {
      type: "create",
      sessionId: "shortcut",
      socket,
      tmuxSession: "kiteline",
      workspacePath,
      shell,
      command: `pwd > cwd.txt; exec > result.txt; ${command}`,
      cols: 200,
      rows: 24,
      historyLines: 100,
    },
    {
      output: () => {},
      resize: () => {},
      dead: end,
      fault: (error) => faults.push(error),
    },
    3000,
  );
  try {
    await mkdir(workspacePath);
    await symlink("/bin/bash", shell);
    await control.start();
    expect(await ended).toBe(0);
    expect(await readFile(join(workspacePath, "cwd.txt"), "utf8")).toBe(`${workspacePath}\n`);
    expect(await readFile(join(workspacePath, "result.txt"), "utf8")).toBe(result);
    expect(faults).toEqual([]);
  } finally {
    control.dispose();
    await tmux(socket, ["kill-server"]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
