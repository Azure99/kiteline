import { useEffect, useState } from "react";
import mermaid from "mermaid";
import { useTranslation } from "react-i18next";
import { newId } from "../lib/id";
import { useTheme } from "../lib/appearance";
import { ErrorNotice } from "../components/error-notice";

export function MermaidDiagram({ text }: { text: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let current = true;
    setError(undefined);
    const css = getComputedStyle(document.documentElement);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const textColor = color("--color-foreground");
    const lineColor = color("--color-muted-foreground");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        darkMode: theme === "dark",
        background: color("--color-background"),
        primaryColor: color("--color-primary-soft"),
        primaryTextColor: textColor,
        primaryBorderColor: lineColor,
        secondaryColor: color("--color-muted"),
        secondaryTextColor: textColor,
        secondaryBorderColor: lineColor,
        tertiaryColor: color("--color-muted"),
        tertiaryTextColor: textColor,
        tertiaryBorderColor: lineColor,
        lineColor,
        textColor,
        noteBkgColor: color("--color-warning-soft"),
        noteTextColor: textColor,
        noteBorderColor: lineColor,
        edgeLabelBackground: color("--color-background"),
      },
      layout: "dagre",
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      suppressErrorRendering: true,
    });
    mermaid.render(`diagram-${newId()}`, text).then(
      (result) => {
        if (current) setSvg(result.svg);
      },
      (reason: unknown) => {
        if (current) setError(reason);
      },
    );
    return () => {
      current = false;
    };
  }, [text, theme]);
  return (
    <>
      {svg && (
        <div
          className="overflow-x-auto rounded bg-background p-2 text-foreground"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {!!error && (
        <div role="alert">
          <ErrorNotice error={error} />
        </div>
      )}
      <details open={!!error || !svg}>
        <summary>{t(($) => $.files.mermaidSource)}</summary>
        <pre>
          <code>{text}</code>
        </pre>
      </details>
    </>
  );
}
