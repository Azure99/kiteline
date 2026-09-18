import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { api, errorMessage, post } from "../lib/api";
import {
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";

interface Binding {
  bindingId: string;
  code: string;
  expiresAt: string;
}
interface Result {
  status: "pending" | "consumed" | "expired";
  deviceId?: string;
}

export function BindingDialog({ onDevice }: { onDevice: (id: string) => void }) {
  const [binding, setBinding] = useState<Binding>();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  async function create() {
    setError("");
    setBusy(true);
    try {
      setBinding(await post<Binding>("/api/bindings"));
      setResult({ status: "pending" });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!binding) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const status = await api<Result>(`/api/bindings/${binding!.bindingId}`, {
          signal: controller.signal,
        });
        setResult(status);
        setError("");
        if (status.status === "pending") timer = setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [binding]);
  const command = `kiteline-agent bind --server ${location.origin}`;
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>绑定设备</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 overflow-auto p-5">
        {!binding ? (
          <Button disabled={busy} onClick={() => void create()}>
            {busy ? "正在生成" : "生成绑定码"}
          </Button>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {result?.status === "consumed"
                  ? "已绑定"
                  : result?.status === "expired"
                    ? "绑定码已过期"
                    : "等待设备"}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(binding.expiresAt).toLocaleTimeString()} 到期
              </span>
            </div>
            <pre className="overflow-auto rounded bg-muted p-3 text-xs">{command}</pre>
            <div className="flex items-center gap-2 rounded border border-border px-3 py-2">
              <code className="min-w-0 flex-1 break-all select-all">{binding.code}</code>
              <IconButton
                label={copied ? "已复制" : "复制绑定码"}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(binding.code)
                    .then(() => setCopied(true))
                    .catch((error: unknown) => setError(errorMessage(error)));
                }}
              >
                {copied ? <Check /> : <Copy />}
              </IconButton>
            </div>
            {result?.status === "consumed" && (
              <p className="text-sm">
                设备身份已登记，在线状态以设备列表为准。若设备未能保存凭据，请撤销该设备后重新绑定。
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>关闭</DialogClose>
        {result?.deviceId && <Button onClick={() => onDevice(result.deviceId!)}>查看设备</Button>}
        {result?.status === "expired" && (
          <Button onClick={() => void create()} disabled={busy}>
            重新生成
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
