import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserEvent, Device } from "@kiteline/shared/protocol";
import { api } from "../lib/api";
import type { LoginSession } from "../auth";
import { useServerVersion, versionedPath, webCompatible } from "../lib/release";

export function useDevices(
  active: boolean,
  deviceId?: string,
  workspaceId?: string,
  onSession?: (session: LoginSession) => void,
) {
  const serverVersion = useServerVersion();
  const [devices, setDevices] = useState<Device[]>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<unknown>();
  const socketRef = useRef<WebSocket | null>(null);
  const readGeneration = useRef(0);
  const invalidateReads = useCallback(() => ++readGeneration.current, []);
  const targets = useRef<{ deviceId: string; workspaceId: string }[]>([]);
  const refresh = useCallback(async () => {
    const generation = invalidateReads();
    try {
      const result = await api<{ devices: Device[] }>("/api/devices");
      if (generation !== readGeneration.current) return;
      setDevices(result.devices);
      setError(undefined);
    } catch (error) {
      if (generation === readGeneration.current) throw error;
    }
  }, [invalidateReads]);
  useEffect(() => {
    targets.current = deviceId && workspaceId ? [{ deviceId, workspaceId }] : [];
    if (socketRef.current?.readyState === WebSocket.OPEN)
      socketRef.current.send(JSON.stringify({ type: "watch.set", targets: targets.current }));
  }, [deviceId, workspaceId]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    let socket: WebSocket | undefined;
    async function connect() {
      try {
        const session = await api<LoginSession>("/api/session");
        if (stopped) return;
        onSession?.(session);
        await refresh();
        if (stopped || !webCompatible()) return;
        const url = new URL(versionedPath("/api/events"), location.origin);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url);
        socketRef.current = socket;
        socket.onopen = () => {
          setConnected(true);
          setError(undefined);
          socket?.send(JSON.stringify({ type: "watch.set", targets: targets.current }));
          window.dispatchEvent(new Event("kiteline:connected"));
        };
        socket.onmessage = (event) => {
          if (stopped) return;
          const message = JSON.parse(String(event.data)) as BrowserEvent;
          if (message.type === "devices.changed") {
            invalidateReads();
            setDevices(message.devices);
          }
          window.dispatchEvent(new CustomEvent("kiteline:event", { detail: message }));
        };
        socket.onclose = () => {
          setConnected(false);
          if (!stopped) retry = setTimeout(() => void connect(), 1500);
        };
      } catch (error) {
        if (!stopped) {
          setConnected(false);
          setError(error);
          retry = setTimeout(() => void connect(), 3000);
        }
      }
    }
    void connect();
    return () => {
      stopped = true;
      invalidateReads();
      clearTimeout(retry);
      socket?.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, [active, refresh, onSession, serverVersion, invalidateReads]);
  return { devices: devices ?? [], loaded: devices !== undefined, connected, error, refresh };
}
