import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { IconButton } from "../components/icon-button";
import { Input } from "../components/ui/input";
import { revealTerminalSelection } from "./clipped-screen";

export function TerminalSearch({
  terminal,
  targetName,
  active,
  inputRef,
  onClose,
}: {
  terminal?: Terminal;
  targetName: string;
  active: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<boolean>();
  const search = useRef<
    (text: string, options?: { previous?: boolean; incremental?: boolean }) => void
  >(() => {});
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
    search.current = (text, { previous, incremental } = {}) => {
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
    const resize = terminal.onResize(() => setFound(undefined));
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
      resize.dispose();
      buffer.dispose();
      clearSelection();
      addon.dispose();
    };
  }, [terminal]);
  return (
    <div
      role="search"
      aria-label={`${t(($) => $.terminal.search)} · ${targetName}`}
      hidden={!active}
      className="flex min-h-10 flex-wrap items-center gap-x-1 border-b border-border bg-background px-2 py-0.5 text-foreground"
    >
      <span className="w-full truncate text-xs leading-5 text-muted-foreground" title={targetName}>
        {targetName}
      </span>
      <Input
        className="h-8 min-h-8 w-0 flex-1 basis-32 py-1 max-desk:h-9 max-desk:min-h-9"
        ref={inputRef}
        value={query}
        disabled={!terminal}
        aria-label={`${t(($) => $.terminal.search)} · ${targetName}`}
        placeholder={t(($) => $.common.search)}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          search.current(event.target.value, { incremental: true });
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            search.current(query, { previous: event.shiftKey });
          }
        }}
      />
      <div className="ml-auto flex shrink-0 items-center">
        <span role="status" className="w-16 shrink-0 px-1 text-xs text-muted-foreground">
          {found === false ? t(($) => $.terminal.searchEmpty) : ""}
        </span>
        <IconButton
          label={t(($) => $.terminal.searchPrevious)}
          disabled={!terminal || !query}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => search.current(query, { previous: true })}
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
    </div>
  );
}
