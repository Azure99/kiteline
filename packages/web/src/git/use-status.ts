import { useCallback, useEffect, useRef, useState } from "react";
import type { GitStatus } from "@kiteline/shared/protocol";
import { ApiError, rpc } from "../lib/api";
import { reconcileSelection, withoutSelection, type ChangeSelection } from "./selection";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";

type StatusRead =
  | { mode: "refresh" | "background" }
  | { mode: "page"; offset: number; expectedListToken?: string; visited: number[] };

export function useGitStatus(
  deviceId: string,
  workspaceId: string,
  repoId: string,
  active: boolean,
  completionRevision: number,
) {
  const [value, setValue] = useState<GitStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<ChangeSelection[]>([]);
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
    async (read: StatusRead): Promise<void> => {
      if (read.mode === "background" && request.current) {
        queued.current = true;
        return;
      }
      let offset = read.mode === "page" ? read.offset : (current.current?.offset ?? 0);
      const expectedListToken = read.mode === "page" ? read.expectedListToken : undefined;
      let visited = read.mode === "page" ? read.visited : history.current;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError(undefined);
      if (read.mode !== "background") setNotice([]);
      if (read.mode === "page") {
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
        const removed = withoutSelection(selection.current, retained);
        if (removed.length) setNotice((old) => [...withoutSelection(old, removed), ...removed]);
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
            void load({ mode: "background" });
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
  useWorkspaceRefresh(deviceId, workspaceId, active, () => load({ mode: "background" }));
  useEffect(() => {
    if (active && completionRevision) void load({ mode: "background" });
  }, [completionRevision, active, load]);
  return {
    value,
    busy,
    error,
    notice,
    selected,
    setSelected,
    consume: (completed: ChangeSelection[]) => {
      selection.current = withoutSelection(selection.current, completed);
      setSelected(selection.current);
      setNotice((old) => withoutSelection(old, completed));
    },
    load,
    previous: () => {
      const stack = history.current.slice();
      const offset = stack.pop() ?? 0;
      void load({
        mode: "page",
        offset,
        expectedListToken: current.current?.listToken,
        visited: stack,
      });
    },
    next: () => {
      const value = current.current;
      if (value?.nextOffset !== undefined)
        void load({
          mode: "page",
          offset: value.nextOffset,
          expectedListToken: value.listToken,
          visited: [...history.current, value.offset],
        });
    },
  };
}
