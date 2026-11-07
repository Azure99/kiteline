import type { Draft } from "./drafts";
import type { SearchMatch, SearchResult } from "@kiteline/shared/protocol";
import {
  classifyNavigationMatches,
  compareNavigationMatches,
  type NameOccurrence,
  type NavigationContext,
  type NavigationMatchReason,
} from "./navigation-candidates";

export interface CodeNavigationRequest {
  initialGroup: "definitions" | "occurrences";
  context: NavigationContext;
  origin: {
    path: string;
    draftId: string;
    line: number;
    column: number;
    endColumn?: number;
    scrollSnapshot?: Draft["view"]["scrollSnapshot"];
  };
}

export interface NavigationSearchEntry {
  key: string;
  match: SearchMatch;
  reason?: NavigationMatchReason;
  source: "draft" | "disk";
  draftId?: string;
  group?: CodeNavigationRequest["initialGroup"];
  isOrigin?: boolean;
}

export interface NavigationPositions {
  local(occurrence: NameOccurrence): NameOccurrence | undefined;
  disk(
    match: SearchMatch,
  ):
    | { status: "mapped"; occurrence: NameOccurrence; draftId: string }
    | { status: "unmapped" | "missing" };
}

export function navigationSearchEntries(
  result: SearchResult | undefined,
  navigation?: { request: CodeNavigationRequest; positions: NavigationPositions },
): NavigationSearchEntry[] {
  const matches = result?.matches ?? [];
  const diskKey = (match: SearchMatch) =>
    JSON.stringify([match.path, "disk", match.line, match.ranges?.[0] ?? match.byteColumn]);
  if (!navigation) return matches.map((match) => ({ key: diskKey(match), match, source: "disk" }));
  const { request, positions } = navigation;
  const { context, origin } = request;
  const { path, draftId } = origin;
  const queryRange = positions.local(context.queryRange);
  const nonMemberProperties = new Set<number>();
  for (const property of context.nonMemberProperties) {
    const mapped = positions.local(property);
    if (mapped) nonMemberProperties.add(mapped.from);
  }
  const occurrenceMatch = (occurrence: NavigationContext["queryRange"]): SearchMatch => ({
    path,
    line: occurrence.line,
    text: occurrence.lineText,
    ranges: [[occurrence.column, occurrence.endColumn]],
  });
  const localKey = (occurrence: NameOccurrence) =>
    JSON.stringify([path, "draft", occurrence.from, occurrence.to]);
  const candidates: (NavigationSearchEntry & { reason: NavigationMatchReason })[] = [];
  for (const definition of context.definitions) {
    const mapped = positions.local(definition);
    if (!mapped) continue;
    candidates.push({
      key: localKey(definition),
      match: occurrenceMatch(mapped),
      reason: "syntax-definition",
      source: "draft",
      draftId,
    });
  }
  const originMatch = queryRange && occurrenceMatch(queryRange);
  const matchesToClassify: SearchMatch[] = [];
  if (originMatch) matchesToClassify.push(originMatch);
  for (const match of matches) {
    if (match.ranges?.length) {
      for (const range of match.ranges) matchesToClassify.push({ ...match, ranges: [range] });
    } else matchesToClassify.push(match);
  }
  // Classify the original disk snippet before replacing it with current draft coordinates.
  const classified = classifyNavigationMatches(matchesToClassify, {
    query: context.query,
    originPath: path,
  });
  for (const { match, reason } of classified) {
    if (match === originMatch) {
      candidates.push({
        key: localKey(context.queryRange),
        match,
        reason,
        source: "draft",
        draftId,
      });
    } else {
      candidates.push({ key: diskKey(match), match, reason, source: "disk" });
    }
  }
  // Keep current draft coordinates when an unchanged disk range names the same occurrence.
  candidates.sort(
    (a, b) =>
      Number(b.source === "draft") - Number(a.source === "draft") ||
      compareNavigationMatches(a, b, path),
  );
  const unique = new Map<string, NavigationSearchEntry & { reason: NavigationMatchReason }>();
  for (const entry of candidates) {
    const { match } = entry;
    const mapped = entry.source === "disk" ? positions.disk(match) : undefined;
    if (mapped?.status === "missing") continue;
    let position: { line: number; column: number } | undefined;
    let propertyFrom: number | undefined;
    if (entry.source === "draft") {
      position = { line: match.line!, column: match.ranges![0]![0] };
      if (match === originMatch) propertyFrom = queryRange!.from;
    } else if (mapped?.status === "mapped") {
      position = mapped.occurrence;
      propertyFrom = mapped.occurrence.from;
    }
    let key: string;
    if (position)
      key = JSON.stringify([
        match.path,
        "draft",
        position.line,
        position.column,
        context.query.length,
      ]);
    else key = diskKey(match);
    const isOrigin =
      match.path === path &&
      queryRange !== undefined &&
      position?.line === queryRange.line &&
      position.column === queryRange.column;
    let reason = entry.reason;
    if (
      reason === "possible-definition" &&
      match.path === path &&
      propertyFrom !== undefined &&
      nonMemberProperties.has(propertyFrom)
    )
      reason = "current-file";
    const existing = unique.get(key);
    if (existing) {
      existing.isOrigin ||= isOrigin;
      if (reason === "possible-definition" && existing.reason !== "syntax-definition") {
        existing.reason = reason;
        existing.group = "definitions";
      }
      continue;
    }
    const displayed: NavigationSearchEntry & { reason: NavigationMatchReason } = {
      ...entry,
      reason,
      group:
        reason === "syntax-definition" || reason === "possible-definition"
          ? "definitions"
          : "occurrences",
      isOrigin,
    };
    if (mapped?.status === "mapped") {
      displayed.match = {
        ...match,
        line: mapped.occurrence.line,
        text: mapped.occurrence.lineText,
        ranges: [[mapped.occurrence.column, mapped.occurrence.endColumn]],
      };
      displayed.source = "draft";
      displayed.draftId = mapped.draftId;
    }
    unique.set(key, displayed);
  }
  return [...unique.values()].sort((a, b) => compareNavigationMatches(a, b, path));
}
