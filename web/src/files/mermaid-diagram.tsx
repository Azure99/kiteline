import { useEffect, useId, useState } from "react";
import mermaid from "mermaid";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
  layout: "dagre",
  flowchart: { useMaxWidth: false },
  sequence: { useMaxWidth: false },
  suppressErrorRendering: true,
});
export function MermaidDiagram({ text }: { text: string }) {
  const { t } = useTranslation();
  const id = "diagram-" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let current = true;
    mermaid.render(id, text).then(
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
  }, [id, text]);
  return (
    <>
      {svg && (
        <div
          className="overflow-x-auto rounded bg-white p-2 text-black"
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
