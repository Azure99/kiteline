import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import type { Device, ListeningPorts } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import { IconButton } from "../components/icon-button";
import { errorMessage, rpc } from "../lib/api";
import { serviceURL } from "../lib/device-service";

export function PortDialog({ device, onClose }: { device: Device; onClose: () => void }) {
  const [port, setPort] = useState("");
  const [retain, setRetain] = useState(false);
  const [ports, setPorts] = useState<ListeningPorts>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef<AbortController>(undefined);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await rpc(device.id, "ports.list", {}, controller.signal);
      if (!controller.signal.aborted) setPorts(next);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [device.id]);
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  const value = /^\d{1,5}$/.test(port) ? Number(port) : 0;
  const url = value >= 1 && value <= 65535 ? serviceURL(device.id, value, retain).href : undefined;
  function open() {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setNotice("链接已复制");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>访问端口</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            open();
          }}
        >
          <div className="space-y-4 overflow-auto p-5">
            <p className="break-all text-sm font-medium">{device.name}</p>
            <label className="block space-y-2 text-sm">
              <span>端口</span>
              <Input
                aria-label="端口"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={5}
                value={port}
                onChange={(event) => {
                  setPort(event.target.value);
                  setNotice("");
                }}
                autoFocus
              />
            </label>
            <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <legend className="sr-only">代理路径</legend>
              <label className="flex min-h-8 items-center gap-2 max-[959px]:min-h-11">
                <input
                  type="radio"
                  name="proxy-mode"
                  checked={!retain}
                  onChange={() => setRetain(false)}
                />
                普通路径
              </label>
              <label className="flex min-h-8 items-center gap-2 max-[959px]:min-h-11">
                <input
                  type="radio"
                  name="proxy-mode"
                  checked={retain}
                  onChange={() => setRetain(true)}
                />
                保留路径
              </label>
            </fieldset>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>监听端口</span>
                <IconButton label="刷新监听端口" onClick={() => void load()} disabled={loading}>
                  <RefreshCw />
                </IconButton>
              </div>
              {loading ? (
                <p role="status" className="text-sm text-muted-foreground">
                  正在读取
                </p>
              ) : error ? (
                <p role="alert" className="break-words text-sm text-destructive">
                  {error}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {ports?.ports.map((entry) => (
                    <Button
                      key={entry}
                      variant="outline"
                      onClick={() => {
                        setPort(String(entry));
                        setNotice("");
                      }}
                    >
                      {entry}
                    </Button>
                  ))}
                  {ports?.ports.length === 0 && (
                    <p className="text-sm text-muted-foreground">未发现监听端口</p>
                  )}
                </div>
              )}
              {ports?.truncated && (
                <p className="mt-2 text-xs text-muted-foreground">仅显示部分端口</p>
              )}
            </div>
            {port && !url && (
              <p role="alert" className="text-sm text-destructive">
                端口需在 1 至 65535 之间
              </p>
            )}
            {notice && (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={!url} onClick={() => void copy()}>
              <Copy />
              复制链接
            </Button>
            <Button type="submit" disabled={!url}>
              <ExternalLink />
              打开
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
