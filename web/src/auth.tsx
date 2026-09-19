import { ErrorNotice } from "./components/error-notice";
import { useState, type FormEvent } from "react";
import { ArrowRight, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LanguageMenu } from "./components/language-menu";
import { api, post } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";

export interface Session {
  expiresAt: string;
  draftTotalBytes: number;
}

export function Auth({
  initialized,
  onLogin,
}: {
  initialized: boolean;
  onLogin: (session: Session) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await post(initialized ? "/api/login" : "/api/setup", {
        password: input.get("password"),
        setupToken: input.get("setupToken"),
      });
      onLogin(await api<Session>("/api/session"));
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted px-6 py-12">
      <div className="w-full max-w-80">
        <div className="mb-9 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded bg-primary text-white">
            <Terminal size={22} />
          </span>
          <h1 className="text-xl font-semibold">Kiteline</h1>
          <div className="ml-auto">
            <LanguageMenu />
          </div>
        </div>
        <h2 className="mb-6 text-lg font-medium">
          {initialized ? t(($) => $.auth.login) : t(($) => $.auth.ownerSetup)}
        </h2>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          {!initialized && (
            <label className="block space-y-2">
              <span>{t(($) => $.auth.setupToken)}</span>
              <Input name="setupToken" required autoComplete="off" autoFocus />
            </label>
          )}
          <label className="block space-y-2">
            <span>{t(($) => $.auth.password)}</span>
            <Input
              name="password"
              type="password"
              required
              autoComplete={initialized ? "current-password" : "new-password"}
              autoFocus={initialized}
            />
          </label>
          {!!error && (
            <div role="alert" className="text-sm text-destructive">
              <ErrorNotice error={error} context="login" />
            </div>
          )}
          <Button type="submit" disabled={busy} className="w-full">
            {busy
              ? t(($) => $.auth.processing)
              : initialized
                ? t(($) => $.auth.login)
                : t(($) => $.auth.initialize)}
            <ArrowRight />
          </Button>
        </form>
        <Dialog>
          <DialogTrigger
            render={<Button variant="ghost" className="mt-3 w-full text-muted-foreground" />}
          >
            {t(($) => $.auth.recovery)}
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(($) => $.auth.recovery)}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 overflow-auto p-5 text-sm">
              <p>{t(($) => $.auth.recoveryCommand)}</p>
              <pre className="overflow-auto rounded bg-muted p-3">
                {initialized ? "kiteline-server reset-password" : "kiteline-server setup-token"}
              </pre>
              <p>{t(($) => $.auth.restart)}</p>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  );
}
