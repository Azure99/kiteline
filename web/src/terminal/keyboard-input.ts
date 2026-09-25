import type { Terminal } from "@xterm/xterm";
import { isKeyboardOpen, prepareKeyboard, virtualKeyboard } from "../lib/viewport";

export function terminalKeyboard(terminal: Terminal, mobile: boolean) {
  const textarea = terminal.textarea!;
  const keyboard = mobile ? virtualKeyboard : undefined;
  const managed = mobile && "virtualKeyboardPolicy" in textarea;
  let pending = false;
  let focusing = false;
  let frame = 0;
  const restore = () => {
    cancelAnimationFrame(frame);
    pending = false;
    if (managed) textarea.setAttribute("virtualkeyboardpolicy", "manual");
  };
  const viewport = () => {
    if (pending && !focusing && isKeyboardOpen()) restore();
  };
  if ("virtualKeyboardPolicy" in textarea)
    textarea.setAttribute("virtualkeyboardpolicy", mobile ? "manual" : "auto");
  textarea.addEventListener("blur", restore);
  window.addEventListener("kiteline:viewport", viewport);
  return {
    activate() {
      if (terminal.options.disableStdin) return;
      prepareKeyboard();
      if (!keyboard && managed && !isKeyboardOpen() && document.activeElement === textarea)
        textarea.blur();
      if (managed && document.activeElement !== textarea) {
        pending = true;
        focusing = true;
        textarea.setAttribute("virtualkeyboardpolicy", "auto");
        terminal.focus();
        focusing = false;
        // A keyboard already open for another editor need not resize again.
        if (isKeyboardOpen()) frame = requestAnimationFrame(restore);
      } else {
        restore();
        terminal.focus();
      }
      keyboard?.show();
    },
    dispose() {
      restore();
      textarea.removeEventListener("blur", restore);
      window.removeEventListener("kiteline:viewport", viewport);
    },
  };
}
