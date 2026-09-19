import { useCallback, useEffect, useRef, useState } from "react";
import type { Entry, FileListing } from "@kiteline/shared/protocol";
import { rpc } from "../lib/api";
import { i18n } from "../i18n";

export interface DirectoryPage {
  listing?: FileListing;
  busy: boolean;
  error?: unknown;
}
export function useFileBrowser(deviceId: string, workspaceId: string, active: boolean) {
  const [pages, setPages] = useState<Record<string, DirectoryPage>>({});
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const requests = useRef(new Map<string, AbortController>());
  const queued = useRef(new Set<string>());
  const enabled = useRef(active);
  enabled.current = active;
  const load = useCallback(
    async (path: string, more = false, background = false): Promise<FileListing | undefined> => {
      if (!enabled.current) return;
      if (background && requests.current.has(path)) {
        queued.current.add(path);
        return;
      }
      requests.current.get(path)?.abort();
      const controller = new AbortController();
      requests.current.set(path, controller);
      const previous = pagesRef.current[path]?.listing;
      setPages((old) => ({ ...old, [path]: { ...old[path], busy: true, error: undefined } }));
      try {
        let result = await rpc(
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
        const refreshed = [...result.entries.items];
        while (
          !more &&
          refreshed.length < (previous?.entries.items.length ?? 0) &&
          result.entries.nextCursor
        ) {
          result = await rpc(
            deviceId,
            "files.list",
            {
              workspaceId,
              path,
              cursor: result.entries.nextCursor,
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          refreshed.push(...result.entries.items);
        }
        const items =
          more && previous ? [...previous.entries.items, ...result.entries.items] : refreshed;
        items.sort(compareEntries);
        const listing = { ...result, entries: { ...result.entries, items } };
        pagesRef.current = { ...pagesRef.current, [path]: { listing, busy: false } };
        setPages(pagesRef.current);
        return listing;
      } catch (error) {
        if (!controller.signal.aborted) {
          setPages((old) => ({
            ...old,
            [path]: { ...old[path], busy: false, error },
          }));
        }
      } finally {
        if (requests.current.get(path) === controller) {
          requests.current.delete(path);
          if (queued.current.delete(path) && enabled.current && !document.hidden)
            void load(path, false, true);
        }
      }
    },
    [deviceId, workspaceId],
  );
  useEffect(() => {
    enabled.current = active;
    const pending = requests.current,
      waiting = queued.current;
    return () => {
      enabled.current = false;
      for (const request of pending.values()) request.abort();
      pending.clear();
      waiting.clear();
    };
  }, [active]);
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
  if (bytes < 1024) return `${bytes.toLocaleString(i18n.resolvedLanguage)} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toLocaleString(i18n.resolvedLanguage, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KiB`;
  return `${(bytes / 1024 / 1024).toLocaleString(i18n.resolvedLanguage, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MiB`;
}
