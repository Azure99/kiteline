import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

export function terminalFileTarget(value: string, root: string) {
  const match = /^(.*?)(?::([1-9]\d*)(?::([1-9]\d*))?)?$/.exec(value.trim());
  if (!match) return;
  let path = match[1]!;
  if (path.startsWith("file://")) {
    try {
      const uri = new URL(path);
      if (uri.host && uri.host !== "localhost") return;
      path = decodeURIComponent(uri.pathname);
    } catch {
      return;
    }
  }
  if (!path || !/[/.]/.test(path) || path.startsWith("~") || /[:\\\n\r\0]/.test(path)) return;
  if (path.startsWith("/")) {
    const prefix = root.replace(/\/$/, "") + "/";
    if (!path.startsWith(prefix)) return;
    path = path.slice(prefix.length);
  }
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.includes("..")) return;
  const line = match[2] ? Number(match[2]) : undefined;
  if (line !== undefined && !Number.isSafeInteger(line)) return;
  return { path: parts.join("/"), line };
}

export function terminalFileLinks(
  terminal: Terminal,
  root: string,
  open: (target: NonNullable<ReturnType<typeof terminalFileTarget>>) => void,
  hover: () => void,
  leave: () => void,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const buffer = terminal.buffer.active;
      let first = y - 1;
      let last = first;
      while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
      while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last++;
      let text = "";
      const cells: ILink["range"][] = [];
      for (let row = first; row <= last; row++) {
        const line = buffer.getLine(row)!;
        for (let col = 0; col < terminal.cols; col++) {
          const cell = line.getCell(col);
          if (!cell || cell.getWidth() === 0) continue;
          const value = cell.getChars() || " ";
          for (let i = 0; i < value.length; i++)
            cells.push({
              start: { x: col + 1, y: row + 1 },
              end: { x: col + cell.getWidth(), y: row + 1 },
            });
          text += value;
        }
      }
      const links: ILink[] = [];
      for (const match of text.matchAll(/\S+/g)) {
        if (!/^(?:file:\/\/)?\/?[A-Za-z.][\w./:-]+$/.test(match[0])) continue;
        const target = terminalFileTarget(match[0], root);
        if (!target) continue;
        const start = cells[match.index]!.start;
        const end = cells[match.index + match[0].length - 1]!.end;
        if (y < start.y || y > end.y) continue;
        links.push({
          range: { start, end },
          text: match[0],
          activate: (event) => {
            if ((event.ctrlKey || event.metaKey) && !terminal.hasSelection()) open(target);
          },
          hover,
          leave,
        });
      }
      callback(links);
    },
  };
}
