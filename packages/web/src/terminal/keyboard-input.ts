import type { Terminal } from "@xterm/xterm";
import { isKeyboardOpen, prepareKeyboard, virtualKeyboard } from "../lib/viewport";

export function terminalKeyboard(terminal: Terminal, mobile: boolean) {
  const textarea = terminal.textarea!;
  const keyboard = mobile ? virtualKeyboard : undefined;
  const policySupported = "virtualKeyboardPolicy" in textarea;
  const restore = () => {
    // A native permission window can blur the document while keeping this editor active.
    if (mobile && policySupported && document.activeElement !== textarea)
      textarea.setAttribute("virtualkeyboardpolicy", "manual");
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
  return {
    activate() {
      if (terminal.options.disableStdin) return;
      prepareKeyboard();
      if (
        !keyboard &&
        mobile &&
        policySupported &&
        !isKeyboardOpen() &&
        document.activeElement === textarea
      )
        textarea.blur();
      if (policySupported) textarea.setAttribute("virtualkeyboardpolicy", "auto");
      terminal.focus();
      keyboard?.show();
    },
    dispose() {
      selection?.dispose();
      restore();
      textarea.removeEventListener("blur", restore);
    },
  };
}
