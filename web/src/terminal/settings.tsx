import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, Save, Trash2, X } from "lucide-react";
import type { Device, Shortcut } from "@kiteline/shared/protocol";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { IconButton } from "../components/icon-button";

export function TerminalSettings({ device }: { device: Device }) {
  const [history, setHistory] = useState(String(device.snapshot?.settings.historyLines ?? 10000));
  const [shortcuts, setShortcuts] = useState(device.snapshot?.shortcuts ?? []);
  const [editing, setEditing] = useState<Partial<Shortcut>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function operation(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await action();
      if (mounted.current) setSaved(true);
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const disabled = busy || device.status !== "online";
  function editShortcut(value: Partial<Shortcut>) {
    setEditing(value);
    setSaved(false);
  }
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>终端设置 · {device.name}</DialogTitle>
      </DialogHeader>
      <div className="scroll-area min-h-0 space-y-5 overflow-auto p-5">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void operation(async () => {
              await rpc(device.id, "settings.update", { historyLines: Number(history) });
            });
          }}
        >
          <label className="min-w-0 flex-1 space-y-2 text-sm">
            <span>新会话滚屏行数</span>
            <Input
              type="number"
              min={0}
              max={50000}
              step={1}
              disabled={busy}
              required
              value={history}
              onChange={(event) => {
                setHistory(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <Button type="submit" disabled={disabled || history === ""}>
            <Save />
            保存
          </Button>
        </form>
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">快捷方式</h2>
            <IconButton
              label="新增快捷方式"
              disabled={disabled}
              onClick={() => editShortcut({ name: "", command: "" })}
            >
              <Plus />
            </IconButton>
          </div>
          <div className="divide-y divide-border border-y border-border">
            {shortcuts.map((shortcut) => (
              <div key={shortcut.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{shortcut.name}</p>
                  <p
                    className="truncate font-mono text-xs text-muted-foreground"
                    title={shortcut.command}
                  >
                    {shortcut.command}
                  </p>
                </div>
                <IconButton
                  label={`编辑 ${shortcut.name}`}
                  disabled={disabled}
                  onClick={() => editShortcut(shortcut)}
                >
                  <Pencil />
                </IconButton>
                <IconButton
                  label={`删除 ${shortcut.name}`}
                  disabled={disabled}
                  onClick={() =>
                    void operation(async () => {
                      await rpc(device.id, "shortcuts.remove", { id: shortcut.id });
                      if (mounted.current) {
                        setShortcuts((items) => items.filter((item) => item.id !== shortcut.id));
                        if (editing?.id === shortcut.id) setEditing(undefined);
                      }
                    })
                  }
                >
                  <Trash2 />
                </IconButton>
              </div>
            ))}
          </div>
          {editing && (
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void operation(async () => {
                  const result = await rpc<Shortcut>(device.id, "shortcuts.put", editing);
                  if (mounted.current) {
                    setShortcuts((items) => [
                      ...items.filter((item) => item.id !== result.id),
                      result,
                    ]);
                    setEditing(undefined);
                  }
                });
              }}
            >
              <label className="block space-y-1 text-sm">
                <span>名称</span>
                <Input
                  value={editing.name ?? ""}
                  maxLength={256}
                  disabled={busy}
                  required
                  onChange={(event) => editShortcut({ ...editing, name: event.target.value })}
                  autoFocus
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>Shell 命令</span>
                <textarea
                  className="min-h-24 w-full rounded border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-[959px]:text-base"
                  value={editing.command ?? ""}
                  required
                  maxLength={65536}
                  disabled={busy}
                  onChange={(event) => editShortcut({ ...editing, command: event.target.value })}
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setEditing(undefined)}
                >
                  <X />
                  取消
                </Button>
                <Button type="submit" disabled={disabled}>
                  <Save />
                  保存快捷方式
                </Button>
              </div>
            </form>
          )}
        </section>
      </div>
      {(error || saved) && (
        <DialogFooter>
          <p
            role={error ? "alert" : "status"}
            className={
              error
                ? "w-full break-words text-sm text-destructive"
                : "w-full text-sm text-muted-foreground"
            }
          >
            {error || "已保存"}
          </p>
        </DialogFooter>
      )}
    </DialogContent>
  );
}
