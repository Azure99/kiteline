import { expect, test, vi } from "vitest";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { listeningPort, listeningPorts, macosListeningPort } from "../src/http/ports.js";

test("only loopback and wildcard TCP LISTEN addresses become suggestions", () => {
  const row = (address: string, state = "0A") => `  0: ${address}:14B3 00000000:0000 ${state} `;
  expect(listeningPort(row("0100007F"), "ipv4")).toBe(5299);
  expect(listeningPort(row("00000000"), "ipv4")).toBe(5299);
  expect(listeningPort(row("0200007F"), "ipv4")).toBeUndefined();
  expect(listeningPort(row("0100007F", "01"), "ipv4")).toBeUndefined();
  expect(listeningPort(row("00000000000000000000000001000000"), "ipv6")).toBe(5299);
  expect(() => listeningPort("unexpected data", "ipv4")).toThrow("Cannot parse");
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

test.runIf(process.platform === "linux")(
  "partial suggestions require an additional unique port across both proc tables",
  async () => {
    const root = await mkdtemp("/var/tmp/kiteline-port-boundary-");
    const createReadStream = fs.createReadStream;
    const redirected = vi
      .spyOn(fs, "createReadStream")
      .mockImplementation((path, options) =>
        createReadStream(
          path === "/proc/net/tcp"
            ? join(root, "tcp")
            : path === "/proc/net/tcp6"
              ? join(root, "tcp6")
              : path,
          options,
        ),
      );
    syncBuiltinESMExports();
    const row = (port: number, ipv6 = false) => {
      const address = ipv6 ? "00000000000000000000000001000000" : "0100007F";
      return `0: ${address}:${port.toString(16).padStart(4, "0")} 00000000:0000 0A`;
    };
    const scan = async (v4: number, v6: string[] = []) => {
      await writeFile(
        join(root, "tcp"),
        "header\n" + Array.from({ length: v4 }, (_, i) => row(i + 1)).join("\n") + "\n",
      );
      await writeFile(join(root, "tcp6"), "header\n" + v6.join("\n") + "\n");
      return listeningPorts(new AbortController().signal);
    };
    try {
      expect(await scan(499)).toEqual({
        ports: Array.from({ length: 499 }, (_, i) => i + 1),
        truncated: false,
      });
      const full = { ports: Array.from({ length: 500 }, (_, i) => i + 1), truncated: false };
      expect(await scan(500)).toEqual(full);
      expect(await scan(500, [row(500, true)])).toEqual(full);
      expect(await scan(501)).toEqual({ ...full, truncated: true });
      expect(await scan(500, [row(501, true)])).toEqual({ ...full, truncated: true });
      await expect(scan(500, ["unexpected data"])).rejects.toMatchObject({ code: "io_error" });
      await rm(join(root, "tcp6"));
      await mkdir(join(root, "tcp6"));
      await expect(listeningPorts(new AbortController().signal)).rejects.toMatchObject({
        code: "EISDIR",
      });
    } finally {
      redirected.mockRestore();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  },
);
