import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, RefreshCw, Terminal } from "lucide-react";
import type { Device, Session } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Input } from "../components/ui/input";
import { ErrorNotice } from "../components/error-notice";
import { workspacePath } from "../lib/navigation";

export interface SessionObservation {
  sessions: Session[];
  observedAt: string;
}

export function SessionFinder({
  device,
  observation,
  error,
  busy,
  onRefresh,
  onNavigate,
}: {
  device: Device;
  observation?: SessionObservation;
  error?: unknown;
  busy: boolean;
  onRefresh(): void;
  onNavigate(path: string): void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const contentId = useId();
  const workspaces = new Map(
    device.snapshot?.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const matches = observation?.sessions.filter((session) => {
    const workspace = workspaces.get(session.workspaceId);
    return [session.name, session.id, workspace?.name, workspace?.path]
      .join("\n")
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase());
  });
  return (
    <section className="mb-5 border-y border-border py-2">
      <div className="flex items-center justify-between gap-1">
        <Button
          variant="ghost"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
        >
          <Terminal />
          {t(($) => $.devices.existingSessions)}
          {observation && (
            <span>({observation.sessions.length.toLocaleString(i18n.resolvedLanguage)})</span>
          )}
          {open ? <ChevronDown /> : <ChevronRight />}
        </Button>
        <IconButton
          label={t(($) => $.terminal.refreshSessions)}
          disabled={busy || device.status !== "online"}
          onClick={onRefresh}
        >
          <RefreshCw />
        </IconButton>
      </div>
      <p className="mb-2 break-all text-xs text-muted-foreground">
        {t(($) => $.devices.deviceIdentity, { id: device.id })}
      </p>
      <div role="status" className="mb-2 break-words text-xs text-muted-foreground">
        {observation ? (
          <>
            {device.status !== "online" ? (
              <p>{t(($) => $.devices.sessionsOffline)}</p>
            ) : busy ? (
              <p>{t(($) => $.devices.sessionsRefreshing)}</p>
            ) : error ? (
              <p>{t(($) => $.devices.sessionsStale)}</p>
            ) : null}
            <p>
              {t(($) => $.devices.sessionsObserved, {
                time: new Date(observation.observedAt).toLocaleString(i18n.resolvedLanguage),
              })}
            </p>
          </>
        ) : busy ? (
          t(($) => $.devices.sessionsLoading)
        ) : (
          t(($) => $.devices.sessionsUnknown)
        )}
      </div>
      {!!error && (
        <div role="alert" className="mb-2 break-words text-xs text-destructive">
          {busy && <p>{t(($) => $.devices.previousReadFailed)}</p>}
          <ErrorNotice error={error} />
        </div>
      )}
      {open && (
        <div id={contentId}>
          <Input
            aria-label={t(($) => $.devices.filterSessions)}
            placeholder={t(($) => $.devices.filterSessionsHint)}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {observation && matches?.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              {observation.sessions.length === 0
                ? t(($) => $.devices.noObservedSessions)
                : t(($) => $.devices.noMatchingSessions)}
            </p>
          )}
          <div className="mt-2 divide-y divide-border border-t border-border">
            {matches?.map((session) => {
              const workspace = workspaces.get(session.workspaceId);
              return (
                <button
                  key={session.id}
                  disabled={!workspace || device.status !== "online"}
                  onClick={() =>
                    onNavigate(
                      workspacePath(device.id, session.workspaceId, "terminal", {
                        session: session.id,
                      }),
                    )
                  }
                  className="flex min-h-14 w-full items-start gap-2 py-3 text-left hover:bg-muted disabled:opacity-60"
                >
                  <Terminal size={16} className="mt-1 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium">{session.name}</span>
                    <span className="block break-words text-xs text-muted-foreground">
                      {workspace?.name ?? t(($) => $.devices.sessionWorkspaceUnavailable)}
                    </span>
                    <span className="block break-all text-xs text-muted-foreground">
                      {workspace?.path ?? session.workspaceId}
                    </span>
                    <span className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">
                      {session.id}
                    </span>
                  </span>
                  <ChevronRight size={16} className="mt-1 shrink-0" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
