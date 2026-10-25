import { useCallback, useEffect, useRef, useState } from "react";
import type { Entry, FileListing } from "@kiteline/shared/protocol";
import { ApiError } from "../lib/api";
import { cursorRpc, releaseCursor } from "../lib/cursors";
import { isWithin } from "./paths";

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
      const initialPages = pagesRef.current;
      const previous = initialPages[path]?.listing;
      pagesRef.current = {
        ...initialPages,
        [path]: { ...initialPages[path], busy: true, error: undefined },
      };
      setPages(pagesRef.current);
      try {
        if (!more) await releaseCursor(deviceId, "directory", previous?.entries.nextCursor);
        let result = await cursorRpc(
          deviceId,
          "files.list",
          {
            workspaceId,
            path,
            cursor: more ? previous?.entries.nextCursor : undefined,
          },
          controller.signal,
        );
        if (controller.signal.aborted) {
          void releaseCursor(deviceId, "directory", result.entries.nextCursor);
          return;
        }
        const refreshed = [...result.entries.items];
        while (
          !more &&
          refreshed.length < (previous?.entries.items.length ?? 0) &&
          result.entries.nextCursor
        ) {
          result = await cursorRpc(
            deviceId,
            "files.list",
            {
              workspaceId,
              path,
              cursor: result.entries.nextCursor,
            },
            controller.signal,
          );
          if (controller.signal.aborted) {
            void releaseCursor(deviceId, "directory", result.entries.nextCursor);
            return;
          }
          refreshed.push(...result.entries.items);
        }
        const items =
          more && previous ? [...previous.entries.items, ...result.entries.items] : refreshed;
        items.sort(compareEntries);
        const listing = { ...result, entries: { ...result.entries, items } };
        if (result.path !== path) {
          const current = pagesRef.current[result.path];
          if (current !== initialPages[result.path]) {
            void releaseCursor(deviceId, "directory", result.entries.nextCursor);
            const next = { ...pagesRef.current };
            delete next[path];
            pagesRef.current = next;
            setPages(next);
            return { ...listing, entries: { ...listing.entries, nextCursor: undefined } };
          }
          void releaseCursor(deviceId, "directory", current?.listing?.entries.nextCursor);
        }
        const next = { ...pagesRef.current };
        delete next[path];
        pagesRef.current = { ...next, [result.path]: { listing, busy: false } };
        setPages(pagesRef.current);
        return listing;
      } catch (error) {
        if (!controller.signal.aborted) {
          const page = pagesRef.current[path]!;
          if (
            more &&
            previous?.entries.nextCursor &&
            error instanceof ApiError &&
            error.code === "conflict"
          ) {
            pagesRef.current = {
              ...pagesRef.current,
              [path]: {
                ...page,
                listing: page.listing && {
                  ...page.listing,
                  entries: { ...page.listing.entries, nextCursor: undefined },
                },
              },
            };
            setPages(pagesRef.current);
            return load(path);
          }
          pagesRef.current = { ...pagesRef.current, [path]: { ...page, busy: false, error } };
          setPages(pagesRef.current);
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
      for (const page of Object.values(pagesRef.current))
        void releaseCursor(deviceId, "directory", page.listing?.entries.nextCursor);
      pending.clear();
      waiting.clear();
    };
  }, [active, deviceId]);
  function forget(path: string) {
    for (const [key, request] of requests.current)
      if (isWithin(key, path)) {
        request.abort();
        requests.current.delete(key);
      }
    for (const [key, page] of Object.entries(pagesRef.current))
      if (isWithin(key, path)) {
        queued.current.delete(key);
        void releaseCursor(deviceId, "directory", page.listing?.entries.nextCursor);
      }
    pagesRef.current = Object.fromEntries(
      Object.entries(pagesRef.current).filter(([key]) => !isWithin(key, path)),
    );
    setPages(pagesRef.current);
  }
  return { pages, load, forget };
}
function compareEntries(a: Entry, b: Entry) {
  return (
    Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)
  );
}
