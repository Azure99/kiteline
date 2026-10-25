import { useTranslation } from "react-i18next";
import type { Device, Session, Workspace } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { attachCommand, type CliShell } from "./commands";
import { CliCommand } from "./cli-command";

export function RemoteAttach({
  device,
  workspace,
  session,
  onSetup,
  shell,
  onShell,
}: {
  device: Device;
  workspace: Workspace;
  session: Session;
  onSetup(): void;
  shell: CliShell;
  onShell(shell: CliShell): void;
}) {
  const { t } = useTranslation();
  const command = attachCommand(device.id, session.workspaceId, session.id, shell);
  return (
    <div className="space-y-4 overflow-auto p-5 text-sm">
      <div className="space-y-1 break-words">
        <p>
          {device.name} · {t(($) => $.common[device.status])}
        </p>
        <p>
          {workspace.name} / {session.name}
        </p>
      </div>
      <p className="break-words">{t(($) => $.terminal.cliServer, { origin: location.origin })}</p>
      <label className="block space-y-1">
        <span className="block">{t(($) => $.terminal.cliShell)}</span>
        <select
          className="block min-h-11 w-full rounded border border-border bg-background px-3"
          value={shell}
          onChange={(event) => onShell(event.target.value as CliShell)}
        >
          <option value="unix">Linux / macOS</option>
          <option value="powershell">Windows (PowerShell)</option>
        </select>
      </label>
      <CliCommand command={command} label={t(($) => $.terminal.cliCommand)} />
      <p className="text-muted-foreground">{t(($) => $.terminal.detachHint)}</p>
      <Button variant="outline" onClick={onSetup}>
        {t(($) => $.terminal.cliSetup)}
      </Button>
    </div>
  );
}
