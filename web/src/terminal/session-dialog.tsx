import { useState } from "react";
import { Copy } from "lucide-react";
import type { Session } from "@kiteline/shared/protocol";
import { errorMessage } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";

export interface SessionAction {
  kind: "rename" | "end" | "copy";
  session: Session;
}
export function SessionDialog({
  action,
  busy,
  onClose,
  onChange,
}: {
  action: SessionAction;
  busy: boolean;
  onClose(): void;
  onChange(kind: "rename" | "end", id: string, name: string): Promise<boolean>;
}) {
  const [name, setName] = useState(action.session.name);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(`kiteline-agent terminal attach ${action.session.id}`);
      setCopied(true);
      setError("");
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {action.kind === "rename"
              ? "重命名终端"
              : action.kind === "copy"
                ? "本机接续"
                : "结束会话"}
          </DialogTitle>
        </DialogHeader>
        {action.kind === "rename" ? (
          <Input
            aria-label="终端名称"
            value={name}
            maxLength={256}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        ) : action.kind === "copy" ? (
          <>
            <Input
              aria-label="本机接续命令"
              readOnly
              value={`kiteline-agent terminal attach ${action.session.id}`}
            />
            <p className="text-sm text-muted-foreground">
              Ctrl-b d 断开；Ctrl-b Ctrl-b 发送 Ctrl-b。
            </p>
          </>
        ) : (
          <p className="break-words">结束 {action.session.name} 及其中的任务？</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {action.kind === "copy" ? "关闭" : "取消"}
          </Button>
          {action.kind === "copy" ? (
            <Button onClick={() => void copy()}>
              <Copy />
              {copied ? "已复制" : "复制"}
            </Button>
          ) : (
            <Button
              variant={action.kind === "end" ? "destructive" : "default"}
              disabled={busy || (action.kind === "rename" && !name.trim())}
              onClick={() => {
                if (action.kind !== "copy")
                  void onChange(action.kind, action.session.id, name).then((done) => {
                    if (done) onClose();
                  });
              }}
            >
              {action.kind === "rename" ? "保存" : "结束"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
