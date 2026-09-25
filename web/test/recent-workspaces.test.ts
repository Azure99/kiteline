import { expect, test } from "vitest";
import type { Device } from "@kiteline/shared/protocol";
import { pruneRecents, readRecents, visitWorkspace } from "../src/devices/recent-workspaces";

const visit = (workspaceId: string) => ({
  deviceId: "device",
  workspaceId,
  lastTool: "terminal" as const,
  visitedAt: 1,
});

test("recent visits retain eight distinct targets and replace the last tool on return", () => {
  let recents = Array.from({ length: 8 }, (_, i) => visit(String(i)));
  recents = visitWorkspace(recents, visit("new"));
  expect(recents.map((entry) => entry.workspaceId)).toEqual([
    "new",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
  ]);
  const returned = visitWorkspace(recents, { ...visit("2"), lastTool: "files", visitedAt: 2 });
  expect(returned[0]).toMatchObject({ workspaceId: "2", lastTool: "files", visitedAt: 2 });
  expect(returned).toHaveLength(8);
  expect(
    readRecents([null, {}, { ...visit("bad"), lastTool: "other" }, ...returned, ...returned]),
  ).toEqual(returned);
});

test("recent targets are removed only when the complete device facts prove them unavailable", () => {
  const recents = [visit("kept"), visit("gone")];
  const device = {
    id: "device",
    status: "online",
    snapshot: { workspaces: [{ id: "kept" }] },
  } as Device;
  expect(pruneRecents(recents, [{ ...device, status: "offline" }])).toBe(recents);
  expect(pruneRecents(recents, [{ ...device, snapshot: undefined }])).toBe(recents);
  expect(pruneRecents(recents, [device])).toEqual([visit("kept")]);
  expect(pruneRecents(recents, [{ ...device, status: "revoked" }])).toEqual([]);
  expect(pruneRecents(recents, [])).toEqual([]);
});
