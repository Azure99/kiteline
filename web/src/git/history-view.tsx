import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitCommitHorizontal,
  RefreshCw,
  GitBranch,
} from "lucide-react";
import type { Commit, CommitFiles, GitHistory } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { errorMessage, rpc } from "../lib/api";
import { useMobile } from "../lib/use-mobile";
import { DiffView, type DiffTarget } from "./diff-view";

interface Props {
  deviceId: string;
  workspaceId: string;
  repoId: string;
  active: boolean;
  onFile: (path: string) => void;
  onBranch?: (oid: string) => void;
}
export function HistoryView(props: Props) {
  const { deviceId, workspaceId, repoId, active } = props;
  const [value, setValue] = useState<GitHistory>();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Commit>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController>(undefined);
  const pages = useRef<number[]>([]);
  const position = useRef<{ anchor?: string; offset: number }>({ offset: 0 });
  const load = useCallback(
    async (nextPosition = position.current, visited = pages.current) => {
      const { anchor, offset } = nextPosition;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError("");
      try {
        const result = await rpc<GitHistory>(
          deviceId,
          "git.history",
          { workspaceId, repoId, anchorOid: anchor, offset },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        position.current = { anchor: result.anchorOid, offset };
        pages.current = visited;
        setValue(result);
        setOffset(offset);
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      } finally {
        if (request.current === controller) {
          request.current = undefined;
          setBusy(false);
        }
      }
    },
    [deviceId, workspaceId, repoId],
  );
  useEffect(() => {
    if (active) void load();
    return () => request.current?.abort();
  }, [active, load]);
  return (
    <>
      <div className={`${selected ? "hidden" : "flex"} min-h-0 flex-1 flex-col`}>
        <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
          <span className="mr-auto">{value?.anchorOid?.slice(0, 8)}</span>
          <IconButton
            label="刷新提交历史"
            disabled={busy || !active}
            onClick={() => {
              void load({ offset: 0 }, []);
            }}
          >
            <RefreshCw />
          </IconButton>
        </div>
        {error && (
          <p role="alert" className="px-4 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="scroll-area min-h-0 flex-1 overflow-auto">
          {value?.commits.map((commit) => (
            <button
              key={commit.oid}
              onClick={() => setSelected(commit)}
              className="flex min-h-16 w-full items-start gap-3 border-b border-border px-4 py-3 text-left hover:bg-primary-soft"
            >
              <GitCommitHorizontal className="mt-1 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm">
                  {commit.subject || commit.oid.slice(0, 8)}
                </span>
                <span className="mt-1 block break-words text-xs text-muted-foreground">
                  {commit.author} · {new Date(commit.time).toLocaleString()}
                </span>
              </span>
              <span className="hidden font-mono text-xs text-muted-foreground min-[960px]:block">
                {commit.oid.slice(0, 8)}
              </span>
            </button>
          ))}
          {!value?.commits.length && (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              {busy ? "正在读取" : error ? "" : "暂无提交"}
            </p>
          )}
        </div>
        <div className="flex min-h-10 shrink-0 items-center gap-1 border-t border-border px-3 text-xs text-muted-foreground">
          <span className="mr-auto">
            {value?.commits.length ? `${offset + 1}–${offset + value.commits.length}` : "0"}
          </span>
          <IconButton
            label="历史上一页"
            disabled={busy || offset === 0}
            onClick={() =>
              void load(
                { anchor: position.current.anchor, offset: pages.current.at(-1) ?? 0 },
                pages.current.slice(0, -1),
              )
            }
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            label="历史下一页"
            disabled={busy || value?.nextOffset === undefined}
            onClick={() => {
              if (value?.nextOffset !== undefined)
                void load({ anchor: position.current.anchor, offset: value.nextOffset }, [
                  ...pages.current,
                  offset,
                ]);
            }}
          >
            <ChevronRight />
          </IconButton>
        </div>
      </div>
      {selected && (
        <CommitView
          key={selected.oid}
          {...props}
          commit={selected}
          onBack={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
function CommitView({
  deviceId,
  workspaceId,
  repoId,
  commit,
  active,
  onBack,
  onFile,
  onBranch,
}: Props & { commit: Commit; onBack: () => void }) {
  const [parent, setParent] = useState(commit.parents[0]);
  const [value, setValue] = useState<CommitFiles>();
  const [target, setTarget] = useState<DiffTarget>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController>(undefined);
  const loaded = useRef(false);
  const mobile = useMobile();
  const load = useCallback(
    async (cursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError("");
      try {
        const next = await rpc<CommitFiles>(
          deviceId,
          "git.commitFiles",
          { workspaceId, repoId, commitOid: commit.oid, parentOid: parent, cursor },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        loaded.current = true;
        setValue((old) =>
          cursor && old
            ? {
                ...next,
                files: { ...next.files, items: [...old.files.items, ...next.files.items] },
              }
            : next,
        );
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      } finally {
        if (request.current === controller) {
          request.current = undefined;
          setBusy(false);
        }
      }
    },
    [deviceId, workspaceId, repoId, commit.oid, parent],
  );
  useEffect(() => {
    setValue(undefined);
    setTarget(undefined);
    loaded.current = false;
  }, [load]);
  useEffect(() => {
    if (active && !loaded.current) void load();
    return () => request.current?.abort();
  }, [active, load]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
        <IconButton label="返回提交历史" onClick={onBack}>
          <ArrowLeft />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-xs" title={commit.subject}>
          {commit.subject}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {commit.oid.slice(0, 8)}
        </span>
        {onBranch && (
          <IconButton
            label="从此提交创建分支"
            disabled={!active}
            onClick={() => onBranch(commit.oid)}
          >
            <GitBranch />
          </IconButton>
        )}
      </div>
      {commit.parents.length > 1 && (
        <div className="shrink-0 border-b border-border px-3">
          <Menu>
            <MenuTrigger render={<Button variant="ghost" />}>
              <span className="text-xs">
                父项 {commit.parents.indexOf(parent!) + 1} · {parent?.slice(0, 8)}
              </span>
              <ChevronDown />
            </MenuTrigger>
            <MenuContent>
              {commit.parents.map((oid, index) => (
                <MenuItem key={oid} onClick={() => setParent(oid)}>
                  父项 {index + 1} · {oid.slice(0, 8)}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
      )}
      {error && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <aside
          className={`${mobile && target ? "hidden" : ""} scroll-area w-full overflow-auto border-border min-[960px]:w-72 min-[960px]:shrink-0 min-[960px]:border-r`}
          aria-label="提交文件"
        >
          {value?.files.items.map((file) => (
            <button
              key={file.path}
              onClick={() =>
                setTarget({
                  path: file.path,
                  oldPath: file.oldPath,
                  side: "commit",
                  commitOid: commit.oid,
                  parentOid: parent,
                })
              }
              className="flex min-h-11 w-full items-center gap-3 border-b border-border px-4 py-2 text-left text-xs hover:bg-primary-soft"
            >
              <span className="font-mono text-muted-foreground">{file.status}</span>
              <span className="min-w-0 flex-1 break-all">{file.path}</span>
              {file.binary && <span className="text-muted-foreground">二进制</span>}
            </button>
          ))}
          {busy && <p className="p-4 text-xs text-muted-foreground">正在读取</p>}
          {!busy && !error && !value?.files.items.length && (
            <p className="p-4 text-xs text-muted-foreground">没有文件变化</p>
          )}
          {value?.files.nextCursor && (
            <Button
              variant="ghost"
              className="w-full"
              disabled={busy || !active}
              onClick={() => void load(value.files.nextCursor)}
            >
              继续加载
            </Button>
          )}
          {!busy && error && (
            <Button variant="ghost" disabled={!active} onClick={() => void load()}>
              <RefreshCw />
              重试
            </Button>
          )}
        </aside>
        {target && (
          <DiffView
            {...{ deviceId, workspaceId, repoId, target }}
            onBack={() => setTarget(undefined)}
            onFile={() => onFile(target.path)}
          />
        )}
      </div>
    </div>
  );
}
