import {
  cloneElement,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  FolderPlus,
  Globe,
  MoreHorizontal,
  Pencil,
  Server,
  Settings,
  Trash2,
} from "lucide-react";
import type { Device } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/ui/context-menu";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { devicePath } from "../lib/navigation";
import { TerminalSettings } from "../terminal/settings";
import type { DeviceActions } from "./device-actions";
import { UpgradeDialog } from "./upgrade-dialog";

export function DeviceMenu({
  device,
  children,
  actions,
}: {
  device: Device;
  children?: ReactElement<ComponentPropsWithRef<"button">>;
  actions: DeviceActions;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(false);
  const [upgrade, setUpgrade] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = (
    <DeviceMenuItems
      device={device}
      actions={actions}
      onSettings={() => setSettings(true)}
      onUpgrade={() => setUpgrade(true)}
    />
  );
  return (
    <>
      {children ? (
        <ContextMenu>
          <ContextMenuTrigger render={cloneElement(children, { ref: trigger })} />
          <ContextMenuContent>{items}</ContextMenuContent>
        </ContextMenu>
      ) : (
        <Menu>
          <MenuTrigger
            render={
              <Button
                ref={trigger}
                variant="ghost"
                size="icon"
                aria-label={t(($) => $.common.actionsNamed, { name: device.name })}
              />
            }
          >
            <MoreHorizontal />
          </MenuTrigger>
          <MenuContent>{items}</MenuContent>
        </Menu>
      )}
      {settings && <TerminalSettings device={device} onClose={() => setSettings(false)} />}
      {upgrade && (
        <UpgradeDialog
          deviceName={device.name}
          initialPlatform={device.environment?.os}
          trigger={trigger}
          onClose={() => setUpgrade(false)}
        />
      )}
    </>
  );
}

function DeviceMenuItems({
  device,
  actions,
  onSettings,
  onUpgrade,
}: {
  device: Device;
  actions: DeviceActions;
  onSettings: () => void;
  onUpgrade: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <MenuItem onClick={() => actions.navigate(devicePath(device.id))}>
        <Server />
        {t(($) => $.devices.viewDevice)}
      </MenuItem>
      <MenuItem disabled={device.status !== "online"} onClick={() => actions.addWorkspace(device)}>
        <FolderPlus />
        {t(($) => $.devices.addWorkspace)}
      </MenuItem>
      <MenuItem onClick={() => actions.openPort(device.id)}>
        <Globe />
        {t(($) => $.shell.openPort)}
      </MenuItem>
      <MenuItem onClick={onSettings}>
        <Settings />
        {t(($) => $.terminal.settings)}
      </MenuItem>
      <MenuItem onClick={onUpgrade}>
        <Download />
        {t(($) => $.devices.upgradeAgent)}
      </MenuItem>
      <MenuItem onClick={() => actions.openAction({ type: "rename", device })}>
        <Pencil />
        {t(($) => $.common.rename)}
      </MenuItem>
      <MenuItem onClick={() => actions.openAction({ type: "delete", device })}>
        <Trash2 />
        {t(($) => $.devices.deleteDevice)}
      </MenuItem>
    </>
  );
}
