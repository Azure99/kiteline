import { useCallback, useEffect, useRef, useState } from "react";
import type { Device, Session } from "@kiteline/shared/protocol";
import { ApiError, rpc, errorMessage } from "../lib/api";

export function useSessions(device: Device, workspaceId: string) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [uncertainCreate, setUncertainCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const read = ++revision.current;
    if (device.status !== "online") return;
    try {
      const result = await rpc<{ sessions: Session[] }>(device.id, "sessions.list", {
        workspaceId,
      });
      if (alive.current && read === revision.current) {
        setSessions(result.sessions);
        setLoaded(true);
        setListError("");
      }
      return result.sessions;
    } catch (error) {
      if (alive.current && read === revision.current) setListError(errorMessage(error));
    }
  }, [device.id, device.status, workspaceId]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const changed = (event: Event) => {
      const message = (
        event as CustomEvent<{ type: string; deviceId: string; workspaceId: string }>
      ).detail;
      if (
        message.type === "sessions.changed" &&
        message.deviceId === device.id &&
        message.workspaceId === workspaceId
      )
        void refresh();
    };
    window.addEventListener("kiteline:event", changed);
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      alive.current = false;
      revision.current++;
      clearInterval(timer);
      window.removeEventListener("kiteline:event", changed);
    };
  }, [refresh, device.id, workspaceId]);
  async function create(shortcutId?: string) {
    setBusy(true);
    setError("");
    setUncertainCreate(false);
    try {
      const session = await rpc<Session>(device.id, "sessions.create", { workspaceId, shortcutId });
      if (alive.current) {
        revision.current++;
        setSessions((old) => [...old.filter((item) => item.id !== session.id), session]);
        return session;
      }
    } catch (error) {
      if (alive.current) {
        setError(errorMessage(error));
        setUncertainCreate(error instanceof ApiError && error.outcome === "unknown");
        const knownId =
          error instanceof ApiError &&
          error.result &&
          typeof error.result === "object" &&
          "sessionId" in error.result
            ? error.result.sessionId
            : undefined;
        const current = await refresh();
        if (alive.current) return current?.find((item) => item.id === knownId);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function change(kind: "rename" | "end", sessionId: string, name?: string) {
    setBusy(true);
    setError("");
    try {
      await rpc(device.id, `sessions.${kind}`, { workspaceId, sessionId, name });
      if (alive.current) {
        void refresh();
        return true;
      }
    } catch (error) {
      if (alive.current) setError(errorMessage(error));
    } finally {
      if (alive.current) setBusy(false);
    }
    return false;
  }
  return {
    sessions,
    loaded,
    error: error || listError,
    setError,
    busy,
    uncertainCreate,
    refresh,
    create,
    change,
    clearError: () => {
      setError("");
      setListError("");
    },
  };
}
