import { useCallback, useEffect, useRef, useState } from "react";
import type { Repo, RepoDiscovery } from "@kiteline/shared/protocol";
import { ApiError } from "../lib/api";
import { cursorRpc, releaseCursor } from "../lib/cursors";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";

export function useRepos(deviceId: string, workspaceId: string, enabled: boolean) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [scan, setScan] = useState<RepoDiscovery>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const request = useRef<AbortController>(undefined);
  const scanCursor = useRef<string>(undefined);
  const scanned = useRef(new Map<string, Repo>());
  const discover = useCallback(async () => {
    if (request.current) return;
    const cursor = scanCursor.current;
    if (!cursor) scanned.current.clear();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const read = (scanCursor?: string) =>
        cursorRpc(deviceId, "repos.discover", { workspaceId, scanCursor }, controller.signal);
      let found: RepoDiscovery;
      try {
        found = await read(cursor);
      } catch (error) {
        if (
          !cursor ||
          !(error instanceof ApiError) ||
          error.code !== "conflict" ||
          controller.signal.aborted
        )
          throw error;
        scanCursor.current = undefined;
        scanned.current.clear();
        found = await read();
      }
      if (controller.signal.aborted) {
        void releaseCursor(deviceId, "repo", found.scanCursor);
        return;
      }
      scanCursor.current = found.scanCursor;
      for (const repo of found.repos) scanned.current.set(repo.id, repo);
      setRepos((old) => {
        const entries = new Map((found.complete ? [] : old).map((item) => [item.id, item]));
        for (const repo of scanned.current.values()) entries.set(repo.id, repo);
        return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
      });
      setScan(found);
    } catch (error) {
      if (!controller.signal.aborted) setError(error);
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setBusy(false);
      }
    }
  }, [deviceId, workspaceId]);
  useEffect(() => {
    return () => {
      request.current?.abort();
      request.current = undefined;
      void releaseCursor(deviceId, "repo", scanCursor.current);
      scanCursor.current = undefined;
    };
  }, [enabled, discover, deviceId]);
  useWorkspaceRefresh(deviceId, workspaceId, enabled, "repos", discover);
  return { repos, scan, busy, error, discover };
}
