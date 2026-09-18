import { useEffect, useRef, useState } from "react";
import { Circle, Copy, Download, FileOutput, RefreshCw, Save, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { IconButton } from "../components/icon-button";
import { ApiError, errorMessage } from "../lib/api";
import { draftError, isDirty, showDraft, useDrafts, type Draft, type DraftStore } from "./drafts";
import { TextEditor } from "./text-editor";
import { formatBytes } from "./use-browser";
import { downloadFile, type DiskText } from "./content";

export function DraftView({
  store,
  draft,
  unavailable,
}: {
  store: DraftStore;
  draft: Draft;
  unavailable?: string;
}) {
  const all = useDrafts(store);
  const [disk, setDisk] = useState<DiskText>();
  const [saveAs, setSaveAs] = useState(false);
  const [path, setPath] = useState(draft.path);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function closeSaveAs() {
    generation.current++;
    setSaveAs(false);
  }
  const tabs = all.filter(
    (item) => item.deviceId === draft.deviceId && item.workspaceId === draft.workspaceId,
  );
  async function save(revision?: string, target = draft.path) {
    if (await store.save(draft, target, revision ?? draft.revision)) setDisk(undefined);
  }
  async function check() {
    const current = await store.check(draft);
    if (current && (draft.unknownSave !== undefined || current.meta.revision !== draft.revision))
      setDisk(current);
  }
  if (!store.has(draft)) return <div className="p-4 text-sm text-muted-foreground">文件已关闭</div>;
  return (
    <>
      <div
        role="tablist"
        aria-label="打开的文件"
        className="flex min-h-9 shrink-0 overflow-x-auto border-b border-border bg-muted/40"
      >
        {tabs.map((item) => (
          <div
            key={item.id}
            className={`flex max-w-64 shrink-0 items-center border-r border-border ${item === draft ? "bg-background" : ""}`}
          >
            <button
              role="tab"
              aria-selected={item === draft}
              title={item.path}
              onClick={() => showDraft(item)}
              className="flex min-h-9 min-w-0 items-center gap-2 px-3 text-xs"
            >
              <span className="truncate">{item.path.split("/").at(-1)}</span>
              {isDirty(item) && <Circle size={7} fill="currentColor" aria-label="未保存" />}
            </button>
            <IconButton label={`关闭 ${item.path}`} onClick={() => store.requestClose(item)}>
              <X size={13} />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <span
          className="min-w-0 flex-1 truncate text-xs"
          title={`${draft.deviceName} / ${draft.workspaceName}\n${draft.resolvedPath ?? draft.path}`}
        >
          {draft.path}
        </span>
        <IconButton label="下载文件" disabled={!!unavailable} onClick={() => downloadFile(draft)}>
          <Download />
        </IconButton>
        <IconButton
          label="复制文本"
          disabled={!draft.state}
          onClick={() => {
            void navigator.clipboard
              .writeText(draft.state!.doc.toString())
              .catch((reason: unknown) => {
                draft.error = reason;
                store.changed();
              });
          }}
        >
          <Copy />
        </IconButton>
        <IconButton
          label="核对磁盘内容"
          disabled={!!draft.busy || !!unavailable}
          onClick={() => void check()}
        >
          <RefreshCw />
        </IconButton>
        <IconButton
          label="另存为"
          disabled={!draft.state || !!draft.busy || !!unavailable}
          onClick={() => {
            setPath(draft.path);
            setError("");
            setSaveAs(true);
          }}
        >
          <FileOutput />
        </IconButton>
        <IconButton
          label="保存文件"
          disabled={!store.canSave(draft) || !!unavailable}
          onClick={() => void save()}
        >
          <Save />
        </IconButton>
      </div>
      {(unavailable ||
        store.overLimit(draft) ||
        draft.notice ||
        draftError(draft) ||
        draft.format.mixedLineEndings) && (
        <div className="shrink-0 space-y-1 border-b border-border px-3 py-2 text-xs">
          {unavailable && <p role="status">{unavailable}</p>}
          {store.overLimit(draft) && <p role="status">内容超过当前编辑容量，请缩小后保存</p>}
          {draft.format.mixedLineEndings && (
            <p className="text-muted-foreground">
              混合换行；保存采用 {draft.format.lineEnding.toUpperCase()}
            </p>
          )}
          {draft.notice && <p role="status">{draft.notice}</p>}
          {draftError(draft) && (
            <p role="alert" className="break-words text-destructive">
              {draftError(draft)}
            </p>
          )}
          {draft.error instanceof ApiError &&
            (draft.error.code === "conflict" || draft.error.outcome === "unknown") && (
              <Button
                variant="outline"
                disabled={!!draft.busy || !!unavailable}
                onClick={() => void check()}
              >
                核对磁盘内容
              </Button>
            )}
        </div>
      )}
      {draft.state ? (
        <TextEditor
          key={draft.id}
          {...{ draft, store }}
          onSave={() => {
            if (!unavailable) void save();
          }}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground">
          {draft.busy ? "正在读取" : "未打开文本"}
          {!draft.busy && (
            <Button
              variant="outline"
              disabled={!!unavailable}
              onClick={() => void store.load(draft)}
            >
              <RefreshCw />
              重试
            </Button>
          )}
        </div>
      )}
      <div className="flex min-h-6 shrink-0 flex-wrap items-center justify-between gap-x-3 border-t border-border px-3 text-[11px] text-muted-foreground">
        <span>
          {draft.busy === "saving"
            ? "正在保存"
            : draft.busy === "checking"
              ? "正在核对"
              : isDirty(draft)
                ? "未保存"
                : draft.state
                  ? "已保存"
                  : ""}
        </span>
        {draft.state && (
          <span>
            {formatBytes(draft.bytes)} · UTF-8{draft.format.bom ? " BOM" : ""} ·{" "}
            {draft.format.lineEnding.toUpperCase()}
          </span>
        )}
      </div>
      <Dialog
        open={!!disk}
        onOpenChange={(open) => {
          if (!open) setDisk(undefined);
        }}
      >
        {disk && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>磁盘内容已变化</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 space-y-3 overflow-auto p-4">
              <p className="break-all text-xs">{disk.target.path}</p>
              <Textarea
                aria-label="当前磁盘文本"
                value={disk.text}
                readOnly
                rows={12}
                className="font-mono text-xs"
              />
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDisk(undefined)}>
                取消
              </Button>
              <Button
                variant="outline"
                disabled={!!draft.busy}
                onClick={() => {
                  if (isDirty(draft) && !window.confirm("放弃未保存修改，加载磁盘版本？")) return;
                  try {
                    store.adopt(draft, disk);
                    setDisk(undefined);
                    showDraft(draft, true);
                  } catch (reason) {
                    setError(errorMessage(reason));
                  }
                }}
              >
                加载磁盘版
              </Button>
              <Button
                disabled={!store.canSave(draft) || !!unavailable}
                onClick={() => void save(disk.meta.revision, disk.target.path)}
              >
                覆盖此版本
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
      <Dialog
        open={saveAs}
        onOpenChange={(open) => {
          if (!open) closeSaveAs();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>另存为</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !path ||
                path.startsWith("/") ||
                path.split("/").some((part) => !part || part === "." || part === "..")
              ) {
                setError("请输入 workspace 内的文件路径");
                return;
              }
              const submitted = ++generation.current;
              void store.save(draft, path, null).then((saved) => {
                if (submitted !== generation.current || !store.has(draft)) return;
                if (saved) {
                  closeSaveAs();
                  showDraft(draft, true);
                } else setError(draftError(draft) ?? "未能保存");
              });
            }}
            className="flex min-h-0 flex-col"
          >
            <div className="space-y-3 overflow-auto p-4">
              <Textarea
                aria-label="另存路径"
                rows={2}
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeSaveAs}>
                取消
              </Button>
              <Button type="submit" disabled={!store.canSave(draft)}>
                另存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
