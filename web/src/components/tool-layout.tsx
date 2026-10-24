import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const Regions = createContext<{ header: HTMLDivElement | null; sidebar: HTMLDivElement | null }>({
  header: null,
  sidebar: null,
});

export function ToolLayout({
  header,
  sidebar,
  children,
}: {
  header: HTMLDivElement | null;
  sidebar: HTMLDivElement | null;
  children: ReactNode;
}) {
  return <Regions value={{ header, sidebar }}>{children}</Regions>;
}

export function ToolHeader({ visible, children }: { visible: boolean; children: ReactNode }) {
  const { header } = useContext(Regions);
  return header
    ? createPortal(<div className={visible ? "flex flex-col" : "hidden"}>{children}</div>, header)
    : null;
}

export function ToolSidebar({ visible, children }: { visible: boolean; children: ReactNode }) {
  const { sidebar } = useContext(Regions);
  return sidebar
    ? createPortal(
        <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>{children}</div>,
        sidebar,
      )
    : null;
}
