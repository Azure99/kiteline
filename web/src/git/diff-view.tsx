import { Fragment, useEffect, useMemo, useState } from "react";
import { Decoration, Diff, Hunk, parseDiff, type FileData, type HunkTokens } from "react-diff-view";
import "react-diff-view/style/index.css";
import { ArrowLeft, FilePenLine, RefreshCw } from "lucide-react";
import { limits, type GitDiff } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { errorMessage, rpc } from "../lib/api";

export interface DiffTarget {
  path: string;
  oldPath?: string;
  side: "worktree" | "staged" | "commit";
  commitOid?: string;
  parentOid?: string;
}
export function DiffView({
  deviceId,
  workspaceId,
  repoId,
  target,
  refreshKey,
  onBack,
  onFile,
}: {
  deviceId: string;
  workspaceId: string;
  repoId: string;
  target: DiffTarget;
  refreshKey?: unknown;
  onBack: () => void;
  onFile: () => void;
}) {
  const [value, setValue] = useState<GitDiff>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setValue(undefined);
    void rpc<GitDiff>(deviceId, "git.diff", { workspaceId, repoId, ...target }, controller.signal)
      .then(
        (result) => {
          if (!controller.signal.aborted) setValue(result);
        },
        (error) => {
          if (!controller.signal.aborted) setError(errorMessage(error));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [deviceId, workspaceId, repoId, target, refreshKey, retry]);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Git diff">
      <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <IconButton label="返回变化" onClick={onBack}>
          <ArrowLeft />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-xs" title={target.path}>
          {target.path}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {target.side === "staged" ? "暂存区" : target.side === "commit" ? "提交" : "工作树"}
        </span>
        <IconButton label="在 Files 打开" onClick={onFile}>
          <FilePenLine />
        </IconButton>
        <IconButton label="刷新 diff" disabled={busy} onClick={() => setRetry((n) => n + 1)}>
          <RefreshCw />
        </IconButton>
      </div>
      <div className="scroll-area min-h-0 min-w-0 flex-1 overflow-auto">
        {error && (
          <p role="alert" className="break-words p-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {busy && (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            正在读取
          </p>
        )}
        {value && <Patch value={value} />}
      </div>
    </section>
  );
}
export function Patch({ value }: { value: GitDiff }) {
  const parsed = useMemo(() => {
    if (value.truncated) return { reason: "Diff 读取已截断" };
    if (value.patch.split("\n").length > limits.diffRenderLines)
      return { reason: "Diff 超过显示行数" };
    try {
      const files = parseDiff(value.patch);
      if (!files.length && value.patch.trim()) return { reason: "Diff 无法结构化显示" };
      if (
        !files.some((file) => file.hunks.length) &&
        value.patch
          .split("\n")
          .some(
            (line) =>
              line &&
              !/^(diff --git |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |index |Binary files )/.test(
                line,
              ),
          )
      )
        return { reason: "Diff 含未解析内容" };
      return { files };
    } catch {
      return { reason: "Diff 解析失败" };
    }
  }, [value]);
  const bytes = new TextEncoder().encode(value.patch);
  const raw = new TextDecoder().decode(bytes.subarray(0, limits.diffRawBytes), {
    stream: bytes.length > limits.diffRawBytes,
  });
  const summary = value.summary;
  return (
    <>
      {(summary.oldPath || summary.binary || summary.oldMode !== summary.newMode) && (
        <div className="space-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {summary.oldPath && (
            <p className="break-all">
              {summary.oldPath} → {summary.path}
            </p>
          )}
          <p>
            {summary.status}
            {summary.binary ? " · 二进制" : ""}
            {summary.oldMode !== summary.newMode
              ? ` · ${summary.oldMode ?? "无"} → ${summary.newMode ?? "无"}`
              : ""}
          </p>
        </div>
      )}
      {parsed.reason ? (
        <>
          <p role="status" className="px-4 py-2 text-xs">
            {parsed.reason}
            {bytes.length > limits.diffRawBytes ? "；仅显示部分原始 patch" : ""}
          </p>
          <pre className="w-max min-w-full px-4 py-3 font-mono text-xs">{raw}</pre>
        </>
      ) : (
        parsed.files?.map((file, index) => <DiffBlock key={index} file={file} />)
      )}
    </>
  );
}
function DiffBlock({ file }: { file: FileData }) {
  const tokens: HunkTokens = { old: [], new: [] };
  for (const hunk of file.hunks)
    for (const change of hunk.changes)
      if (change.content === "") {
        if (change.type === "delete") tokens.old[change.lineNumber - 1] = [{ type: "empty" }];
        else
          tokens.new[(change.type === "insert" ? change.lineNumber : change.newLineNumber) - 1] = [
            { type: "empty" },
          ];
      }
  return (
    <>
      <Diff
        viewType="unified"
        diffType={file.type}
        hunks={file.hunks}
        tokens={tokens}
        className="kiteline-diff"
        renderGutter={({ change, side, renderDefault }) => (
          <span aria-hidden="true" className="select-none">
            {renderDefault()}
            {side === "new"
              ? change.type === "insert"
                ? " +"
                : change.type === "delete"
                  ? " −"
                  : ""
              : ""}
          </span>
        )}
        renderToken={(token, renderDefault, index) =>
          token.type === "empty" ? <br key={index} /> : renderDefault(token, index)
        }
      >
        {(hunks) =>
          hunks.map((hunk) => (
            <Fragment key={hunk.content}>
              <Decoration className="bg-primary-soft text-muted-foreground">
                <span className="block px-2 py-1">{hunk.content}</span>
              </Decoration>
              <Hunk hunk={hunk} />
            </Fragment>
          ))
        }
      </Diff>
      {(file.oldEndingNewLine === false || file.newEndingNewLine === false) && (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {file.oldEndingNewLine === false ? "旧版" : ""}
          {file.oldEndingNewLine === false && file.newEndingNewLine === false ? "、" : ""}
          {file.newEndingNewLine === false ? "新版" : ""}末尾无换行
        </p>
      )}
    </>
  );
}
