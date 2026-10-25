import { afterEach, expect, test, vi } from "vitest";
import { deviceServiceLink, serviceURL } from "../src/lib/device-service";

afterEach(() => vi.unstubAllGlobals());
test("terminal HTTP links retain their device, path, empty query and fragment", () => {
  vi.stubGlobal("location", { origin: "https://kiteline.example:8443" });
  for (const host of ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"])
    expect(deviceServiceLink(`http://${host}:5173/a%2Fb?x=1#part`, "device")).toEqual({
      port: 5173,
      url: "https://kiteline.example:8443/proxy/device/5173/a%2Fb?x=1#part",
    });
  expect(deviceServiceLink("http://localhost/?#part", "device")?.url).toBe(
    "https://kiteline.example:8443/proxy/device/80/?#part",
  );
  expect(deviceServiceLink("http://localhost:5173/absproxy/device/5173/?x=1", "device")?.url).toBe(
    "https://kiteline.example:8443/absproxy/device/5173/?x=1",
  );
  expect(deviceServiceLink("http://localhost:5173/absproxy/other/5173/", "device")?.url).toContain(
    "/proxy/device/5173/absproxy/other/5173/",
  );
  expect(serviceURL("device", 5173, true).pathname).toBe("/absproxy/device/5173/");
  for (const url of [
    "https://localhost:5173/",
    "http://example.test:5173/",
    "http://localhost:0/",
    "npm http://localhost:5173/",
    "http://localhost:5173/ other",
  ])
    expect(deviceServiceLink(url, "device")).toBeUndefined();
});
