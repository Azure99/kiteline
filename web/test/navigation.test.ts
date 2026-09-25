import { afterEach, expect, test, vi } from "vitest";
import {
  parseRoute,
  workspacePath,
  workspaceDestination,
  updateWorkspaceQuery,
} from "../src/lib/navigation";

afterEach(() => vi.unstubAllGlobals());

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
  expect(route.query.file).toBe("a%.txt");
  expect(parse("/devices/d/workspaces/w/unknown").valid).toBe(false);
  expect(parse("/").valid).toBe(true);
});

test("workspace navigation retains known tool targets only within the same workspace", () => {
  const query = {
    session: "s",
    repo: "r",
    file: "a #%.txt",
    draft: "d",
    folder: "src",
    reveal: "src/entry",
    search: true,
  };
  const url = new URL(workspacePath("d/1", "w", "files", query), "https://kiteline.test");
  vi.stubGlobal("window", { location: url });
  expect(parseRoute(url).query).toEqual(query);
  const target = { deviceId: "d/1", workspaceId: "w" };
  const same = parseRoute(new URL(workspaceDestination(target, "git", { search: undefined }), url));
  expect(same.query).toEqual({ ...query, search: undefined });
  expect(same.tool).toBe("git");
  const other = parseRoute(
    new URL(workspaceDestination({ ...target, workspaceId: "other" }, "terminal"), url),
  );
  expect(Object.values(other.query).every((value) => value === undefined)).toBe(true);
  const history = { pushState: vi.fn(), replaceState: vi.fn() };
  vi.stubGlobal("history", history);
  updateWorkspaceQuery({ ...target, workspaceId: "other" }, { file: "late.txt" }, true);
  expect(history.replaceState).not.toHaveBeenCalled();
  expect(history.pushState).not.toHaveBeenCalled();
});
