import {
  createElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type RefObject,
} from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { ErrorNotice } from "../components/error-notice";
import { i18n } from "../i18n";
import { readContent, type FileTarget } from "./content";
import { showFile } from "./navigation";
import { parentPath } from "./paths";
import { workspacePath } from "../lib/navigation";

function localPath(target: FileTarget, href: string) {
  if (!href || /^[a-z][a-z\d+.-]*:|^\/\//i.test(href) || href.startsWith("#")) return;
  const base = `https://workspace.invalid/${parentPath(target.path).split("/").map(encodeURIComponent).join("/")}/`;
  return decodeURIComponent(new URL(href, base).pathname.slice(1));
}
function FileLink({
  file: target,
  href = "",
  children,
  ...props
}: {
  file: FileTarget;
} & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { t } = useTranslation();
  if (href.startsWith("#"))
    return (
      <a {...props} href={`#kiteline-md-${href.slice(1)}`}>
        {children}
      </a>
    );
  let path: string | undefined;
  try {
    path = localPath(target, href);
  } catch {
    return (
      <span role="alert">
        {children} — {t(($) => $.files.invalidMarkdownLink, { href })}
      </span>
    );
  }
  return path === undefined ? (
    <a {...props} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <a
      {...props}
      href={workspacePath(target.deviceId, target.workspaceId, "files", {
        file: path,
        folder: parentPath(path),
      })}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        showFile({ ...target, path });
      }}
    >
      {children}
    </a>
  );
}
type Enqueue = (task: () => Promise<void>) => Promise<void>;
function LocalImage({
  target: { deviceId, workspaceId, path },
  alt,
  enqueue,
}: {
  target: FileTarget;
  alt?: string;
  enqueue: Enqueue;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void enqueue(async () => {
      if (controller.signal.aborted) return;
      const content = await readContent(
        { deviceId, workspaceId, path },
        controller.signal,
        () => {},
      );
      if (controller.signal.aborted) return;
      if (content.kind !== "image") throw new Error(i18n.t(($) => $.files.unsupportedPreviewImage));
      objectUrl = URL.createObjectURL(content.value.blob);
      setUrl(objectUrl);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [deviceId, workspaceId, path, enqueue]);
  return error ? (
    <span role="alert">
      <ErrorNotice error={error} />
    </span>
  ) : url ? (
    <img
      src={url}
      alt={alt}
      onError={() => setError(new Error(t(($) => $.files.imageDecodeFailed)))}
    />
  ) : (
    <span>{alt || path}…</span>
  );
}
function SourceBlock({ node, ...props }: HTMLAttributes<HTMLElement> & ExtraProps) {
  return createElement(node!.tagName, {
    ...props,
    "data-source-line": node!.position?.start.line,
  });
}
export function MarkdownPreview({
  target: { deviceId, workspaceId, path },
  text,
  containerRef,
  position,
}: {
  target: FileTarget;
  text: string;
  containerRef: RefObject<HTMLElement | null>;
  position?: { line: number; offset: number };
}) {
  const { t } = useTranslation();
  useLayoutEffect(() => {
    const article = containerRef.current!;
    const block = position && article.querySelector(`[data-source-line="${position.line}"]`);
    if (block) {
      article.scrollTop +=
        block.getBoundingClientRect().top - article.getBoundingClientRect().top - position.offset;
    }
  }, [containerRef, position]);
  const components = useMemo<Components>(() => {
    const target = { deviceId, workspaceId, path };
    let pending = Promise.resolve();
    const enqueue: Enqueue = (task) => {
      const next = pending.then(task);
      pending = next.catch(() => {});
      return next;
    };
    return {
      p: SourceBlock,
      h1: SourceBlock,
      h2: SourceBlock,
      h3: SourceBlock,
      h4: SourceBlock,
      h5: SourceBlock,
      h6: SourceBlock,
      li: SourceBlock,
      tr: SourceBlock,
      pre: SourceBlock,
      a: ({ node, ...props }) =>
        "dataFootnoteRef" in node!.properties || "dataFootnoteBackref" in node!.properties ? (
          <a {...props} />
        ) : (
          <FileLink file={target} {...props} />
        ),
      img: ({ src, alt }) => {
        const href = typeof src === "string" ? src : "";
        let path: string | undefined;
        try {
          path = localPath(target, href);
        } catch {
          return (
            <span role="alert">
              {alt} — {t(($) => $.files.invalidMarkdownImage, { href })}
            </span>
          );
        }
        return path === undefined ? (
          <FileLink file={target} href={href}>
            {alt || href} ↗
          </FileLink>
        ) : (
          <LocalImage key={path} target={{ ...target, path }} alt={alt} enqueue={enqueue} />
        );
      },
    };
  }, [deviceId, workspaceId, path, t]);
  return (
    <article
      ref={containerRef}
      className="markdown-preview scroll-area min-h-0 flex-1 overflow-auto p-5"
      aria-label={t(($) => $.files.markdownPreview)}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{
          footnoteLabel: t(($) => $.files.footnotes),
          footnoteBackLabel: t(($) => $.files.backToReference),
        }}
        rehypePlugins={[[rehypeSlug, { prefix: "kiteline-md-" }]]}
        components={components}
      >
        {text}
      </Markdown>
    </article>
  );
}
