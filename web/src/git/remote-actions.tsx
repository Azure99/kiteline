import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import type { GitRemotes, HeadIdentity } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { errorMessage, rpc } from "../lib/api";
import { useWorkspaceRefresh } from "../lib/use-workspace-refresh";
import { type GitActions, type GitTarget, useGitActivity } from "./actions";

export function RemoteActions({
  target,
  actions,
  active,
  head,
}: {
  target: GitTarget;
  actions: GitActions;
  active: boolean;
  head?: HeadIdentity;
}) {
  const [value, setValue] = useState<GitRemotes>();
  const [error, setError] = useState("");
  const request = useRef<AbortController>(undefined);
  const activity = useGitActivity(actions, target);
  const { deviceId, workspaceId, repoId } = target;
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await rpc(deviceId, "git.remotes", { workspaceId, repoId }, controller.signal);
      if (!controller.signal.aborted) {
        setValue(next);
        setError("");
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }
  }, [deviceId, workspaceId, repoId]);
  useEffect(() => () => request.current?.abort(), [active, load]);
  useWorkspaceRefresh(deviceId, workspaceId, active, "git", load);
  const disabled = !active || !!activity.request;
  return (
    <div className="flex shrink-0 items-center">
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Fetch"
              title="Fetch"
              disabled={disabled}
            />
          }
        >
          <RefreshCw />
        </MenuTrigger>
        <MenuContent>
          {error && (
            <p role="alert" className="max-w-64 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <MenuItem onClick={() => void actions.run(target, "git.fetch", {}, "Fetch")}>
            Fetch · 按设备 Git 配置
          </MenuItem>
          {value?.remotes.map((entry) => (
            <MenuItem
              key={entry.name}
              onClick={() => void actions.run(target, "git.fetch", { remote: entry.name }, "Fetch")}
              title={entry.fetchUrls.join("\n")}
            >
              Fetch · {entry.name}
            </MenuItem>
          ))}
          <MenuItem onClick={() => void load()}>
            <RefreshCw />
            刷新远端配置
          </MenuItem>
        </MenuContent>
      </Menu>
      <IconButton
        label={`Pull${value?.upstream ? ` · ${value.upstream}` : " · 按设备 Git 配置"}`}
        disabled={disabled || !head}
        onClick={() => {
          if (head) void actions.run(target, "git.pull", { expectedHead: head }, "Pull");
        }}
      >
        <ArrowDown />
      </IconButton>
      <IconButton
        label={`Push · ${value?.pushTargetDescription ?? "按设备 Git 配置"}`}
        disabled={disabled || !head}
        onClick={() => {
          if (head) void actions.run(target, "git.push", { expectedHead: head }, "Push");
        }}
      >
        <ArrowUp />
      </IconButton>
    </div>
  );
}
