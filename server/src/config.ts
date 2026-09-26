import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppError, integer, record } from "@kiteline/shared/protocol";

export interface ServerConfig {
  dataDir: string;
  trustProxyProto: boolean;
  hostname: string;
  port: number;
  webDir: string;
  downloadsDir: string;
  limits: {
    sessionLifetime: number;
    draftTotalBytes: number;
    channelsPerDevice: number;
    channelPairTimeout: number;
    channelIdleTimeout: number;
  };
}
export function serverConfig(): ServerConfig {
  const dataDir = resolve(process.env.KITELINE_DATA_DIR ?? "/var/lib/kiteline");
  const trustProxyProto = process.env.KITELINE_TRUST_PROXY_PROTO ?? "0";
  if (trustProxyProto !== "0" && trustProxyProto !== "1")
    throw new AppError("invalid_argument", "KITELINE_TRUST_PROXY_PROTO must be 0 or 1");
  const address = new URL(`http://${process.env.KITELINE_LISTEN_ADDR ?? "127.0.0.1:8080"}`);
  const defaults = {
    sessionLifetime: 30 * 86400_000,
    draftTotalBytes: 32 * 1024 * 1024,
    channelsPerDevice: 128,
    channelPairTimeout: 30_000,
    channelIdleTimeout: 120_000,
  };
  let input: Record<string, unknown> = {};
  try {
    input = record(
      record(JSON.parse(readFileSync(resolve(dataDir, "config.json"), "utf8"))).limits ?? {},
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    if (input[key] !== undefined)
      defaults[key] = integer(
        input[key],
        key,
        1,
        key === "channelPairTimeout" || key === "channelIdleTimeout"
          ? 2147483647
          : Number.MAX_SAFE_INTEGER,
      );
  }
  return {
    dataDir,
    trustProxyProto: trustProxyProto === "1",
    hostname: address.hostname.replace(/^\[|\]$/g, ""),
    port: Number(address.port || 80),
    webDir: resolve(import.meta.dirname, "../../web/dist"),
    downloadsDir: resolve(import.meta.dirname, "../../downloads"),
    limits: defaults,
  };
}
