import { resolve } from "node:path";
import { BlockList, isIP } from "node:net";
import { AppError } from "@kiteline/shared/protocol";

export interface ServerConfig {
  dataDir: string;
  trustProxyProto: boolean;
  trustedProxies: BlockList;
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
  const trustedProxies = new BlockList();
  const proxies = process.env.KITELINE_TRUSTED_PROXIES?.trim();
  for (const entry of proxies ? proxies.split(",") : []) {
    const [address, prefix, ...extra] = entry.trim().split("/");
    const family = isIP(address!);
    try {
      if (!family || extra.length || (prefix !== undefined && !/^\d+$/.test(prefix)))
        throw new Error("Invalid IP address or CIDR");
      const type = family === 6 ? "ipv6" : "ipv4";
      if (prefix === undefined) trustedProxies.addAddress(address!, type);
      else trustedProxies.addSubnet(address!, Number(prefix), type);
    } catch {
      throw new AppError(
        "invalid_argument",
        `Invalid KITELINE_TRUSTED_PROXIES entry: ${entry.trim()}; expected an IP address or CIDR`,
      );
    }
  }
  const address = new URL(`http://${process.env.KITELINE_LISTEN_ADDR ?? "127.0.0.1:8080"}`);
  return {
    dataDir,
    trustProxyProto: trustProxyProto === "1",
    trustedProxies,
    hostname: address.hostname.replace(/^\[|\]$/g, ""),
    port: Number(address.port || 80),
    webDir: resolve(import.meta.dirname, "../../web/dist"),
    downloadsDir: resolve(import.meta.dirname, "../../downloads"),
  };
}
