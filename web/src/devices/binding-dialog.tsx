import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Device } from "@kiteline/shared/protocol";
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
  commands: Record<"foreground" | "service" | "bind", string>;
}
interface Result {
  status: "pending" | "consumed" | "expired";
  deviceId?: string;
}

export function BindingDialog({
  devices,
  connected,
  onDevice,
}: {
  devices: Device[];
  connected: boolean;
  onDevice: (id: string) => void;
}) {
  const [binding, setBinding] = useState<Binding>();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"foreground" | "service">("foreground");
  const [copied, setCopied] = useState("");
  async function create() {
    setError("");
    setCopyError("");
    setBusy(true);
    try {
      setBinding(await post<Binding>("/api/bindings"));
      setResult({ status: "pending" });
      setCopied("");
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
        if (controller.signal.aborted) return;
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
  const command = binding?.commands[mode];
  const device = devices.find((entry) => entry.id === result?.deviceId);
  const online = connected && device?.status === "online";
  const copy = (text: string) => {
    setCopyError("");
    setCopied("");
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(text))
      .catch((error: unknown) => setCopyError(errorMessage(error)));
  };
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>绑定设备</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 overflow-auto p-5">
        {!binding ? (
          <Button disabled={busy} onClick={() => void create()}>
            {busy ? "正在生成" : "生成接入命令"}
          </Button>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
              <span role="status" className="text-sm">
                {result?.status === "consumed"
                  ? online
                    ? "设备已在线"
                    : !connected
                      ? "已登记，连接状态待确认"
                      : device?.status === "revoked"
                        ? "设备已撤销"
                        : "已登记，尚未连接"
                  : result?.status === "expired"
                    ? "绑定码已过期"
                    : "等待设备"}
              </span>
              <span className="text-xs">
                {new Date(binding.expiresAt).toLocaleTimeString()} 到期
              </span>
            </div>
            <fieldset className="space-y-2 text-sm">
              <legend className="sr-only">运行方式</legend>
              {(
                [
                  ["foreground", "前台运行", "Ctrl-C 停止"],
                  ["service", "后台常驻", "systemd · 开机启动"],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className="flex flex-wrap items-center gap-2">
                  <input
                    type="radio"
                    name="agent-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => {
                      setMode(value);
                      setCopied("");
                      setCopyError("");
                    }}
                  />
                  <span>{label}</span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </label>
              ))}
            </fieldset>
            <div className="rounded border border-border">
              <div className="flex items-center justify-between border-b border-border px-3 py-1">
                <span className="text-xs text-muted-foreground">Linux · 当前项目用户</span>
                <IconButton
                  label={copied === command ? "已复制接入命令" : "复制接入命令"}
                  disabled={result?.status !== "pending"}
                  onClick={() => copy(command!)}
                >
                  {copied === command ? <Check /> : <Copy />}
                </IconButton>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all p-3 text-xs leading-relaxed">
                {command}
              </pre>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">已安装，仅绑定</summary>
              <div className="mt-2 flex items-start gap-2">
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs">
                  {binding.commands.bind}
                </code>
                <IconButton
                  label={copied === binding.commands.bind ? "已复制绑定命令" : "复制绑定命令"}
                  disabled={result?.status !== "pending"}
                  onClick={() => copy(binding.commands.bind)}
                >
                  {copied === binding.commands.bind ? <Check /> : <Copy />}
                </IconButton>
              </div>
            </details>
            {result?.status === "consumed" && !online && (
              <p className="text-sm text-muted-foreground">
                若设备未能保存凭据，请撤销该设备后重新绑定。
              </p>
            )}
          </>
        )}
        {(copyError || error) && (
          <p role="alert" className="text-sm text-destructive">
            {copyError || error}
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
