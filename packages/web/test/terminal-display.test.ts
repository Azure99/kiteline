import { afterEach, expect, test, vi } from "vitest";

vi.hoisted(() => {
  // `useMobile()` reads the layout query when its module loads.
  globalThis.matchMedia = () => ({ matches: true }) as MediaQueryList;
});
import { TerminalDisplay, type DisplayState } from "../src/terminal/display";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a disconnected display whose session is gone ends without reconnecting", async () => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  let fail!: (error: unknown) => void;
  const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  const states: DisplayState[] = [];
  const element = Object.assign(new EventTarget(), { replaceChildren() {} });
  const display = new TerminalDisplay(element as unknown as HTMLElement, "d", "w", "s", (state) =>
    states.push(state),
  );
  // Only a display that already lost its connection is affected.
  display.sessionMissing();
  expect(display.state.status).toBe("connecting");
  fail(new TypeError("Failed to fetch"));
  await vi.waitFor(() => expect(display.state.status).toBe("error"));

  display.sessionMissing();
  expect(display.state).toMatchObject({ status: "ended", missing: true, exitCode: null });
  expect(display.state.error).toBeUndefined();
  display.sessionMissing();
  expect(states.filter((state) => state.status === "ended")).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  display.dispose();
});
