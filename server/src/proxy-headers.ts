import type { IncomingHttpHeaders } from "node:http";
import { sessionCookieNames } from "./http.js";

const loginCookies = new Set<string>(sessionCookieNames);

function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const excluded = new Set([
    "connection",
    "proxy-connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}
export function requestHeaders(
  headers: IncomingHttpHeaders,
  entryOrigin: string,
  upgrade: boolean,
) {
  const result = endToEnd(headers);
  for (const name of Object.keys(result))
    if (name === "forwarded" || name.startsWith("x-forwarded-")) delete result[name];
  const url = new URL(entryOrigin);
  result.host = url.host;
  result["x-forwarded-host"] = url.host;
  result["x-forwarded-proto"] = url.protocol.slice(0, -1);
  if (result.cookie) {
    const cookie = result.cookie
      .split(";")
      .filter((part) => !loginCookies.has(part.trim().split("=", 1)[0]!))
      .join(";");
    if (cookie.trim()) result.cookie = cookie;
    else delete result.cookie;
  }
  if (headers["content-length"] !== undefined) result["content-length"] = headers["content-length"];
  else if (headers["transfer-encoding"]) result["transfer-encoding"] = "chunked";
  if (upgrade) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}
export function responseHeaders(
  headers: IncomingHttpHeaders,
  prefix: string,
  strip: boolean,
  upgrade = false,
) {
  const result = endToEnd(headers);
  if (result["set-cookie"]) {
    const cookies = result["set-cookie"].filter(
      (value) => !loginCookies.has(value.split("=", 1)[0]!.trim()),
    );
    if (cookies.length) result["set-cookie"] = cookies;
    else delete result["set-cookie"];
  }
  if (strip && result.location?.startsWith("/") && !result.location.startsWith("//"))
    result.location = prefix + result.location;
  if (upgrade) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}
