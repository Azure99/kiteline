import { afterEach, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { TerminalDisplay, DisplayState, ProgramCopyRequest } from "../src/terminal/display";
import { TerminalScreens, type TerminalScreenSnapshot } from "../src/terminal/screens";

type DisplayOptions = ConstructorParameters<typeof TerminalDisplay>[0];
interface ControlledDisplay {
  options: DisplayOptions;
  state: DisplayState;
  terminal?: Terminal;
  change(state: DisplayState): void;
}
const { displays } = vi.hoisted(() => ({ displays: [] as ControlledDisplay[] }));

vi.mock("../src/terminal/display", () => ({
  TerminalDisplay: class implements ControlledDisplay {
    state: DisplayState = { status: "connecting" };
    terminal = {} as Terminal;
    constructor(public options: DisplayOptions) {
      displays.push(this);
    }
    change(state: DisplayState) {
      this.state = state;
      this.options.events.state(state);
    }
    retainScreen() {}
    dispose() {}
  },
}));

const owners: TerminalScreens[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  displays.length = 0;
  vi.unstubAllGlobals();
});

function createScreens() {
  vi.stubGlobal("document", {
    createElement: () => ({ style: {}, remove() {} }),
  });
  const snapshots: TerminalScreenSnapshot[] = [];
  const screens = new TerminalScreens(
    { append() {} } as unknown as HTMLElement,
    { deviceId: "d", workspaceId: "w", sessionId: "s" },
    (snapshot) => snapshots.push(snapshot),
  );
  owners.push(screens);
  displays[0]!.change({ status: "ready" });
  return { screens, snapshot: () => snapshots.at(-1)!, current: displays[0]! };
}

function request(display: ControlledDisplay, text = "program text"): ProgramCopyRequest {
  const value = { text };
  display.options.events.copyRequest!(value);
  return value;
}

for (const status of ["ended", "error"] as const) {
  test(`a copy received before ${status} remains usable and never writes automatically`, async () => {
    const clipboard = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
    const { screens, snapshot, current } = createScreens();
    const value = request(current);
    current.change({ status });
    expect(snapshot().programCopy?.request).toBe(value);
    expect(clipboard).not.toHaveBeenCalled();
    await screens.copyProgramText(value);
    expect(clipboard).toHaveBeenCalledExactlyOnceWith("program text");
    expect(snapshot().programCopy).toBeUndefined();
  });
}

for (const closeDuringRecovery of [false, true]) {
  test(`recovery retains the old request and permits closing ${closeDuringRecovery ? "while waiting" : "after failure"}`, () => {
    const { screens, snapshot, current } = createScreens();
    const old = request(current, "retained");
    screens.restore("retained");
    const candidate = displays[1]!;
    request(current, "suspended output");
    request(candidate, "hidden output");
    expect(snapshot().programCopy?.request).toBe(old);
    if (closeDuringRecovery) screens.clearProgramCopy(old);
    candidate.change({ status: "error", error: new Error("Restore failed") });
    expect(snapshot().programCopy?.request).toBe(closeDuringRecovery ? undefined : old);
    if (!closeDuringRecovery) screens.clearProgramCopy(old);
    expect(snapshot().programCopy).toBeUndefined();
  });
}

test("a promoted screen starts without the previous screen's request", () => {
  const { screens, snapshot, current } = createScreens();
  request(current);
  screens.restore("screen");
  displays[1]!.change({ status: "ready" });
  expect(snapshot().programCopy).toBeUndefined();
  const next = request(displays[1]!, "new source");
  expect(snapshot().programCopy?.request).toBe(next);
});

for (const result of ["success", "failure"] as const) {
  for (const change of ["new request", "close", "screen replacement"] as const) {
    test(`a late copy ${result} does not overwrite ${change}`, async () => {
      let settle!: () => void;
      const pending = new Promise<void>((resolve, reject) => {
        settle = result === "success" ? resolve : () => reject(new Error("Clipboard denied"));
      });
      const clipboard = vi.fn().mockReturnValue(pending);
      vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
      const { screens, snapshot, current } = createScreens();
      const first = request(current, "A");
      const copying = screens.copyProgramText(first);
      if (change === "new request") request(current, "B");
      else if (change === "close") screens.clearProgramCopy(first);
      else {
        screens.restore("retained");
        displays[1]!.change({ status: "ready" });
        request(displays[1]!, "B");
      }
      const before = snapshot().programCopy;
      settle();
      await copying;
      expect(snapshot().programCopy).toBe(before);
      expect(clipboard).toHaveBeenCalledExactlyOnceWith("A");
    });
  }
}

test("a failed copy keeps the exact text and error for another explicit attempt", async () => {
  const failure = new Error("Clipboard denied");
  const clipboard = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
  const { screens, snapshot, current } = createScreens();
  const value = request(current, "\ufeff中文🙂\r\n");
  await screens.copyProgramText(value);
  expect(snapshot().programCopy).toEqual({ request: value, failure: { error: failure } });
  expect(clipboard).toHaveBeenCalledTimes(1);
  await screens.copyProgramText(value);
  expect(clipboard).toHaveBeenLastCalledWith("\ufeff中文🙂\r\n");
  expect(snapshot().programCopy).toBeUndefined();
});
