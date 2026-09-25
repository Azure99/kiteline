import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export function useTerminalFocus(context: string | undefined) {
  const [target, setTarget] = useState<string>();
  const intent = useRef<{ target: string; entered: boolean }>(undefined);
  const exiting = useRef(false);

  const leaveFullscreen = useCallback(() => {
    if (document.fullscreenElement !== document.documentElement || exiting.current) return;
    exiting.current = true;
    void document.exitFullscreen().then(
      () => {
        exiting.current = false;
        if (document.fullscreenElement === document.documentElement) {
          if (intent.current) intent.current.entered = true;
          else leaveFullscreen();
        }
      },
      () => {
        exiting.current = false;
      },
    );
  }, []);
  const exit = useCallback(() => {
    intent.current = undefined;
    setTarget(undefined);
    leaveFullscreen();
  }, [leaveFullscreen]);

  useLayoutEffect(() => {
    if (intent.current?.target !== context) exit();
  }, [context, exit]);
  useEffect(() => {
    const changed = () => {
      const current = intent.current;
      if (document.fullscreenElement === document.documentElement) {
        if (current && !exiting.current) current.entered = true;
        else if (!current) leaveFullscreen();
      } else if (current?.entered) exit();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      intent.current = undefined;
      document.removeEventListener("fullscreenchange", changed);
      leaveFullscreen();
    };
  }, [exit, leaveFullscreen]);

  function enter() {
    if (!context) return;
    const root = document.documentElement;
    // A new intent during a pending exit stays in app focus mode.
    intent.current = { target: context, entered: false };
    setTarget(context);
    if (exiting.current || !root.requestFullscreen) return;
    try {
      void root
        .requestFullscreen()
        .then(() => {
          if (!intent.current) leaveFullscreen();
          else if (!exiting.current && document.fullscreenElement === root)
            intent.current.entered = true;
        })
        .catch(() => {});
    } catch {
      // App focus mode also works when fullscreen is unavailable.
    }
  }
  return { active: context !== undefined && target === context, enter, exit };
}
