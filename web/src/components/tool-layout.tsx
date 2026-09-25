import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMobile } from "../lib/use-mobile";

const Regions = createContext<{ header: HTMLDivElement | null; sidebar: HTMLDivElement | null }>({
  header: null,
  sidebar: null,
});

export function ToolLayout({ children }: { children: ReactNode }) {
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const [sidebar, setSidebar] = useState<HTMLDivElement | null>(null);
  return (
    <Regions value={{ header, sidebar }}>
      <div ref={setHeader} className="flex shrink-0 flex-col" />
      <div className="flex min-h-0 flex-1">
        <div ref={setSidebar} className="flex min-h-0 shrink-0" />
        {children}
      </div>
    </Regions>
  );
}

export function ToolHeader({
  visible,
  order = 0,
  children,
}: {
  visible: boolean;
  order?: number;
  children: ReactNode;
}) {
  const { header } = useContext(Regions);
  return header
    ? createPortal(
        <div className={visible ? "flex flex-col" : "hidden"} style={{ order }}>
          {children}
        </div>,
        header,
      )
    : null;
}

export function ToolSidebar({ visible, children }: { visible: boolean; children: ReactNode }) {
  const { sidebar } = useContext(Regions);
  const mobile = useMobile();
  if (mobile) return <div className={visible ? "contents" : "hidden"}>{children}</div>;
  return sidebar
    ? createPortal(<div className={visible ? "flex min-h-0" : "hidden"}>{children}</div>, sidebar)
    : null;
}
