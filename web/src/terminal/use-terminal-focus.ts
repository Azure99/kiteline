import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type FocusIntent = { target: string; attempted: boolean };

export function useTerminalFocus(context: string | undefined) {
  const [target, setTarget] = useState<FocusIntent>();
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<"fullscreenFailed" | "fullscreenExitFailed">();
  const intent = useRef<FocusIntent>(undefined);
  const pending = useRef<FocusIntent>(undefined);
  const exiting = useRef(false);

  const leaveFullscreen = useCallback(() => {
    if (document.fullscreenElement !== document.documentElement || exiting.current) return;
    exiting.current = true;
    void document.exitFullscreen().then(
      () => {
        exiting.current = false;
        const remains = document.fullscreenElement === document.documentElement;
        setFullscreen(remains);
        if (remains) setError("fullscreenExitFailed");
      },
      () => {
        exiting.current = false;
        setFullscreen(document.fullscreenElement === document.documentElement);
        setError("fullscreenExitFailed");
      },
    );
  }, []);
  const exit = useCallback(() => {
    intent.current = undefined;
    setTarget(undefined);
    setError(undefined);
    leaveFullscreen();
  }, [leaveFullscreen]);

  useLayoutEffect(() => {
    if (intent.current?.target !== context) exit();
  }, [context, exit]);
  useEffect(() => {
    const changed = () => {
      const current = intent.current;
      const entered = document.fullscreenElement === document.documentElement;
      setFullscreen(entered);
      if (entered && (!current || (pending.current && pending.current !== current)))
        leaveFullscreen();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, [leaveFullscreen]);
  useEffect(
    () => () => {
      intent.current = undefined;
      leaveFullscreen();
    },
    [leaveFullscreen],
  );

  function request(current: FocusIntent) {
    const root = document.documentElement;
    if (exiting.current || pending.current || !root.requestFullscreen) {
      setError("fullscreenFailed");
      return;
    }
    pending.current = current;
    try {
      void root.requestFullscreen().then(
        () => {
          if (pending.current === current) pending.current = undefined;
          if (intent.current !== current) leaveFullscreen();
        },
        () => {
          if (pending.current === current) pending.current = undefined;
          if (intent.current === current) setError("fullscreenFailed");
        },
      );
    } catch {
      pending.current = undefined;
      if (intent.current === current) setError("fullscreenFailed");
    }
  }
  const active = context !== undefined && target?.target === context;
  const next: "exitFocus" | "enterFullscreen" | "enterFocus" =
    fullscreen || (active && target.attempted)
      ? "exitFocus"
      : active
        ? "enterFullscreen"
        : "enterFocus";
  function toggle() {
    if (next === "exitFocus") return exit();
    if (!context) return;
    setError(undefined);
    const current = { target: context, attempted: active };
    intent.current = current;
    setTarget(current);
    if (current.attempted) request(current);
  }
  return { active, fullscreen, next, toggle, error, dismiss: () => setError(undefined) };
}
