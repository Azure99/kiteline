interface KeyboardGeometry extends EventTarget {
  readonly boundingRect: DOMRectReadOnly;
  show(): void;
}

export const virtualKeyboard = (navigator as Navigator & { virtualKeyboard?: KeyboardGeometry })
  .virtualKeyboard;

let keyboardOpen = false;
let keyboardRequested = false;
export const isKeyboardOpen = () => keyboardOpen;
export const prepareKeyboard = () => {
  keyboardRequested = true;
};

// App owns these listeners; terminal displays read the same keyboard-height decision.
export function trackViewport() {
  const dynamicViewport = CSS.supports("height", "100dvh");
  const viewport = window.visualViewport;
  const keyboard = virtualKeyboard;
  let width = viewport?.width ?? window.innerWidth;
  let scale = viewport?.scale ?? 1;
  let fullscreen = !!document.fullscreenElement;
  let fullHeight = viewport?.height ?? window.innerHeight;
  const fullHeights = new Map([[fullscreen, fullHeight]]);
  const resize = () => {
    const nextWidth = viewport?.width ?? window.innerWidth;
    const nextScale = viewport?.scale ?? 1;
    const top = viewport?.offsetTop ?? 0;
    let height = viewport?.height ?? window.innerHeight;
    const rect = keyboard?.boundingRect;
    const occluded =
      !!rect && rect.height > 0 && rect.width > 0 && rect.bottom > top && rect.top < top + height;
    if (occluded) height = Math.max(0, Math.min(top + height, rect.top) - top);
    const focused = document.activeElement;
    const editing =
      focused instanceof HTMLTextAreaElement ||
      focused instanceof HTMLInputElement ||
      (focused instanceof HTMLElement && focused.isContentEditable);
    const nextFullscreen = !!document.fullscreenElement;
    const changedAxis = Math.abs(width - nextWidth) > 1 || scale !== nextScale;
    if (changedAxis) {
      fullHeights.clear();
      fullHeight = height;
    } else if (fullscreen !== nextFullscreen) {
      fullHeight = fullHeights.get(nextFullscreen) ?? fullHeight;
    }
    const mobile = window.matchMedia("(max-width: 959px)").matches;
    keyboardOpen =
      mobile &&
      (occluded ||
        (!changedAxis &&
          (keyboardOpen || editing) &&
          fullHeight - height > (keyboardOpen || keyboardRequested ? 1 : 100)));
    if (changedAxis || (!editing && !keyboardOpen)) keyboardRequested = false;
    // The address bar can retract before the fullscreen event reaches the page.
    if (
      !keyboardOpen &&
      !editing &&
      (nextFullscreen || !document.querySelector("[data-terminal-focus]"))
    ) {
      fullHeight = height;
      fullHeights.set(nextFullscreen, height);
    } else {
      fullHeight = fullHeights.get(nextFullscreen) ?? Math.max(fullHeight, height);
    }
    width = nextWidth;
    scale = nextScale;
    fullscreen = nextFullscreen;
    document.documentElement.style.setProperty(
      "--app-height",
      dynamicViewport && nextScale === 1 && top === 0 && !occluded ? "100dvh" : `${height}px`,
    );
    document.documentElement.style.setProperty("--app-top", `${top}px`);
    window.dispatchEvent(new Event("kiteline:viewport"));
  };
  resize();
  viewport?.addEventListener("resize", resize);
  viewport?.addEventListener("scroll", resize);
  keyboard?.addEventListener("geometrychange", resize);
  window.addEventListener("resize", resize);
  document.addEventListener("focusin", resize);
  document.addEventListener("fullscreenchange", resize);
  return () => {
    viewport?.removeEventListener("resize", resize);
    viewport?.removeEventListener("scroll", resize);
    keyboard?.removeEventListener("geometrychange", resize);
    window.removeEventListener("resize", resize);
    document.removeEventListener("focusin", resize);
    document.removeEventListener("fullscreenchange", resize);
    keyboardOpen = false;
    keyboardRequested = false;
  };
}
