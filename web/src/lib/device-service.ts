export function serviceURL(deviceId: string, port: number, retain = false) {
  return new URL(
    `/${retain ? "absproxy" : "proxy"}/${encodeURIComponent(deviceId)}/${port}/`,
    location.origin,
  );
}

export function deviceServiceLink(text: string, deviceId: string) {
  const value = text.trim();
  if (/\s/.test(value)) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"].includes(url.hostname)
  )
    return;
  const port = Number(url.port || 80);
  if (port < 1) return;
  const retainPrefix = `/absproxy/${encodeURIComponent(deviceId)}/${port}`;
  const retain = url.pathname === retainPrefix || url.pathname.startsWith(retainPrefix + "/");
  const endpoint = serviceURL(deviceId, port, retain);
  if (!retain) url.pathname = endpoint.pathname.slice(0, -1) + url.pathname;
  url.username = "";
  url.password = "";
  url.protocol = endpoint.protocol;
  url.hostname = endpoint.hostname;
  url.port = endpoint.port;
  return { url: url.href, port };
}
