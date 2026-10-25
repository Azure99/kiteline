import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Device, Session, Workspace } from "@kiteline/shared/protocol";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { CliSetupDialog } from "./cli-setup-dialog";
import { RemoteAttach } from "./remote-attach";
import type { CliTarget } from "./commands";

export interface CliAttachTarget {
  device: Device;
  workspace: Workspace;
  session: Session;
}
export function CliDialog({
  devices,
  target,
  onClose,
}: {
  devices: Device[];
  target?: CliAttachTarget;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"attach" | "setup">(target ? "attach" : "setup");
  const [platform, setPlatform] = useState<CliTarget>("linux-amd64");
  const attach = () => setStep("attach");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        if (target && step === "setup") attach();
        else onClose();
      }}
    >
      {step === "setup" ? (
        <CliSetupDialog
          devices={devices}
          target={platform}
          onTarget={setPlatform}
          returnTo={target ? { name: target.session.name, onReturn: attach } : undefined}
        />
      ) : (
        target && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(($) => $.terminal.cliAttach)}</DialogTitle>
            </DialogHeader>
            <RemoteAttach
              {...target}
              shell={platform === "windows-amd64" ? "powershell" : "unix"}
              onShell={(shell) =>
                setPlatform((old) =>
                  shell === "powershell"
                    ? "windows-amd64"
                    : old === "windows-amd64"
                      ? "linux-amd64"
                      : old,
                )
              }
              onSetup={() => setStep("setup")}
            />
          </DialogContent>
        )
      )}
    </Dialog>
  );
}
