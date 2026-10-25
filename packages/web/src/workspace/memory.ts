import type { GitBrowseState } from "../git/git";
import type { WorkspaceTarget } from "../lib/navigation";
import type { TerminalLayout } from "../terminal/groups";
import {
  readTerminalLayouts,
  terminalLayoutsKey,
  writeTerminalLayouts,
} from "../terminal/layout-storage";
import type { WorkPagesState } from "./pages";

export type ContentMode = "work" | "both" | "terminal";
export type TerminalPosition = "bottom" | "right" | "top" | "left";
export interface WorkspacePresentation {
  mode: ContentMode;
  mobileMode: "work" | "terminal";
  rightTool: "files" | "git";
  position: TerminalPosition;
  ratio: number;
  rightToolsOpen: boolean;
  rightToolsWidth?: number;
}

export interface WorkspaceRecord {
  presentation?: { state: WorkspacePresentation; path: string };
  pages?: WorkPagesState;
  terminalLayout?: TerminalLayout;
  browsing: Map<string, GitBrowseState>;
}

export function workspaceKey(target: WorkspaceTarget) {
  return `${target.deviceId}:${target.workspaceId}`;
}

export class WorkspaceMemories {
  private records = new Map<string, WorkspaceRecord>();

  constructor() {
    try {
      for (const [key, terminalLayout] of readTerminalLayouts(sessionStorage)) {
        this.records.set(key, { terminalLayout, browsing: new Map() });
      }
    } catch {
      // Unreadable saved layouts use the workspace defaults.
    }
  }

  get(target: WorkspaceTarget) {
    return this.records.get(workspaceKey(target));
  }

  forTarget(target: WorkspaceTarget) {
    const key = workspaceKey(target);
    let record = this.records.get(key);
    if (!record) {
      record = { browsing: new Map() };
      this.records.set(key, record);
    }
    return record;
  }

  saveTerminalLayout = (record: WorkspaceRecord, layout: TerminalLayout) => {
    record.terminalLayout = layout;
    try {
      const layouts: [string, TerminalLayout][] = [];
      for (const [key, record] of this.records) {
        if (record.terminalLayout !== undefined) layouts.push([key, record.terminalLayout]);
      }
      writeTerminalLayouts(sessionStorage, layouts);
    } catch {
      // The in-memory layout remains available.
    }
  };

  clear() {
    this.records.clear();
    try {
      sessionStorage.removeItem(terminalLayoutsKey);
    } catch {
      // Storage failure does not prevent signing out.
    }
  }
}
