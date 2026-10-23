import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { Device, Workspace } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/ui/context-menu";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import type { DeviceAction } from "./device-actions";

export function WorkspaceMenu({
  device,
  workspace,
  children,
  navigation = false,
  onOpen,
  onAction,
}: {
  device: Device;
  workspace: Workspace;
  children: ReactElement;
  navigation?: boolean;
  onOpen: () => void;
  onAction: (action: DeviceAction) => void;
}) {
  const { t } = useTranslation();
  const items = (
    <WorkspaceMenuItems device={device} workspace={workspace} onOpen={onOpen} onAction={onAction} />
  );
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={children} />
        <ContextMenuContent>{items}</ContextMenuContent>
      </ContextMenu>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className={navigation ? "workspace-navigation-more" : "row-more"}
              aria-label={t(($) => $.common.actionsNamed, { name: workspace.name })}
            />
          }
        >
          <MoreHorizontal />
        </MenuTrigger>
        <MenuContent>{items}</MenuContent>
      </Menu>
    </>
  );
}

function WorkspaceMenuItems({
  device,
  workspace,
  onOpen,
  onAction,
}: {
  device: Device;
  workspace: Workspace;
  onOpen: () => void;
  onAction: (action: DeviceAction) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="max-w-72 break-all px-2 py-1 text-xs text-muted-foreground">
        {device.name} / {workspace.name}
        <br />
        {workspace.path}
      </p>
      <MenuItem onClick={onOpen}>
        <FolderOpen />
        {t(($) => $.common.open)}
      </MenuItem>
      <MenuItem
        disabled={device.status !== "online"}
        onClick={() => onAction({ type: "workspace-rename", device, workspace })}
      >
        <Pencil />
        {t(($) => $.common.rename)}
      </MenuItem>
      <MenuItem
        disabled={device.status !== "online"}
        onClick={() => onAction({ type: "workspace-remove", device, workspace })}
      >
        <Trash2 />
        {t(($) => $.devices.remove)}
      </MenuItem>
    </>
  );
}
