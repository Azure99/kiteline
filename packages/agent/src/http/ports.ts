import { agentLimits } from "../limits.js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError, type ListeningPorts } from "@kiteline/shared/protocol";
import { windowsNative } from "@kiteline/shared/windows/native";

export function listeningPort(line: string, family: "ipv4" | "ipv6"): number | undefined {
  const ipv6 = family === "ipv6";
  const fields = line.trim().split(/\s+/);
  if (!/^\d+:$/.test(fields[0] ?? "") || fields.length < 4)
    throw new AppError("io_error", "Cannot parse the device listening port");
  const localAddress = /^([0-9A-F]+):([0-9A-F]{4})$/i.exec(fields[1]!);
  const tcpState = fields[3]!;
  if (
    !localAddress ||
    localAddress[1]!.length !== (ipv6 ? 32 : 8) ||
    !/^[0-9A-F]{2}$/i.test(tcpState)
  )
    throw new AppError("io_error", "Cannot parse the device listening address");
  const listenState = "0A";
  if (tcpState.toUpperCase() !== listenState) return;
  const [, addressHex, portHex] = localAddress;
  const wildcardAddress = ipv6 ? "00000000000000000000000000000000" : "00000000";
  const loopbackAddress = ipv6 ? "00000000000000000000000001000000" : "0100007F";
  const address = addressHex!.toUpperCase();
  if (address === wildcardAddress || address === loopbackAddress) {
    const port = Number.parseInt(portHex!, 16);
    if (port) return port;
  }
}

export function macosListeningPort(line: string): number | undefined {
  if (!line.trim() || /^Active Internet connections|^Proto\s/.test(line)) return;
  const fields = /^tcp(?:4|6|46)\s+\d+\s+\d+\s+(\S+)\s+\S+\s+(\S+)\s*$/.exec(line);
  if (!fields) throw new AppError("io_error", "Cannot parse the device listening port");
  const [, localAddress, tcpState] = fields;
  if (tcpState !== "LISTEN") return;
  const address = /^(.*)\.(\d+)$/.exec(localAddress!);
  const [, host, portText] = address ?? [];
  const port = Number(portText);
  if (!address || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new AppError("io_error", "Cannot parse the device listening address");
  if (["*", "127.0.0.1", "::1"].includes(host!)) return port;
}

export async function listeningPorts(signal: AbortSignal): Promise<ListeningPorts> {
  signal.throwIfAborted();
  if (process.platform === "win32") {
    const ports = await windowsNative().listeningPorts();
    signal.throwIfAborted();
    return {
      ports: ports.slice(0, agentLimits.listPageEntries),
      truncated: ports.length > agentLimits.listPageEntries,
    };
  }
  const ports = new Set<number>();
  if (process.platform === "darwin") {
    const { stdout, stderr } = await promisify(execFile)(
      "/usr/sbin/netstat",
      ["-an", "-p", "tcp"],
      {
        env: { ...process.env, LC_ALL: "C" },
        signal,
        timeout: 3000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (stderr.trim()) throw new AppError("io_error", stderr.trim());
    for (const line of stdout.split("\n")) {
      const port = macosListeningPort(line);
      if (port !== undefined) ports.add(port);
    }
    return {
      ports: [...ports].sort((a, b) => a - b).slice(0, agentLimits.listPageEntries),
      truncated: ports.size > agentLimits.listPageEntries,
    };
  }
  let truncated = false;
  for (const family of ["ipv4", "ipv6"] as const) {
    signal.throwIfAborted();
    const stream = createReadStream(family === "ipv6" ? "/proc/net/tcp6" : "/proc/net/tcp", {
      signal,
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let error: NodeJS.ErrnoException | undefined;
    stream.on("error", (reason) => {
      error = reason;
      lines.close();
    });
    let header = true;
    try {
      for await (const line of lines) {
        signal.throwIfAborted();
        if (header) {
          header = false;
          continue;
        }
        if (!line.trim()) continue;
        const port = listeningPort(line, family);
        if (port !== undefined && !ports.has(port)) {
          if (ports.size === agentLimits.listPageEntries) {
            truncated = true;
            break;
          }
          ports.add(port);
        }
      }
      signal.throwIfAborted();
      if (error) throw error;
    } catch (reason) {
      signal.throwIfAborted();
      if (!(family === "ipv6" && (reason as NodeJS.ErrnoException).code === "ENOENT")) throw reason;
    } finally {
      lines.close();
      stream.destroy();
    }
    if (truncated) break;
  }
  return { ports: [...ports].sort((a, b) => a - b), truncated };
}
