import type { IncomingHttpHeaders } from "node:http";

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
export function requestHeaders(headers: IncomingHttpHeaders, publicUrl: string, upgrade: boolean) {
  const result = endToEnd(headers);
  for (const name of Object.keys(result))
    if (name === "forwarded" || name.startsWith("x-forwarded-")) delete result[name];
  const url = new URL(publicUrl);
  result.host = url.host;
  result["x-forwarded-host"] = url.host;
  result["x-forwarded-proto"] = "https";
  if (result.cookie) {
    const cookie = result.cookie
      .split(";")
      .filter((part) => part.trim().split("=", 1)[0] !== "kiteline_session")
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
      (value) => value.split("=", 1)[0]!.trim() !== "kiteline_session",
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
