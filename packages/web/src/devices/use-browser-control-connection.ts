import { versionedPath } from "@kiteline/shared/protocol/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserControlMessage, BrowserEvent, Device } from "@kiteline/shared/protocol";
import { api } from "../lib/api";
import { emit } from "../lib/events";
import type { LoginSession } from "../auth";
import { useServerVersion, webCompatible } from "../lib/release";

export function useBrowserControlConnection(
  authenticated: boolean,
  deviceId: string | undefined,
  workspaceId: string | undefined,
  onSession: (session: LoginSession) => void,
) {
  const serverVersion = useServerVersion();
  const [devices, setDevices] = useState<Device[]>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<unknown>();
  const socketRef = useRef<WebSocket | null>(null);
  const readGeneration = useRef(0);
  const invalidateReads = useCallback(() => ++readGeneration.current, []);
  const watchTargets = useRef<Extract<BrowserControlMessage, { type: "watch.set" }>["targets"]>([]);
  const readDevicesSnapshot = useCallback(async () => {
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
  // Update the watch before the connection effect can send it from onopen.
  useEffect(() => {
    watchTargets.current = deviceId && workspaceId ? [{ deviceId, workspaceId }] : [];
    if (socketRef.current?.readyState === WebSocket.OPEN)
      socketRef.current.send(
        JSON.stringify({
          type: "watch.set",
          targets: watchTargets.current,
        } satisfies BrowserControlMessage),
      );
  }, [deviceId, workspaceId]);
  // Authentication and server version own the session → snapshot → socket lifetime.
  useEffect(() => {
    if (!authenticated) return;
    let stopped = false;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let socket: WebSocket | undefined;
    async function connectControlSocket() {
      try {
        const session = await api<LoginSession>("/api/session");
        if (stopped) return;
        onSession(session);
        await readDevicesSnapshot();
        if (stopped || !webCompatible()) return;
        const url = new URL(versionedPath("/api/events"), location.origin);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url);
        socketRef.current = socket;
        socket.onopen = () => {
          setConnected(true);
          setError(undefined);
          socket?.send(
            JSON.stringify({
              type: "watch.set",
              targets: watchTargets.current,
            } satisfies BrowserControlMessage),
          );
          window.dispatchEvent(new Event("kiteline:connected"));
        };
        socket.onmessage = (event) => {
          if (stopped) return;
          const message = JSON.parse(String(event.data)) as BrowserEvent;
          if (message.type === "devices.changed") {
            invalidateReads();
            setDevices(message.devices);
          }
          emit("kiteline:event", message);
        };
        socket.onclose = () => {
          setConnected(false);
          if (!stopped) reconnectTimeout = setTimeout(() => void connectControlSocket(), 1500);
        };
      } catch (error) {
        if (!stopped) {
          setConnected(false);
          setError(error);
          reconnectTimeout = setTimeout(() => void connectControlSocket(), 3000);
        }
      }
    }
    const syncVisibleNotices = () => {
      if (
        document.visibilityState === "visible" &&
        socketRef.current?.readyState === WebSocket.OPEN
      )
        socketRef.current.send(
          JSON.stringify({ type: "notices.sync" } satisfies BrowserControlMessage),
        );
    };
    document.addEventListener("visibilitychange", syncVisibleNotices);
    window.addEventListener("pageshow", syncVisibleNotices);
    void connectControlSocket();
    return () => {
      document.removeEventListener("visibilitychange", syncVisibleNotices);
      window.removeEventListener("pageshow", syncVisibleNotices);
      stopped = true;
      // Invalidate pending snapshots before closing this connection.
      invalidateReads();
      clearTimeout(reconnectTimeout);
      socket?.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, [authenticated, readDevicesSnapshot, onSession, serverVersion, invalidateReads]);
  // A disconnected socket leaves the last successfully read snapshot available.
  return { devices: devices ?? [], loaded: devices !== undefined, connected, error };
}
