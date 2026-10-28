import { useLayoutEffect, useState } from "react";
import { useGroupRef, type GroupProps, type PanelProps } from "react-resizable-panels";
import type { GitView } from "./view-header";

export interface RepoLayout {
  view: GitView;
  changesOpen: boolean;
  readingView: "history" | "branches";
  readingOpen: boolean;
  ratio?: number;
}

const defaultRatio = 60;
const titleHeight = 37;
const expandedMinHeight = 96;

export function createRepoLayout(): RepoLayout {
  return {
    view: "changes",
    changesOpen: true,
    readingView: "history",
    readingOpen: true,
  };
}

export function useRepoLayout(browsing: { layout: RepoLayout }, mobile: boolean) {
  const [layout, setLayout] = useState(browsing.layout);
  const split = useGroupRef();
  const ratio = layout.ratio ?? defaultRatio;
  const resizable = !mobile && layout.changesOpen && layout.readingOpen;
  useLayoutEffect(() => {
    if (resizable) split.current?.setLayout({ "git-changes": ratio, "git-reading": 100 - ratio });
  }, [resizable, ratio, split]);

  function update(next: RepoLayout) {
    browsing.layout = next;
    setLayout(next);
  }
  function selectView(view: GitView) {
    update({
      ...layout,
      view,
      ...(view === "changes" ? { changesOpen: true } : { readingView: view, readingOpen: true }),
    });
  }
  function panelSize(
    open: boolean,
    percent: number,
  ): Pick<PanelProps, "defaultSize" | "minSize" | "maxSize"> {
    let minSize: number;
    let maxSize: number | "100%";
    if (mobile) {
      minSize = 0;
      maxSize = "100%";
    } else if (open) {
      minSize = expandedMinHeight;
      maxSize = "100%";
    } else {
      minSize = titleHeight;
      maxSize = titleHeight;
    }
    return {
      defaultSize: `${percent}%`,
      minSize,
      maxSize,
    };
  }
  const onLayoutChanged: GroupProps["onLayoutChanged"] = (sizes, meta) => {
    if (meta.isUserInteraction && resizable) update({ ...layout, ratio: sizes["git-changes"] });
  };
  return {
    layout,
    split,
    resizable,
    collapsedHeight:
      !mobile && !layout.changesOpen && !layout.readingOpen ? titleHeight * 2 : undefined,
    changesPanel: panelSize(layout.changesOpen, ratio),
    readingPanel: panelSize(layout.readingOpen, 100 - ratio),
    changesVisible: mobile ? layout.view === "changes" : layout.changesOpen,
    historyVisible: mobile
      ? layout.view === "history"
      : layout.readingOpen && layout.readingView === "history",
    branchesVisible: mobile
      ? layout.view === "branches"
      : layout.readingOpen && layout.readingView === "branches",
    selectView,
    toggleChanges: () => update({ ...layout, view: "changes", changesOpen: !layout.changesOpen }),
    toggleReading: () => update({ ...layout, readingOpen: !layout.readingOpen }),
    onLayoutChanged,
  };
}
