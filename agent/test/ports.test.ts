import { expect, test, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { listeningPort, listeningPorts } from "../src/http/ports.js";

test("only loopback and wildcard TCP LISTEN addresses become suggestions", () => {
  const row = (address: string, state = "0A") => `  0: ${address}:14B3 00000000:0000 ${state} `;
  expect(listeningPort(row("0100007F"), false)).toBe(5299);
  expect(listeningPort(row("00000000"), false)).toBe(5299);
  expect(listeningPort(row("0200007F"), false)).toBeUndefined();
  expect(listeningPort(row("0100007F", "01"), false)).toBeUndefined();
  expect(listeningPort(row("00000000000000000000000001000000"), true)).toBe(5299);
  expect(() => listeningPort("unexpected data", false)).toThrow("Cannot parse");
});
test("real proc snapshots deduplicate IPv4/IPv6 listeners and respect cancellation", async () => {
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

test("missing IPv6 proc table still returns the real IPv4 listeners", async () => {
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
});
