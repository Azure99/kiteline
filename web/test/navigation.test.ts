import { expect, test } from "vitest";
import { parseRoute } from "../src/lib/navigation";

test("malformed route encoding is invalid while encoded identities and query remain usable", () => {
  const parse = (path: string) => parseRoute(new URL(path, "https://kiteline.test"));
  for (const path of ["/devices/%", "/devices/d/workspaces/%E0%A4%A/files"])
    expect(parse(path).valid).toBe(false);
  const route = parse("/devices/a%20b/workspaces/w%2F1/files?file=a%25.txt");
  expect(route).toMatchObject({
    valid: true,
    deviceId: "a b",
    workspaceId: "w/1",
    tool: "files",
  });
  expect(route.query.get("file")).toBe("a%.txt");
  expect(parse("/devices/d/workspaces/w/unknown").valid).toBe(false);
  expect(parse("/").valid).toBe(true);
});
