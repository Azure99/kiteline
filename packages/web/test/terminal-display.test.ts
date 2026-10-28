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

test("a disposed display cancels a ready channel returned after response consumption", async () => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("location", { href: "http://localhost/", protocol: "http:" });
  const socket = vi.fn();
  vi.stubGlobal("WebSocket", socket);
  let consumed!: () => void;
  const responseConsumed = new Promise<void>((resolve) => {
    consumed = resolve;
  });
  let returnReady!: () => void;
  const release = new Promise<void>((resolve) => {
    returnReady = resolve;
  });
  const channelId = "late/目录?%";
  const response = Response.json({ channelId, meta: { terminalInputBytes: 4096 } });
  const json = response.json.bind(response);
  vi.spyOn(response, "json").mockImplementation(async () => {
    const ready = await json();
    // Hold the parsed result at the consumption boundary, after fetch/body have completed.
    consumed();
    await release;
    return ready;
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    if (options?.method === "DELETE") throw new TypeError("Cancellation response was lost");
    return response;
  });
  const states: DisplayState[] = [];
  const element = Object.assign(new EventTarget(), { replaceChildren() {} });
  const display = new TerminalDisplay(element as unknown as HTMLElement, "d", "w", "s", (state) =>
    states.push(state),
  );
  try {
    await responseConsumed;
    display.dispose();
    returnReady();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/api/channels/${encodeURIComponent(channelId)}?`),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(socket).not.toHaveBeenCalled();
    expect(states).toEqual([]);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(1);
  } finally {
    returnReady();
    display.dispose();
  }
});
