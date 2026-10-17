import { afterEach, expect, test, vi } from "vitest";
import {
  parseRoute,
  workspacePath,
  workspaceDestination,
  updateWorkspaceQuery,
  tasksPath,
} from "../src/lib/navigation";
import { showFile } from "../src/files/navigation";

afterEach(() => vi.unstubAllGlobals());

test("scheduled task selection preserves an independent list device filter", () => {
  const selected = { filter: "d-filter", deviceId: "d/target", taskId: "t 1", runId: "r/1" };
  const route = parseRoute(new URL(tasksPath(selected), "https://kiteline.test"));
  expect(route.tasks).toEqual(selected);
  expect(route.deviceId).toBe("d/target");
  expect(route.workspaceId).toBeUndefined();
  expect(
    parseRoute(new URL(tasksPath({ deviceId: "d", taskId: "t" }), "https://kiteline.test")).tasks
      ?.filter,
  ).toBeUndefined();
  expect(tasksPath()).toBe("/tasks");
});

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
    line: 61,
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

test("file line requests reject invalid numbers and normal file opens clear the old request", () => {
  for (const line of ["0", "-1", "1.5", "Infinity", "NaN", "9007199254740992"])
    expect(parseRoute(new URL(`https://kiteline.test/?line=${line}`)).query.line).toBeUndefined();
  const target = { deviceId: "d", workspaceId: "w", path: "src/main.ts" };
  const browser = Object.assign(new EventTarget(), {
    location: new URL(
      "https://kiteline.test/devices/d/workspaces/w/terminal?draft=old&search=1&reveal=old&line=5",
    ),
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("PopStateEvent", Event);
  vi.stubGlobal("history", {
    pushState: (_state: unknown, _title: string, path: string) => {
      browser.location = new URL(path, browser.location);
    },
  });
  showFile(target, 61);
  expect(parseRoute(browser.location).query).toMatchObject({
    file: target.path,
    folder: "src",
    line: 61,
    draft: undefined,
    search: undefined,
    reveal: undefined,
  });
  showFile(target);
  expect(parseRoute(browser.location).query.line).toBeUndefined();
});
