export async function copyText(text: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === "function")
    return navigator.clipboard.writeText(text);

  const active = document.activeElement;
  const selection = window.getSelection();
  const range =
    selection?.anchorNode && selection.focusNode
      ? {
          anchor: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focus: selection.focusNode,
          focusOffset: selection.focusOffset,
        }
      : undefined;
  const inputRange =
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    active.selectionStart !== null
      ? {
          start: active.selectionStart,
          end: active.selectionEnd!,
          direction: active.selectionDirection!,
        }
      : undefined;
  const temporary = document.createElement("textarea");
  temporary.value = text;
  temporary.readOnly = true;
  temporary.style.cssText = "position:fixed;left:-10000px;top:0;font-size:16px";
  document.body.append(temporary);
  try {
    temporary.select();
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    temporary.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    // A Range alone loses the direction of a backwards editor selection.
    if (range)
      selection!.setBaseAndExtent(range.anchor, range.anchorOffset, range.focus, range.focusOffset);
    else selection?.removeAllRanges();
    if (inputRange)
      (active as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(
        inputRange.start,
        inputRange.end,
        inputRange.direction,
      );
  }
}
