import postcss, { type AtRule, type Plugin, type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import cascadeLayers from "@csstools/postcss-cascade-layers";

const editorScope = ":where(.cm-editor, .cm-editor *)";
const outsideEditor = ":not(:where(.cm-editor, .cm-editor *))";
const appResetLayer = "kiteline-editor-reset";

function scopeReset(selectorText: string, scope: "outside" | "base" | "app") {
  return selectorParser((root) => {
    root.each((selector) => {
      // Scope the originating element, before any pseudo-element and its states.
      const pseudoElement = selector.nodes.find(
        (node) =>
          node.type === "pseudo" &&
          (node.value.startsWith("::") ||
            [":before", ":after", ":first-line", ":first-letter"].includes(node.value)),
      );
      const tail = pseudoElement ? selector.nodes.slice(selector.nodes.indexOf(pseudoElement)) : [];
      for (const node of tail) node.remove();
      const element = selector.toString() || "*";
      const head = scope === "base" ? `:where(${element})` : element;
      const suffix = scope === "outside" ? outsideEditor : editorScope;
      const scoped = selectorParser().astSync(head + suffix).first!;
      selector.removeAll();
      for (const node of scoped.nodes) selector.append(node.clone());
      for (const node of tail) selector.append(node);
    });
  }).processSync(selectorText);
}

function extractEditorReset(layer: AtRule, scope: "base" | "app") {
  const editorCopy = layer.clone();
  editorCopy.walkDecls((declaration) => {
    if (declaration.important) declaration.remove();
  });
  editorCopy.walkRules((rule) => {
    if (!rule.nodes.length) rule.remove();
    else rule.selector = scopeReset(rule.selector, scope);
  });

  // Important declarations keep their original scope and reversed layer priority.
  const rules: Rule[] = [];
  layer.walkRules((rule) => {
    rules.push(rule);
  });
  for (const rule of rules) {
    const important = rule.nodes.filter((node) => node.type === "decl" && node.important);
    if (important.length) {
      rule.before(rule.clone({ nodes: important.map((node) => node.clone()) }));
      for (const node of important) node.remove();
    }
    if (!rule.nodes.length) rule.remove();
    else rule.selector = scopeReset(rule.selector, "outside");
  }
  return editorCopy;
}

export function editorResetCompat(): Plugin {
  return {
    postcssPlugin: "kiteline-editor-reset-compat",
    async Once(root, { result }) {
      const baseCopies = postcss.root();
      const appCopies = postcss.root();
      const resetLayers: AtRule[] = [];
      root.walkAtRules("layer", (layer) => {
        if (layer.nodes && ["base", appResetLayer].includes(layer.params)) resetLayers.push(layer);
      });
      for (const layer of resetLayers) {
        const isBase = layer.params === "base";
        const copy = extractEditorReset(layer, isBase ? "base" : "app");
        (isBase ? baseCopies : appCopies).append(copy.nodes!);
        if (!isBase) layer.replaceWith(...layer.nodes!);
      }
      const converted = await postcss([cascadeLayers()]).process(root, {
        from: result.opts.from,
        to: result.opts.to,
        map: false,
      });
      result.messages.push(...converted.messages);
      // CodeMirror injects unlayered styles at runtime; these resets must stay below them.
      root.append(baseCopies.nodes);
      root.append(appCopies.nodes);
    },
  };
}
