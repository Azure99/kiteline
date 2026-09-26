import { Component, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { ErrorNotice } from "./error-notice";
import { ReleaseNotice } from "./release-notice";

function Loading() {
  const { t } = useTranslation();
  return (
    <div role="status" className="p-4 text-sm text-muted-foreground">
      {t(($) => $.common.loading)}
    </div>
  );
}
function Failure({ error }: { error: unknown }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <ReleaseNotice />
      <ErrorNotice error={error} />
      <p className="text-sm text-muted-foreground">{t(($) => $.release.reloadDrafts)}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => location.reload()}>
          <RefreshCw />
          {t(($) => $.release.reload)}
        </Button>
      </div>
    </div>
  );
}
export class ViewBoundary extends Component<
  { children: ReactNode; active: boolean },
  { failed: boolean; error?: unknown }
> {
  state = { failed: false, error: undefined as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }
  render() {
    return this.state.failed
      ? this.props.active && <Failure error={this.state.error} />
      : this.props.children;
  }
}
export function deferredView<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  options: { active?: (props: P) => boolean; isolateRenderErrors?: boolean } = {},
) {
  return function DeferredView(props: P) {
    const visible = options.active?.(props) ?? true;
    const [opened, setOpened] = useState(visible);
    const [result, setResult] = useState<
      | { kind: "loading" }
      | { kind: "ready"; View: ComponentType<P> }
      | { kind: "failed"; error: unknown }
    >({ kind: "loading" });
    useEffect(() => {
      if (visible) setOpened(true);
    }, [visible]);
    useEffect(() => {
      if (!opened) return;
      let current = true;
      void load().then(
        ({ default: View }) => {
          if (current) setResult({ kind: "ready", View });
        },
        (error: unknown) => {
          if (current) setResult({ kind: "failed", error });
        },
      );
      return () => {
        current = false;
      };
    }, [opened]);
    if (!opened) return null;
    const content =
      result.kind === "ready" ? (
        <result.View {...props} />
      ) : visible ? (
        result.kind === "failed" ? (
          <Failure error={result.error} />
        ) : (
          <Loading />
        )
      ) : null;
    return options.isolateRenderErrors === false ? (
      content
    ) : (
      <ViewBoundary active={visible}>{content}</ViewBoundary>
    );
  };
}
