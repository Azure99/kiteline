import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useMobile } from "../lib/use-mobile";

export function useTerminalFocus(context: string | undefined, workspaceScope: string | undefined) {
  const mobile = useMobile();
  const [target, setTarget] = useState<string>();
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<"fullscreenFailed" | "fullscreenExitFailed">();
  const pending = useRef(false);
  const previousWorkspaceScope = useRef(workspaceScope);
  const exitPreviousContext = useEffectEvent(() => {
    if (target !== undefined || previousWorkspaceScope.current !== workspaceScope) exit();
    previousWorkspaceScope.current = workspaceScope;
  });
  useLayoutEffect(() => {
    exitPreviousContext();
  }, [context, workspaceScope]);
  useEffect(() => {
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!;
    const original = viewport.content;
    const changed = () => {
      const entered = document.fullscreenElement === document.documentElement;
      setFullscreen(entered);
      if (!entered) setTarget(undefined);
      viewport.content =
        entered && document.documentElement.hasAttribute("data-terminal-active")
          ? `${original}, viewport-fit=auto`
          : original;
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      viewport.content = original;
    };
  }, []);
  const active = context !== undefined && target === context;
  async function toggleFullscreen() {
    if (pending.current) return;
    pending.current = true;
    setError(undefined);
    const exiting = document.fullscreenElement === document.documentElement;
    try {
      if (exiting) await document.exitFullscreen();
      else {
        if (mobile) setTarget(context);
        await document.documentElement.requestFullscreen();
      }
    } catch {
      if (!exiting && mobile) setTarget(undefined);
      setError(exiting ? "fullscreenExitFailed" : "fullscreenFailed");
    } finally {
      pending.current = false;
    }
  }
  function exit() {
    if (document.fullscreenElement === document.documentElement) {
      void toggleFullscreen();
    } else {
      setTarget(undefined);
      setError(undefined);
    }
  }
  function toggle() {
    if (active || fullscreen) {
      void toggleFullscreen();
    } else {
      setTarget(context);
      setError(undefined);
    }
  }
  return {
    active,
    fullscreen,
    toggle,
    exit,
    toggleFullscreen,
    error,
    dismiss: () => setError(undefined),
  };
}
