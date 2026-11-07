import { afterEach, expect, test, vi } from "vitest";

vi.hoisted(() => {
  // `useMobile()` reads the layout query when its module loads.
  globalThis.matchMedia = () => ({ matches: true }) as MediaQueryList;
});
import { Terminal } from "@xterm/xterm";
import {
  TerminalDisplay,
  type DisplayState,
  type ProgramCopyRequest,
} from "../src/terminal/display";

// Keep the real xterm parser and output queue; these collaborators only render or track DOM input.
vi.mock("../src/terminal/auxiliary-input", () => ({
  AuxiliaryInput: class {
    dispose() {}
  },
}));
vi.mock("../src/terminal/keyboard-viewport", () => ({
  KeyboardViewport: class {
    isReading() {
      return false;
    }
    dispose() {}
  },
}));
vi.mock("../src/terminal/clipped-screen", () => ({ retainReadonlyViewport: () => () => {} }));

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
  const display = new TerminalDisplay({
    host: element as unknown as HTMLElement,
    target: { deviceId: "d", workspaceId: "w", sessionId: "s" },
    events: { state: (state) => states.push(state) },
  });
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
  const display = new TerminalDisplay({
    host: element as unknown as HTMLElement,
    target: { deviceId: "d", workspaceId: "w", sessionId: "s" },
    events: { state: (state) => states.push(state) },
  });
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

async function copyDisplay() {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("location", {
    href: "http://localhost/",
    protocol: "http:",
    origin: "http://localhost",
  });
  vi.stubGlobal("document", { documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  vi.stubGlobal("localStorage", { getItem: () => null });
  const clipboard = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
  vi.spyOn(Terminal.prototype, "open").mockImplementation(() => {});
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    onmessage?: (event: MessageEvent) => void;
    sent: (string | Uint8Array)[] = [];
    constructor() {
      sockets.push(this);
    }
    send(value: string | Uint8Array) {
      this.sent.push(value);
    }
    close() {}
    frame(value: object) {
      this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
    }
    output(text: string) {
      this.onmessage?.({ data: new TextEncoder().encode(text).buffer } as MessageEvent);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) =>
    options?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ channelId: "copy", meta: { terminalInputBytes: 4096 } }),
  );
  const requests: ProgramCopyRequest[] = [];
  const host = Object.assign(new EventTarget(), {
    replaceChildren() {},
    classList: { contains: () => false },
  });
  const display = new TerminalDisplay({
    host: host as unknown as HTMLElement,
    target: { deviceId: "d", workspaceId: "w", sessionId: "s" },
    events: { state() {}, copyRequest: (request) => requests.push(request) },
  });
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0]!;
  function begin(snapshot: string) {
    socket.frame({
      type: "restore.begin",
      cols: 20,
      rows: 4,
      historyLines: 100,
      snapshotBytes: new TextEncoder().encode(snapshot).length,
    });
    if (snapshot) socket.output(snapshot);
  }
  return { display, socket, requests, clipboard, begin };
}

function oscCopy(text: string) {
  return `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
}

test("only live OSC 52 after parsed snapshot and tail creates a local copy request", async () => {
  const { display, socket, requests, clipboard, begin } = await copyDisplay();
  try {
    const snapshot = oscCopy("saved");
    begin(snapshot);
    const tail = oscCopy("tail");
    socket.output(tail.slice(0, 10));
    socket.output(tail.slice(10));
    socket.frame({ type: "ready" });
    socket.output(oscCopy("\ufeff中文🙂\r\nsecond line"));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(display.state.status).toBe("ready");
    expect(requests).toEqual([{ text: "\ufeff中文🙂\r\nsecond line" }]);
    expect(clipboard).not.toHaveBeenCalled();
  } finally {
    display.dispose();
  }
});

test("live OSC 52 queries do not reply and invalid base64 or UTF-8 stays local", async () => {
  const { display, socket, requests, clipboard, begin } = await copyDisplay();
  try {
    begin("");
    socket.frame({ type: "ready" });
    await vi.waitFor(() => expect(display.state.status).toBe("ready"));
    const replies: string[] = [];
    display.terminal!.onData((value) => replies.push(value));
    socket.output("\x1b]52;c;?\x07\x1b]52;missing-separator\x07");
    socket.output("\x1b]52;c;##\x07\x1b]52;c;/w==\x07");
    const live = oscCopy("next");
    socket.output(live.slice(0, 9));
    socket.output(live.slice(9));
    socket.output(oscCopy(""));
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(requests.slice(0, 2)).toEqual([
      { error: expect.any(Error) },
      { error: expect.any(Error) },
    ]);
    expect(requests.slice(2)).toEqual([{ text: "next" }, { text: "" }]);
    expect(display.state.status).toBe("ready");
    expect(replies).toEqual([]);
    expect(clipboard).not.toHaveBeenCalled();
  } finally {
    display.dispose();
  }
});

test("terminal links require Ctrl or Meta and leave local selections alone", async () => {
  const { display, socket, begin } = await copyDisplay();
  const open = vi.fn();
  Object.assign(window, { open });
  try {
    begin("");
    socket.frame({ type: "ready" });
    await vi.waitFor(() => expect(display.state.status).toBe("ready"));
    const terminal = display.terminal!;
    const activate = (event: MouseEvent, uri: string) =>
      terminal.options.linkHandler!.activate(event, uri, {
        start: { x: 1, y: 1 },
        end: { x: uri.length, y: 1 },
      });
    const click = (ctrlKey = false, metaKey = false) => ({ ctrlKey, metaKey }) as MouseEvent;
    activate(click(), "https://example.com/plain");
    expect(open).not.toHaveBeenCalled();
    activate(click(true), "https://example.com/control");
    activate(click(false, true), "https://example.com/meta");
    activate(click(true), "http://localhost:3000/path?q=1");
    expect(open.mock.calls).toEqual([
      ["https://example.com/control", "_blank", "noopener,noreferrer"],
      ["https://example.com/meta", "_blank", "noopener,noreferrer"],
      ["http://localhost/proxy/d/3000/path?q=1", "_blank", "noopener,noreferrer"],
    ]);
    vi.spyOn(terminal, "hasSelection").mockReturnValue(true);
    activate(click(true), "https://example.com/selected");
    expect(open).toHaveBeenCalledTimes(3);
    expect(terminal.options.macOptionClickForcesSelection).toBe(true);
  } finally {
    display.dispose();
  }
});
