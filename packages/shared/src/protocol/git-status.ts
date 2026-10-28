import type { GitEntry } from "./index.js";

export function isUntracked(entry: GitEntry) {
  return entry.indexStatus === "?";
}

export function isStagedChange(entry: GitEntry) {
  return !entry.conflict && entry.indexStatus !== "." && !isUntracked(entry);
}

export function indexRenameSource(entry: GitEntry) {
  return entry.indexStatus === "R" && entry.oldPath ? entry.oldPath : undefined;
}
