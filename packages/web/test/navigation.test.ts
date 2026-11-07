import { afterEach, expect, test, vi } from "vitest";
import {
  parseRoute,
  workspacePath,
  workspaceDestination,
  navigateWorkspace,
  navigationIntent,
  updateWorkspaceQuery,
  tasksPath,
} from "../src/lib/navigation";
import {
  beginFileNavigation,
  clearFileNavigationHistory,
  openFileLocation,
  previewFileLocation,
  returnToFileOrigin,
  showFile,
} from "../src/files/navigation";

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
  updateWorkspaceQuery(
    { ...target, workspaceId: "other" },
    { file: "late.txt" },
    { replace: true },
  );
  expect(history.replaceState).not.toHaveBeenCalled();
  expect(history.pushState).not.toHaveBeenCalled();
});

test("file opens preserve search only when requested and reject invalid line numbers", () => {
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
  showFile(target, 61, true);
  expect(parseRoute(browser.location).query).toMatchObject({
    file: target.path,
    folder: "src",
    line: 61,
    draft: undefined,
    search: true,
    reveal: undefined,
  });
  const next = { ...target, path: "test/other.ts" };
  showFile(next, 17, true);
  expect(parseRoute(browser.location)).toMatchObject({
    deviceId: target.deviceId,
    workspaceId: target.workspaceId,
    tool: "files",
    query: {
      file: next.path,
      folder: "test",
      line: 17,
      draft: undefined,
      search: true,
      reveal: undefined,
    },
  });
  showFile(target);
  expect(parseRoute(browser.location).query).toMatchObject({
    file: target.path,
    folder: "src",
    line: undefined,
    draft: undefined,
    search: undefined,
    reveal: undefined,
  });
});

test("workspace navigation preserves history and distinguishes open, view and native events", () => {
  const target = { deviceId: "d", workspaceId: "w" };
  const browser = Object.assign(new EventTarget(), {
    location: new URL("https://kiteline.test/devices/d/workspaces/w/files?file=alias.txt"),
  });
  const pageState = { workPage: { workspace: "d:w", id: "file:draft" } };
  const navigation = {
    state: pageState as unknown,
    replaceState: vi.fn((state: unknown, _title: string, path: string) => {
      navigation.state = state;
      browser.location = new URL(path, browser.location);
    }),
    pushState: vi.fn((state: unknown, _title: string, path: string) => {
      navigation.state = state;
      browser.location = new URL(path, browser.location);
    }),
  };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("history", navigation);
  vi.stubGlobal("PopStateEvent", Event);
  const routeChanged = vi.fn();
  browser.addEventListener("popstate", routeChanged);

  updateWorkspaceQuery(target, { file: "actual.txt" }, { replace: true });
  expect(parseRoute(browser.location).query.file).toBe("actual.txt");
  expect(navigation.state).toBe(pageState);
  expect(navigation.replaceState).toHaveBeenCalledOnce();
  expect(navigation.pushState).not.toHaveBeenCalled();
  expect(routeChanged).toHaveBeenCalledOnce();
  expect(navigationIntent(routeChanged.mock.calls[0]![0] as PopStateEvent)).toBe("view");

  updateWorkspaceQuery(target, { file: "actual.txt" }, { replace: true });
  expect(routeChanged).toHaveBeenCalledOnce();

  navigateWorkspace(target, "files", { file: "actual.txt" }, { replace: true });
  expect(navigation.replaceState).toHaveBeenCalledOnce();
  expect(navigation.pushState).not.toHaveBeenCalled();
  expect(routeChanged).toHaveBeenCalledTimes(2);
  expect(navigationIntent(routeChanged.mock.calls[1]![0] as PopStateEvent)).toBe("open");

  navigateWorkspace(target, "files", { file: "actual.txt" }, { intent: "view" });
  expect(routeChanged).toHaveBeenCalledTimes(2);

  navigateWorkspace(target, "git", { repo: "repo" });
  expect(parseRoute(browser.location).tool).toBe("git");
  expect(navigation.state).toBeNull();
  expect(navigation.pushState).toHaveBeenCalledOnce();
  expect(routeChanged).toHaveBeenCalledTimes(3);
  expect(navigationIntent(routeChanged.mock.calls[2]![0] as PopStateEvent)).toBe("open");

  browser.dispatchEvent(new Event("popstate"));
  expect(navigationIntent(routeChanged.mock.calls[3]![0] as PopStateEvent)).toBeUndefined();
});

function navigationBrowser(path: string, initialState: unknown) {
  const browser = Object.assign(new EventTarget(), {
    location: new URL(path, "https://kiteline.test"),
  });
  const entries = [{ path: browser.location.href, state: initialState }];
  let index = 0;
  function move(offset: number) {
    const next = index + offset;
    if (next < 0 || next >= entries.length) return;
    index = next;
    browser.location = new URL(entries[index]!.path);
    browser.dispatchEvent(new Event("popstate"));
  }
  const history = {
    get state() {
      return entries[index]!.state;
    },
    get length() {
      return entries.length;
    },
    replaceState(state: unknown, _title: string, path?: string) {
      if (path !== undefined) browser.location = new URL(path, browser.location);
      entries[index] = { path: browser.location.href, state: structuredClone(state) };
    },
    pushState(state: unknown, _title: string, path?: string) {
      entries.splice(index + 1);
      entries.push({ path: browser.location.href, state: null });
      index++;
      this.replaceState(state, _title, path);
    },
    back: () => move(-1),
    forward: () => move(1),
  };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("history", history);
  vi.stubGlobal("PopStateEvent", Event);
  return { browser, history };
}

const target = { deviceId: "d", workspaceId: "w" };
const lookup = {
  id: "lookup",
  origin: { path: "origin.ts", draftId: "origin-draft" },
};
const lookupCandidate = {
  ...target,
  path: "definition.ts",
  draftId: "definition-draft",
  entryKey: "definition-1",
};

function lookupBrowser() {
  const path = workspacePath("d", "w", "files", {
    file: lookup.origin.path,
    draft: lookup.origin.draftId,
    line: 30,
    reveal: "src",
  });
  const source = { workPage: { workspace: "d:w", id: "origin-page" } };
  const { browser, history } = navigationBrowser(path, source);
  const intents: ReturnType<typeof navigationIntent>[] = [];
  browser.addEventListener("popstate", (event) =>
    intents.push(navigationIntent(event as PopStateEvent)),
  );
  beginFileNavigation(target, lookup);
  return { browser, history, source, intents };
}

test.each([false, true])(
  "one candidate history slot covers document opens (preview first: %s)",
  (previewFirst) => {
    const { browser, history, source, intents } = lookupBrowser();
    expect(history.length).toBe(1);
    expect(parseRoute(browser.location).query).toMatchObject({
      file: lookup.origin.path,
      draft: lookup.origin.draftId,
      line: 30,
      reveal: "src",
    });
    expect(history.state).toEqual({
      ...source,
      fileNavigation: { ...target, ...lookup.origin, sessionId: lookup.id, kind: "origin" },
    });
    expect(intents).toEqual([]);
    expect(returnToFileOrigin(lookup.id)).toBe(false);
    if (previewFirst) previewFileLocation(lookup.id, lookupCandidate.entryKey);
    openFileLocation(lookupCandidate, lookup.id);
    const next = { ...lookupCandidate, path: "use.ts", draftId: undefined, entryKey: "use-1" };
    openFileLocation(next, lookup.id);
    expect(history.length).toBe(2);
    expect(parseRoute(browser.location)).toMatchObject({
      tool: "files",
      query: { file: next.path, draft: next.draftId, line: undefined, reveal: undefined },
    });
    expect(history.state).toEqual({
      fileNavigation: { ...next, sessionId: lookup.id, kind: "document" },
    });
    expect(intents).toEqual(Array(previewFirst ? 3 : 2).fill("lookup"));
    expect(returnToFileOrigin("other-lookup")).toBe(false);
    expect(returnToFileOrigin(lookup.id)).toBe(true);
    expect(parseRoute(browser.location).query.file).toBe(lookup.origin.path);
    expect(history.state).toMatchObject({ ...source, fileNavigation: { kind: "origin" } });
    history.forward();
    expect(parseRoute(browser.location).query.file).toBe(next.path);
    expect(history.state).toEqual({
      fileNavigation: { ...next, sessionId: lookup.id, kind: "document" },
    });
    expect(intents.slice(-2)).toEqual([undefined, undefined]);
  },
);

test("preview replaces its identity while retaining the underlying file and page", () => {
  const { browser, history, source, intents } = lookupBrowser();
  const originPath = browser.location.href;
  previewFileLocation(lookup.id, "first");
  previewFileLocation(lookup.id, "second");
  expect(history.length).toBe(2);
  expect(browser.location.href).toBe(originPath);
  expect(history.state).toEqual({
    ...source,
    fileNavigation: {
      ...target,
      ...lookup.origin,
      sessionId: lookup.id,
      kind: "preview",
      entryKey: "second",
    },
  });
  openFileLocation(lookupCandidate, lookup.id);
  const documentPath = browser.location.href;
  previewFileLocation(lookup.id, "after-open");
  expect(history.length).toBe(2);
  expect(browser.location.href).toBe(documentPath);
  expect(history.state).toEqual({
    fileNavigation: {
      ...lookupCandidate,
      sessionId: lookup.id,
      kind: "preview",
      entryKey: "after-open",
    },
  });
  expect(intents).toEqual(["lookup", "lookup", "lookup", "lookup"]);
  history.back();
  expect(history.state).toMatchObject({ fileNavigation: { kind: "origin" } });
  history.forward();
  expect(history.state).toMatchObject({ fileNavigation: { entryKey: "after-open" } });
});

test("a new lookup begins at the current candidate and leaves earlier identities unchanged", () => {
  const { browser, history } = lookupBrowser();
  openFileLocation(lookupCandidate, lookup.id);
  const next = {
    id: "next-lookup",
    origin: { path: lookupCandidate.path, draftId: lookupCandidate.draftId },
  };
  beginFileNavigation(target, next);
  expect(history.length).toBe(2);
  expect(history.state).toMatchObject({
    fileNavigation: { sessionId: next.id, kind: "origin", path: lookupCandidate.path },
  });
  previewFileLocation(next.id, "next-candidate");
  expect(history.length).toBe(3);
  expect(returnToFileOrigin(next.id)).toBe(true);
  expect(parseRoute(browser.location).query.file).toBe(lookupCandidate.path);
  expect(history.state).toMatchObject({ fileNavigation: { sessionId: next.id, kind: "origin" } });
  expect(returnToFileOrigin(next.id)).toBe(false);
  history.back();
  expect(parseRoute(browser.location).query.file).toBe(lookup.origin.path);
  expect(history.state).toMatchObject({ fileNavigation: { sessionId: lookup.id, kind: "origin" } });
  expect(returnToFileOrigin(next.id)).toBe(false);
});

test("clearing lookup history removes only the current entry's reference", () => {
  const { browser, history, source } = lookupBrowser();
  previewFileLocation(lookup.id, "candidate");
  const path = browser.location.href;
  clearFileNavigationHistory();
  expect(history.length).toBe(2);
  expect(browser.location.href).toBe(path);
  expect(history.state).toEqual(source);
  history.back();
  expect(history.state).toMatchObject({ fileNavigation: { sessionId: lookup.id, kind: "origin" } });
  history.forward();
  expect(history.state).toEqual(source);
});
