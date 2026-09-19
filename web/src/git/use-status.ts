import { useCallback, useEffect, useRef, useState } from "react";
import type { GitStatus } from "@kiteline/shared/protocol";
import { ApiError, rpc } from "../lib/api";
import { reconcileSelection, type ChangeSelection } from "./selection";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";

export function useGitStatus(
  deviceId: string,
  workspaceId: string,
  repoId: string,
  active: boolean,
) {
  const [value, setValue] = useState<GitStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState(0);
  const [selected, setSelected] = useState<ChangeSelection[]>([]);
  const current = useRef<GitStatus>(undefined);
  const selection = useRef(selected);
  selection.current = selected;
  const history = useRef<number[]>([]);
  const request = useRef<AbortController>(undefined);
  const queued = useRef(false);
  const enabled = useRef(active);
  enabled.current = active;
  const load = useCallback(
    async (
      offset = current.current?.offset ?? 0,
      expectedListToken?: string,
      visited = history.current,
      paging = false,
      background = false,
    ): Promise<void> => {
      if (background && request.current) {
        queued.current = true;
        return;
      }
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError(undefined);
      if (!background) setNotice(0);
      if (paging) {
        selection.current = [];
        setSelected([]);
      }
      try {
        let next: GitStatus;
        try {
          next = await rpc(
            deviceId,
            "git.status",
            { workspaceId, repoId, offset, expectedListToken },
            controller.signal,
          );
        } catch (error) {
          if (expectedListToken && error instanceof ApiError && error.code === "conflict") {
            visited = history.current;
            next = await rpc(
              deviceId,
              "git.status",
              { workspaceId, repoId, offset: current.current?.offset ?? 0 },
              controller.signal,
            );
          } else throw error;
        }
        if (next.offset > 0 && next.offset >= next.totalCount) {
          offset = [...visited].reverse().find((item) => item < next.totalCount) ?? 0;
          visited = visited.filter((item) => item < offset);
          next = await rpc(
            deviceId,
            "git.status",
            { workspaceId, repoId, offset },
            controller.signal,
          );
        }
        if (controller.signal.aborted) return;
        const retained = reconcileSelection(selection.current, current.current, next);
        if (selection.current.length > retained.length)
          setNotice(selection.current.length - retained.length);
        selection.current = retained;
        setSelected(retained);
        history.current = visited.filter((item) => item < next.offset);
        current.current = next;
        setValue(next);
      } catch (error) {
        if (!controller.signal.aborted) setError(error);
      } finally {
        if (request.current === controller) {
          request.current = undefined;
          setBusy(false);
          if (queued.current && enabled.current && !document.hidden) {
            queued.current = false;
            void load(undefined, undefined, undefined, false, true);
          }
        }
      }
    },
    [deviceId, workspaceId, repoId],
  );
  useEffect(() => {
    return () => {
      queued.current = false;
      request.current?.abort();
    };
  }, [active, load]);
  useWorkspaceRefresh(deviceId, workspaceId, active, "git", () =>
    load(undefined, undefined, undefined, false, true),
  );
  return {
    value,
    busy,
    error,
    notice,
    selected,
    setSelected,
    load,
    previous: () => {
      const stack = history.current.slice();
      const offset = stack.pop() ?? 0;
      void load(offset, current.current?.listToken, stack, true);
    },
    next: () => {
      const value = current.current;
      if (value?.nextOffset !== undefined)
        void load(value.nextOffset, value.listToken, [...history.current, value.offset], true);
    },
  };
}
