import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import type { SearchMatch } from "@kiteline/shared/protocol";

export interface NameOccurrence {
  from: number;
  to: number;
  line: number;
  column: number;
  endColumn: number;
  lineText: string;
}

export interface NavigationContext {
  query: string;
  definitions: NameOccurrence[];
  nonMemberProperties: NameOccurrence[];
  queryRange: NameOccurrence;
}

const definitionsHighlighter = tagHighlighter([
  { tag: tags.definition(tags.name), class: "definition" },
  { tag: tags.definition(tags.propertyName), class: "property-definition" },
]);

export function inspectNavigation(state: EditorState, query: string): NavigationContext {
  const selection = state.selection.main;
  const range = selection.empty ? state.wordAt(selection.head) : selection;
  const from = range?.from ?? selection.head;
  const before = state.sliceDoc(0, from);
  const isMemberAccess = /(?:\?\.|\.|->|::)\s*$/.test(before);
  const tree = ensureSyntaxTree(state, state.doc.length, 200);
  const definitions: NameOccurrence[] = [];
  const nonMemberProperties: NameOccurrence[] = [];
  if (tree) {
    highlightTree(tree, definitionsHighlighter, (start, end, classes) => {
      if (state.sliceDoc(start, end) !== query) return;
      for (let node = tree.resolveInner(start, 1); node; node = node.parent!) {
        if (/^Import|^UseDeclaration$/.test(node.name)) return;
      }
      const line = state.doc.lineAt(start);
      const destination =
        !isMemberAccess && classes.split(" ").includes("property-definition")
          ? nonMemberProperties
          : definitions;
      destination.push({
        from: start,
        to: end,
        line: line.number,
        column: start - line.from,
        endColumn: end - line.from,
        lineText: line.text,
      });
    });
  }
  const originLine = state.doc.lineAt(from);
  return {
    query,
    definitions,
    nonMemberProperties,
    queryRange: {
      from,
      to: range?.to ?? from,
      line: originLine.number,
      column: from - originLine.from,
      endColumn: (range?.to ?? from) - originLine.from,
      lineText: originLine.text,
    },
  };
}

export type NavigationMatchReason =
  | "syntax-definition"
  | "possible-definition"
  | "current-file"
  | "name-match";

export interface RankedNavigationMatch {
  match: SearchMatch;
  reason: NavigationMatchReason;
}

function lineDefinitionRange(query: string) {
  const name = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // These existing line rules miss destructuring and can classify assignments as declarations.
  // Only the captured name is a candidate, never the other occurrences on the same line.
  const declaration = new RegExp(
    `^(\\s*(?:(?:export|default|async|public|private|protected|static|abstract|final)\\s+)*` +
      `(?:const|let|var|function|class|interface|type|enum|struct|trait|fn|def)\\s+)${name}` +
      `(?![\\p{L}\\p{N}_$])`,
    "u",
  );
  const assignment = new RegExp(`^(\\s*)${name}\\s*(?::[^=]+)?=(?!=|>)`, "u");
  return (text: string): [number, number] | undefined => {
    const match = declaration.exec(text) ?? assignment.exec(text);
    if (!match) return;
    const from = match[1]!.length;
    return [from, from + query.length];
  };
}

export function classifyNavigationMatches(
  matches: SearchMatch[],
  {
    query,
    originPath,
  }: {
    query: string;
    originPath: string;
  },
): RankedNavigationMatch[] {
  const possibleDefinition = lineDefinitionRange(query);
  return matches.map((match): RankedNavigationMatch => {
    const definition = possibleDefinition(match.text ?? "");
    const range = match.ranges?.[0];
    let reason: NavigationMatchReason;
    if (definition && range && definition[0] === range[0] && definition[1] === range[1])
      reason = "possible-definition";
    else if (match.path === originPath) reason = "current-file";
    else reason = "name-match";
    return { match, reason };
  });
}

export function compareNavigationMatches(
  a: RankedNavigationMatch,
  b: RankedNavigationMatch,
  originPath: string,
) {
  const originDirectory = originPath.split("/").slice(0, -1);
  function proximity(path: string) {
    const directory = path.split("/").slice(0, -1);
    let shared = 0;
    while (
      shared < directory.length &&
      shared < originDirectory.length &&
      directory[shared] === originDirectory[shared]
    )
      shared++;
    return {
      sameDirectory: shared === directory.length && shared === originDirectory.length,
      shared,
    };
  }
  function compareNearby(firstPath: string, secondPath: string) {
    const first = proximity(firstPath);
    const second = proximity(secondPath);
    return (
      Number(second.sameDirectory) - Number(first.sameDirectory) || second.shared - first.shared
    );
  }
  const priority = (reason: NavigationMatchReason) =>
    reason === "syntax-definition" ? 0 : reason === "possible-definition" ? 1 : 2;
  const evidence = priority(a.reason) - priority(b.reason);
  if (evidence) return evidence;
  const originFile = Number(b.match.path === originPath) - Number(a.match.path === originPath);
  const location =
    (a.match.path < b.match.path ? -1 : a.match.path > b.match.path ? 1 : 0) ||
    (a.match.line ?? 0) - (b.match.line ?? 0) ||
    (a.match.ranges?.[0]?.[0] ?? a.match.byteColumn ?? 0) -
      (b.match.ranges?.[0]?.[0] ?? b.match.byteColumn ?? 0);
  if (priority(a.reason) === 2)
    return originFile || compareNearby(a.match.path, b.match.path) || location;
  return compareNearby(a.match.path, b.match.path) || originFile || location;
}
