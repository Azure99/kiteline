import { useCallback, useEffect, useRef, useState } from "react";
import type { Repo, RepoDiscovery } from "@kiteline/shared/protocol";
import { ApiError } from "../lib/api";
import { cursorRpc, releaseCursor } from "../lib/cursors";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";

interface DiscoveredRepo extends Repo {
  discovered: boolean;
}

export function useRepos(deviceId: string, workspaceId: string, online: boolean, active: boolean) {
  const enabled = online && active;
  const [repos, setRepos] = useState<DiscoveredRepo[]>([]);
  const [scan, setScan] = useState<RepoDiscovery>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const request = useRef<AbortController>(undefined);
  const scanCursor = useRef<string>(undefined);
  const scanned = useRef(new Map<string, Repo>());
  const initialScan = useRef(true);
  const discover = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      do {
        const cursor = scanCursor.current;
        if (!cursor) scanned.current.clear();
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
          for (const repo of scanned.current.values())
            entries.set(repo.id, { ...repo, discovered: true });
          return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
        });
        setScan(found);
        if (found.complete) initialScan.current = false;
        if (found.issues.length) break;
      } while (
        initialScan.current &&
        scanCursor.current &&
        !document.hidden &&
        !controller.signal.aborted
      );
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
  useEffect(() => {
    const invalidate = () => setRepos((old) => old.map((repo) => ({ ...repo, discovered: false })));
    window.addEventListener("kiteline:connected", invalidate);
    return () => {
      window.removeEventListener("kiteline:connected", invalidate);
      invalidate();
    };
  }, [online, discover]);
  useWorkspaceRefresh(deviceId, workspaceId, enabled, discover);
  const scanComplete = !!scan?.complete && !error && !scan.issues.length;
  const defaultRepoId = (repos.find((repo) => repo.available) ?? repos[0])?.id;
  return { repos, scan, busy, error, discover, scanComplete, defaultRepoId };
}
