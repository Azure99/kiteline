import { useCallback, useEffect, useRef, useState } from "react";
import type { Entry, FileListing } from "@kiteline/shared/protocol";
import { errorMessage, rpc } from "../lib/api";

export interface DirectoryPage {
  listing?: FileListing;
  busy: boolean;
  error?: string;
}
export function useFileBrowser(deviceId: string, workspaceId: string, active: boolean) {
  const [pages, setPages] = useState<Record<string, DirectoryPage>>({});
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const requests = useRef(new Map<string, AbortController>());
  const load = useCallback(
    async (path: string, more = false) => {
      requests.current.get(path)?.abort();
      const controller = new AbortController();
      requests.current.set(path, controller);
      const previous = pagesRef.current[path]?.listing;
      setPages((old) => ({ ...old, [path]: { ...old[path], busy: true, error: undefined } }));
      try {
        const result = await rpc<FileListing>(
          deviceId,
          "files.list",
          {
            workspaceId,
            path,
            cursor: more ? previous?.entries.nextCursor : undefined,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const items =
          more && previous
            ? [...previous.entries.items, ...result.entries.items]
            : result.entries.items;
        items.sort(compareEntries);
        const listing = { ...result, entries: { ...result.entries, items } };
        setPages((old) => ({ ...old, [path]: { listing, busy: false } }));
        return listing;
      } catch (error) {
        if (!controller.signal.aborted) {
          setPages((old) => ({
            ...old,
            [path]: { ...old[path], busy: false, error: errorMessage(error) },
          }));
        }
      } finally {
        if (requests.current.get(path) === controller) requests.current.delete(path);
      }
    },
    [deviceId, workspaceId],
  );
  useEffect(() => {
    const pending = requests.current;
    return () => {
      for (const request of pending.values()) request.abort();
      pending.clear();
    };
  }, []);
  useEffect(() => {
    if (active) void load(".");
  }, [active, load]);
  function forget(path: string) {
    for (const [key, request] of requests.current)
      if (isWithin(key, path)) {
        request.abort();
        requests.current.delete(key);
      }
    setPages((old) =>
      Object.fromEntries(Object.entries(old).filter(([key]) => !isWithin(key, path))),
    );
  }
  return { pages, load, forget };
}
export function isWithin(path: string, directory: string) {
  return path === directory || path.startsWith(directory + "/");
}
export function movedPath(path: string, from: string, to: string) {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}
function compareEntries(a: Entry, b: Entry) {
  return (
    Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)
  );
}
export function parentPath(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}
export function childPath(parent: string, name: string) {
  return parent === "." ? name : `${parent}/${name}`;
}
export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
