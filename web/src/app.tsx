import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Auth, type Session } from "./auth";
import { Button } from "./components/ui/button";
import { ErrorNotice } from "./components/error-notice";
import { deferredView } from "./components/deferred-view";
import { ApiError, api } from "./lib/api";
import { returnToService } from "./lib/login-return";

const Workbench = deferredView(async () => ({ default: (await import("./workbench")).Workbench }), {
  isolateRenderErrors: false,
});

export function App() {
  const { t } = useTranslation();
  const [session, updateSession] = useState<Session>();
  const [entered, setEntered] = useState(false);
  const [initialized, setInitialized] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const setSession = useCallback((value?: Session) => {
    updateSession(value);
    if (value) setEntered(true);
  }, []);
  const loadSession = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setSession(await api<Session>("/api/session"));
      returnToService();
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthenticated") {
        try {
          setInitialized((await api<{ initialized: boolean }>("/api/bootstrap")).initialized);
        } catch (error) {
          setError(error);
        }
      } else setError(error);
    } finally {
      setLoading(false);
    }
  }, [setSession]);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);
  useEffect(() => {
    const expire = () => setSession(undefined);
    window.addEventListener("kiteline:unauthenticated", expire);
    return () => window.removeEventListener("kiteline:unauthenticated", expire);
  }, [setSession]);
  const authentication =
    loading || error ? (
      <div className="flex h-[var(--viewport-height)] flex-col items-center justify-center gap-4 bg-muted p-5">
        <Terminal className="text-primary" />
        <div role={error ? "alert" : "status"}>
          {error ? <ErrorNotice error={error} /> : t(($) => $.common.connecting)}
        </div>
        {!!error && (
          <Button onClick={() => void loadSession()}>
            <RefreshCw />
            {t(($) => $.common.retry)}
          </Button>
        )}
      </div>
    ) : (
      <Auth
        initialized={initialized}
        onLogin={(value) => {
          setSession(value);
          setInitialized(true);
          returnToService();
        }}
      />
    );
  return entered ? (
    <Workbench session={session} setSession={setSession} authentication={authentication} />
  ) : (
    authentication
  );
}
