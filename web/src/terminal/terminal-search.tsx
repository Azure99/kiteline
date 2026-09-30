import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { IconButton } from "../components/icon-button";
import { Input } from "../components/ui/input";
import { revealTerminalSelection } from "./readonly-viewport";

export function TerminalSearch({
  terminal,
  inputRef,
  onClose,
}: {
  terminal?: Terminal;
  inputRef: RefObject<HTMLInputElement | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<boolean>();
  const search = useRef<(text: string, previous?: boolean, incremental?: boolean) => void>(
    () => {},
  );
  useLayoutEffect(() => inputRef.current?.focus(), [inputRef]);
  useEffect(() => {
    setFound(undefined);
    if (!terminal) return;
    let addon = new SearchAddon();
    terminal.loadAddon(addon);
    let selecting = false;
    let ownsSelection = false;
    const selection = terminal.onSelectionChange(() => {
      if (!selecting) ownsSelection = false;
    });
    function clearSelection() {
      if (ownsSelection && terminal!.element?.isConnected) terminal!.clearSelection();
      ownsSelection = false;
    }
    search.current = (text, previous, incremental) => {
      if (!text) {
        clearSelection();
        setFound(undefined);
        return;
      }
      selecting = true;
      try {
        const result = previous ? addon.findPrevious(text) : addon.findNext(text, { incremental });
        ownsSelection = result;
        if (result) revealTerminalSelection(terminal);
        setFound(result);
      } finally {
        selecting = false;
      }
    };
    // The addon caches lines without distinguishing the active buffer.
    const buffer = terminal.buffer.onBufferChange(() => {
      clearSelection();
      addon.dispose();
      addon = new SearchAddon();
      terminal.loadAddon(addon);
      setFound(undefined);
    });
    return () => {
      search.current = () => {};
      selection.dispose();
      buffer.dispose();
      clearSelection();
      addon.dispose();
    };
  }, [terminal]);
  return (
    <div
      role="search"
      aria-label={t(($) => $.terminal.search)}
      className="absolute top-1 right-1 z-20 w-[calc(100%_-_8px)] max-w-sm rounded border border-border bg-background p-1 text-foreground shadow-md"
    >
      <div className="flex items-center">
        <Input
          ref={inputRef}
          value={query}
          disabled={!terminal}
          aria-label={t(($) => $.terminal.search)}
          placeholder={t(($) => $.common.search)}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            search.current(event.target.value, false, true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "Enter") {
              event.preventDefault();
              search.current(query, event.shiftKey);
            }
          }}
        />
        <IconButton
          label={t(($) => $.terminal.searchPrevious)}
          disabled={!terminal || !query}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => search.current(query, true)}
        >
          <ArrowUp />
        </IconButton>
        <IconButton
          label={t(($) => $.terminal.searchNext)}
          disabled={!terminal || !query}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => search.current(query)}
        >
          <ArrowDown />
        </IconButton>
        <IconButton
          label={t(($) => $.terminal.closeSearch)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          <X />
        </IconButton>
      </div>
      {found === false && (
        <p role="status" className="px-2 py-1 text-sm text-muted-foreground">
          {t(($) => $.terminal.searchEmpty)}
        </p>
      )}
    </div>
  );
}
