import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import type { GitRemotes, HeadIdentity } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { rpc } from "../lib/api";
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
  const { t } = useTranslation();

  const [value, setValue] = useState<GitRemotes>();
  const [error, setError] = useState<unknown>();
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
        setError(undefined);
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason);
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
          {!!error && (
            <div role="alert" className="max-w-64 p-2 text-xs text-destructive">
              <ErrorNotice error={error} />
            </div>
          )}
          <MenuItem onClick={() => void actions.run(target, "git.fetch", {})}>
            {t(($) => $.git.fetchConfigured)}
          </MenuItem>
          {value?.remotes.map((entry) => (
            <MenuItem
              key={entry.name}
              onClick={() => void actions.run(target, "git.fetch", { remote: entry.name })}
              title={entry.fetchUrls.join("\n")}
            >
              Fetch · {entry.name}
            </MenuItem>
          ))}
          <MenuItem onClick={() => void load()}>
            <RefreshCw />
            {t(($) => $.git.refreshRemotes)}
          </MenuItem>
        </MenuContent>
      </Menu>
      <IconButton
        label={
          value?.upstream
            ? t(($) => $.git.pullTarget, { target: value.upstream })
            : t(($) => $.git.pullConfigured)
        }
        disabled={disabled || !head}
        onClick={() => {
          if (head) void actions.run(target, "git.pull", { expectedHead: head });
        }}
      >
        <ArrowDown />
      </IconButton>
      <IconButton
        label={
          value?.pushTarget
            ? t(($) => $.git.pushTarget, { target: value.pushTarget })
            : value?.defaultPushRemote
              ? t(($) => $.git.pushConfiguredRemote, { remote: value.defaultPushRemote })
              : t(($) => $.git.pushConfigured)
        }
        disabled={disabled || !head}
        onClick={() => {
          if (head) void actions.run(target, "git.push", { expectedHead: head });
        }}
      >
        <ArrowUp />
      </IconButton>
    </div>
  );
}
