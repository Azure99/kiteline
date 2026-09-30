import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { AppError, limits, type ListeningPorts } from "@kiteline/shared/protocol";
import { windowsNative } from "@kiteline/shared/windows/native";

export function listeningPort(line: string, ipv6: boolean): number | undefined {
  const fields = line.trim().split(/\s+/);
  if (!/^\d+:$/.test(fields[0] ?? "") || fields.length < 4)
    throw new AppError("io_error", "Cannot parse the device listening port");
  const local = /^([0-9A-F]+):([0-9A-F]{4})$/i.exec(fields[1]!);
  if (!local || local[1]!.length !== (ipv6 ? 32 : 8) || !/^[0-9A-F]{2}$/i.test(fields[3]!))
    throw new AppError("io_error", "Cannot parse the device listening address");
  if (fields[3]!.toUpperCase() !== "0A") return;
  const addresses = ipv6
    ? ["00000000000000000000000000000000", "00000000000000000000000001000000"]
    : ["00000000", "0100007F"];
  if (addresses.includes(local[1]!.toUpperCase())) {
    const port = Number.parseInt(local[2]!, 16);
    if (port) return port;
  }
}

export async function listeningPorts(signal: AbortSignal): Promise<ListeningPorts> {
  signal.throwIfAborted();
  if (process.platform === "win32") {
    const ports = await windowsNative().listeningPorts();
    signal.throwIfAborted();
    return {
      ports: ports.slice(0, limits.listPageEntries),
      truncated: ports.length > limits.listPageEntries,
    };
  }
  const ports = new Set<number>();
  let truncated = false;
  for (const ipv6 of [false, true]) {
    signal.throwIfAborted();
    const stream = createReadStream(ipv6 ? "/proc/net/tcp6" : "/proc/net/tcp", { signal });
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
        const port = listeningPort(line, ipv6);
        if (port !== undefined) ports.add(port);
        if (ports.size >= limits.listPageEntries) {
          truncated = true;
          break;
        }
      }
      signal.throwIfAborted();
      if (error) throw error;
    } catch (reason) {
      signal.throwIfAborted();
      if (!(ipv6 && (reason as NodeJS.ErrnoException).code === "ENOENT")) throw reason;
    } finally {
      lines.close();
      stream.destroy();
    }
    if (truncated) break;
  }
  return { ports: [...ports].sort((a, b) => a - b), truncated };
}
