import type { Terminal } from "@xterm/xterm";
import { isKeyboardOpen, prepareKeyboard, virtualKeyboard } from "../lib/viewport";

export function terminalKeyboard(terminal: Terminal, mobile: boolean) {
  const textarea = terminal.textarea!;
  const keyboard = mobile ? virtualKeyboard : undefined;
  const policySupported = "virtualKeyboardPolicy" in textarea;
  const managed = mobile && policySupported;
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
  const selection =
    !mobile && policySupported
      ? terminal.onSelectionChange(() => {
          if (terminal.hasSelection()) textarea.setAttribute("virtualkeyboardpolicy", "manual");
        })
      : undefined;
  if (policySupported)
    textarea.setAttribute(
      "virtualkeyboardpolicy",
      mobile || terminal.hasSelection() ? "manual" : "auto",
    );
  textarea.addEventListener("blur", restore);
  window.addEventListener("kiteline:viewport", viewport);
  return {
    activate() {
      if (terminal.options.disableStdin) return;
      if (!mobile && policySupported) textarea.setAttribute("virtualkeyboardpolicy", "auto");
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
      selection?.dispose();
      restore();
      textarea.removeEventListener("blur", restore);
      window.removeEventListener("kiteline:viewport", viewport);
    },
  };
}
