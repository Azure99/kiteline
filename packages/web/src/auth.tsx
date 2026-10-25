import { ErrorNotice } from "./components/error-notice";
import { useState, type FormEvent } from "react";
import { ArrowRight, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppearanceMenu } from "./components/appearance-menu";
import { LanguageMenu } from "./components/language-menu";
import { post } from "./lib/api";
import { useServerVersion } from "./lib/release";
import { appVersion } from "@kiteline/shared/protocol";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ReleaseNotice } from "./components/release-notice";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";

export interface LoginSession {
  expiresAt: string;
}

export function Auth({ initialized, onLogin }: { initialized: boolean; onLogin: () => void }) {
  const { t, i18n } = useTranslation();
  const version = useServerVersion() ?? appVersion;
  const chinese = i18n.language.startsWith("zh");
  const recoveryGuide = `https://github.com/Azure99/kiteline/blob/v${version}/docs/guide/server${chinese ? "" : ".en"}.md#${chinese ? "重置初始化-token-与密码" : "reset-the-setup-token-or-password"}`;
  const recoveryTitle = initialized
    ? t(($) => $.auth.resetPassword)
    : t(($) => $.auth.newSetupToken);
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
      onLogin();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flex min-h-[var(--viewport-height)] items-center justify-center bg-muted px-6 py-12">
      <div className="w-full max-w-80">
        <ReleaseNotice />
        <div className="mb-9 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded bg-primary text-primary-foreground">
            <Terminal size={22} />
          </span>
          <h1 className="text-xl font-semibold">Kiteline</h1>
          <div className="ml-auto flex">
            <AppearanceMenu />
            <LanguageMenu />
          </div>
        </div>
        <h2 className="mb-6 text-lg font-medium">
          {initialized ? t(($) => $.auth.login) : t(($) => $.auth.ownerSetup)}
        </h2>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          {!initialized && (
            <div className="space-y-2">
              <label className="block space-y-2">
                <span className="block">{t(($) => $.auth.setupToken)}</span>
                <Input
                  name="setupToken"
                  required
                  autoComplete="off"
                  autoFocus
                  aria-describedby="setup-token-help"
                />
              </label>
              <p id="setup-token-help" className="text-xs text-muted-foreground">
                {t(($) => $.auth.setupTokenHelp)}
              </p>
            </div>
          )}
          <div className="space-y-2">
            <label className="block space-y-2">
              <span className="block">{t(($) => $.auth.password)}</span>
              <Input
                name="password"
                type="password"
                required
                autoComplete={initialized ? "current-password" : "new-password"}
                autoFocus={initialized}
                aria-describedby="password-help"
              />
            </label>
            <p id="password-help" className="text-xs text-muted-foreground">
              {t(($) => $.auth.passwordHelp)}
            </p>
          </div>
          {!!error && (
            <div role="alert" className="text-sm text-destructive">
              <ErrorNotice error={error} context={initialized ? "login" : undefined} />
            </div>
          )}
          <Button type="submit" disabled={busy} className="w-full">
            {busy
              ? t(($) => $.common.processing)
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
            {recoveryTitle}
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{recoveryTitle}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 overflow-auto p-5 text-sm">
              <p>{t(($) => $.auth.recoveryCommand)}</p>
              <pre className="overflow-auto rounded bg-muted p-3">
                {initialized ? "kiteline-server reset-password" : "kiteline-server setup-token"}
              </pre>
              <p>{t(($) => $.auth.restart)}</p>
              <a
                href={recoveryGuide}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-primary underline underline-offset-4"
              >
                {t(($) => $.auth.recoveryGuide)}
              </a>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  );
}
