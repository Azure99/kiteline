import { useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { appVersion, type Device } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Credentials } from "../credentials-dialog";
import { useServerVersion } from "../lib/release";
import { cliDownload, cliGuide, cliTargets, loginCommand, type CliTarget } from "./commands";
import { CliLogin } from "./cli-command";

export function CliSetupDialog({ devices }: { devices: Device[] }) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<Tabs.Tab.Value>("setup");
  const [target, setTarget] = useState<CliTarget>("linux-amd64");
  const version = useServerVersion() ?? appVersion;
  const download = cliDownload(version, target);
  const login = loginCommand(location.origin, target === "windows-amd64" ? "powershell" : "unix");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t(($) => $.cliSetup.title)}</DialogTitle>
      </DialogHeader>
      <Tabs.Root value={tab} onValueChange={setTab} className="flex min-h-0 flex-col">
        <Tabs.List className="flex shrink-0 border-b border-border px-5">
          <Tabs.Tab value="setup" className="tool-tab min-h-11 px-3 text-sm">
            {t(($) => $.cliSetup.setup)}
          </Tabs.Tab>
          <Tabs.Tab value="credentials" className="tool-tab min-h-11 px-3 text-sm">
            {t(($) => $.credentials.title)}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="setup" keepMounted className="space-y-5 overflow-auto p-5 text-sm">
          <section className="space-y-3">
            <h3 className="font-medium">{t(($) => $.cliSetup.install)}</h3>
            <label className="block space-y-1">
              <span>{t(($) => $.cliSetup.platform)}</span>
              <select
                className="block min-h-11 w-full rounded border border-border bg-background px-3"
                value={target}
                onChange={(event) => setTarget(event.target.value as CliTarget)}
              >
                {cliTargets.map((value) => (
                  <option key={value} value={value}>
                    {t(($) => $.cliSetup[value])}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button nativeButton={false} render={<a href={download} />}>
                <Download />
                {t(($) => $.cliSetup.download, { version })}
              </Button>
              <a
                className="text-primary underline"
                href={cliGuide(version, target, i18n.language)}
                target="_blank"
                rel="noreferrer"
              >
                {t(($) => $.cliSetup.installGuide)}
              </a>
            </div>
          </section>
          <section className="space-y-3">
            <h3 className="font-medium">{t(($) => $.cliSetup.credentialStep)}</h3>
            <p className="text-muted-foreground">{t(($) => $.cliSetup.credentialHint)}</p>
            <Button variant="outline" onClick={() => setTab("credentials")}>
              {t(($) => $.credentials.title)}
            </Button>
          </section>
          <section className="space-y-3">
            <h3 className="font-medium">{t(($) => $.cliSetup.login)}</h3>
            <CliLogin command={login} />
          </section>
        </Tabs.Panel>
        <Tabs.Panel value="credentials" keepMounted className="overflow-auto p-5 text-sm">
          <Credentials devices={devices} loginCommand={login} />
        </Tabs.Panel>
      </Tabs.Root>
    </DialogContent>
  );
}
