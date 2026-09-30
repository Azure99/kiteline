import { expect, test, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { listeningPort, listeningPorts, macosListeningPort } from "../src/http/ports.js";

test("only loopback and wildcard TCP LISTEN addresses become suggestions", () => {
  const row = (address: string, state = "0A") => `  0: ${address}:14B3 00000000:0000 ${state} `;
  expect(listeningPort(row("0100007F"), false)).toBe(5299);
  expect(listeningPort(row("00000000"), false)).toBe(5299);
  expect(listeningPort(row("0200007F"), false)).toBeUndefined();
  expect(listeningPort(row("0100007F", "01"), false)).toBeUndefined();
  expect(listeningPort(row("00000000000000000000000001000000"), true)).toBe(5299);
  expect(() => listeningPort("unexpected data", false)).toThrow("Cannot parse");
});
test("macOS netstat suggestions retain only loopback and wildcard TCP listeners", () => {
  const row = (address: string, state = "LISTEN") => `tcp4 0 0 ${address} *.* ${state}`;
  expect(macosListeningPort(row("127.0.0.1.5299"))).toBe(5299);
  expect(macosListeningPort(row("*.5299"))).toBe(5299);
  expect(macosListeningPort("tcp6 0 0 ::1.5299 *.* LISTEN")).toBe(5299);
  expect(macosListeningPort("tcp46 0 0 *.5299 *.* LISTEN")).toBe(5299);
  expect(macosListeningPort(row("192.168.1.2.5299"))).toBeUndefined();
  expect(macosListeningPort(row("127.0.0.1.5299", "ESTABLISHED"))).toBeUndefined();
  expect(() => macosListeningPort("unexpected data")).toThrow("Cannot parse");
  expect(() => macosListeningPort(row("*.99999"))).toThrow("Cannot parse");
});
test("real snapshots deduplicate IPv4/IPv6 listeners and respect cancellation", async () => {
  const v4 = createServer(),
    v6 = createServer();
  v4.listen(0, "127.0.0.1");
  await once(v4, "listening");
  const port = (v4.address() as AddressInfo).port;
  try {
    v6.listen({ port, host: "::1", ipv6Only: true });
    await once(v6, "listening");
    const result = await listeningPorts(new AbortController().signal);
    expect(result.ports.filter((value) => value === port)).toEqual([port]);
    expect(result.ports).toEqual([...result.ports].sort((a, b) => a - b));
    const controller = new AbortController();
    controller.abort();
    await expect(listeningPorts(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    await new Promise<void>((resolve) => v4.close(() => resolve()));
    await new Promise<void>((resolve) => v6.close(() => resolve()));
  }
});

test.runIf(process.platform === "linux")(
  "missing IPv6 proc table still returns the real IPv4 listeners",
  async () => {
    const createReadStream = fs.createReadStream;
    const redirected = vi
      .spyOn(fs, "createReadStream")
      .mockImplementation((path, options) =>
        createReadStream(
          path === "/proc/net/tcp6" ? "/proc/net/kiteline-missing-tcp6" : path,
          options,
        ),
      );
    syncBuiltinESMExports();
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    try {
      const result = await listeningPorts(new AbortController().signal);
      expect(result.ports).toContain((listener.address() as AddressInfo).port);
    } finally {
      redirected.mockRestore();
      syncBuiltinESMExports();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  },
);
