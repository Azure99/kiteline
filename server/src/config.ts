import { resolve } from "node:path";
import { AppError } from "@kiteline/shared/protocol";

export interface ServerConfig {
  dataDir: string;
  trustProxyProto: boolean;
  hostname: string;
  port: number;
  webDir: string;
  downloadsDir: string;
}
export function serverConfig(): ServerConfig {
  const dataDir = resolve(process.env.KITELINE_DATA_DIR ?? "/var/lib/kiteline");
  const trustProxyProto = process.env.KITELINE_TRUST_PROXY_PROTO ?? "0";
  if (trustProxyProto !== "0" && trustProxyProto !== "1")
    throw new AppError("invalid_argument", "KITELINE_TRUST_PROXY_PROTO must be 0 or 1");
  const address = new URL(`http://${process.env.KITELINE_LISTEN_ADDR ?? "127.0.0.1:8080"}`);
  return {
    dataDir,
    trustProxyProto: trustProxyProto === "1",
    hostname: address.hostname.replace(/^\[|\]$/g, ""),
    port: Number(address.port || 80),
    webDir: resolve(import.meta.dirname, "../../web/dist"),
    downloadsDir: resolve(import.meta.dirname, "../../downloads"),
  };
}
