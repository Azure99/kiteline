import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Copy, KeyRound } from "lucide-react";
import { limits, type CliCredential, type Device } from "@kiteline/shared/protocol";
import { api, post } from "./lib/api";
import { useCopyFeedback } from "./lib/use-copy-feedback";
import { ErrorNotice } from "./components/error-notice";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { CliLogin } from "./cli/cli-command";

export function Credentials({
  devices,
  loginCommand,
}: {
  devices: Device[];
  loginCommand: string;
}) {
  const { t, i18n } = useTranslation();
  const [credentials, setCredentials] = useState<CliCredential[]>();
  const [issued, setIssued] = useState<{ token: string; credential: CliCredential }>();
  const [noExpiry, setNoExpiry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const { copied, copy, error: copyError, reset } = useCopyFeedback();
  async function load() {
    setBusy(true);
    setError(undefined);
    try {
      setCredentials((await api<{ credentials: CliCredential[] }>("/api/credentials")).credentials);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const result = await post<{ token: string; credential: CliCredential }>("/api/credentials", {
        name: data.get("name"),
        deviceIds: data.getAll("device"),
        expiresAt: noExpiry
          ? null
          : new Date(Date.now() + Number(data.get("days")) * 86_400_000).toISOString(),
      });
      setIssued(result);
      reset();
      setCredentials((current) => [result.credential, ...(current ?? [])]);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
      setCredentials((current) => current?.filter((item) => item.id !== id));
      if (issued?.credential.id === id) setIssued(undefined);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <p className="text-muted-foreground">{t(($) => $.credentials.scope)}</p>
      {issued ? (
        <div className="space-y-3 rounded border border-border p-3">
          <CliLogin command={loginCommand} />
          <p>{t(($) => $.credentials.copyOnce)}</p>
          <Textarea
            aria-label={t(($) => $.credentials.token)}
            readOnly
            value={issued.token}
            rows={2}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void copy(issued.token)}>
              <Copy />
              {copied ? t(($) => $.credentials.copied) : t(($) => $.credentials.copy)}
            </Button>
            <Button variant="outline" onClick={() => setIssued(undefined)}>
              {t(($) => $.credentials.newToken)}
            </Button>
          </div>
          {!!copyError && <ErrorNotice error={copyError.error} />}
        </div>
      ) : (
        <form onSubmit={(event) => void create(event)} className="space-y-3">
          <label className="block space-y-1">
            <span>{t(($) => $.credentials.name)}</span>
            <Input name="name" required maxLength={limits.nameLength} />
          </label>
          <fieldset className="space-y-1">
            <legend className="mb-1">{t(($) => $.credentials.devices)}</legend>
            {!devices.length && <p>{t(($) => $.credentials.noDevices)}</p>}
            {devices.map((device) => (
              <label key={device.id} className="flex min-h-9 items-center gap-2 break-all">
                <input type="checkbox" name="device" value={device.id} />
                <span>
                  {device.name} <span className="text-xs text-muted-foreground">{device.id}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2">
            <span>{t(($) => $.credentials.days)}</span>
            <Input
              className="w-24"
              type="number"
              name="days"
              min={1}
              step={1}
              defaultValue={30}
              required
              disabled={noExpiry}
            />
          </label>
          <label className="flex min-h-9 items-center gap-2">
            <input
              type="checkbox"
              checked={noExpiry}
              onChange={(event) => setNoExpiry(event.target.checked)}
            />
            {t(($) => $.credentials.noExpiry)}
          </label>
          <Button type="submit" disabled={busy || !devices.length}>
            <KeyRound />
            {t(($) => $.credentials.issue)}
          </Button>
        </form>
      )}
      {!!error && (
        <div role="alert">
          <ErrorNotice error={error} />
        </div>
      )}
      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium">{t(($) => $.credentials.existing)}</h3>
          <Button variant="ghost" disabled={busy} onClick={() => void load()}>
            {t(($) => $.common.refresh)}
          </Button>
        </div>
        {credentials?.length === 0 && (
          <p className="text-muted-foreground">{t(($) => $.credentials.empty)}</p>
        )}
        {credentials?.map((credential) => (
          <div key={credential.id} className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1 break-words">
              <p className="font-medium">{credential.name}</p>
              <p className="text-xs text-muted-foreground">
                {credential.deviceIds
                  .map((id) => devices.find((device) => device.id === id)?.name ?? id)
                  .join(", ")}
              </p>
              <p className="text-xs text-muted-foreground">
                {credential.expiresAt === null
                  ? t(($) => $.credentials.noExpiry)
                  : t(($) => $.credentials.expires, {
                      time: new Date(credential.expiresAt).toLocaleString(i18n.resolvedLanguage),
                    })}
              </p>
            </div>
            <Button variant="outline" disabled={busy} onClick={() => void revoke(credential.id)}>
              {t(($) => $.credentials.revoke)}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
