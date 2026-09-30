import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Info, RefreshCw, Terminal } from "lucide-react";
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
  const [details, setDetails] = useState(false);
  const contentId = useId();
  const detailsId = useId();
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
  const groups = new Map<string, Session[]>();
  for (const session of matches ?? []) {
    const group = groups.get(session.workspaceId);
    if (group) group.push(session);
    else groups.set(session.workspaceId, [session]);
  }
  const observationStatus = observation
    ? device.status !== "online"
      ? t(($) => $.devices.sessionsOffline)
      : busy
        ? t(($) => $.devices.sessionsRefreshing)
        : error
          ? t(($) => $.devices.sessionsStale)
          : undefined
    : busy
      ? t(($) => $.devices.sessionsLoading)
      : t(($) => $.devices.sessionsUnknown);
  return (
    <section className="mb-6">
      <div className="flex items-center justify-between gap-1">
        <Button
          variant="ghost"
          className="min-w-0 flex-1 justify-start px-0"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          <span className="min-w-0 whitespace-normal text-left">
            {t(($) => $.devices.existingSessions)}
          </span>
          {observation && (
            <span>({observation.sessions.length.toLocaleString(i18n.resolvedLanguage)})</span>
          )}
        </Button>
        <IconButton
          label={t(($) => $.devices.sessionObservation)}
          aria-expanded={details}
          aria-controls={detailsId}
          onClick={() => setDetails((value) => !value)}
        >
          <Info />
        </IconButton>
        <IconButton
          label={t(($) => $.terminal.refreshSessions)}
          disabled={busy || device.status !== "online"}
          onClick={onRefresh}
        >
          <RefreshCw />
        </IconButton>
      </div>
      {details && (
        <div id={detailsId} className="mb-2 space-y-1 break-all text-xs text-muted-foreground">
          <p>{t(($) => $.devices.deviceIdentity, { id: device.id })}</p>
          {observation && (
            <p>
              {t(($) => $.devices.sessionsObserved, {
                time: new Date(observation.observedAt).toLocaleString(i18n.resolvedLanguage),
              })}
            </p>
          )}
        </div>
      )}
      {observationStatus && (
        <p role="status" className="mb-2 break-words text-xs text-muted-foreground">
          {observationStatus}
        </p>
      )}
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
          <div className="mt-4 space-y-5">
            {[...groups].map(([workspaceId, sessions]) => {
              const workspace = workspaces.get(workspaceId);
              return (
                <section key={workspaceId}>
                  <h3 className="break-words text-sm font-medium">
                    {workspace?.name ?? t(($) => $.devices.sessionWorkspaceUnavailable)}
                  </h3>
                  {workspace && (
                    <p className="mb-1 break-all text-xs text-muted-foreground">{workspace.path}</p>
                  )}
                  <div className="divide-y divide-border">
                    {sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        disabled={!workspace || device.status !== "online"}
                        onOpen={() =>
                          onNavigate(
                            workspacePath(device.id, workspaceId, "terminal", {
                              session: session.id,
                            }),
                          )
                        }
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function SessionRow({
  session,
  disabled,
  onOpen,
}: {
  session: Session;
  disabled: boolean;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const status =
    session.state === "starting"
      ? t(($) => $.terminal.starting)
      : session.webStatus === "recovering"
        ? t(($) => $.terminal.recovering)
        : session.webStatus === "unavailable"
          ? t(($) => $.errors.recording_unavailable)
          : undefined;
  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          disabled={disabled}
          onClick={onOpen}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 py-2 text-left hover:bg-muted disabled:opacity-60 max-[959px]:min-h-11"
        >
          <Terminal size={16} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 break-words text-sm">
            <span className="block">{session.name}</span>
            {status && <span className="block text-xs text-muted-foreground">{status}</span>}
            {session.historyGap && (
              <span className="block text-xs text-muted-foreground">
                {t(($) => $.terminal.historyGap)}
              </span>
            )}
          </span>
          <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
        </button>
        <IconButton
          label={t(($) => $.devices.sessionDetails, { name: session.name })}
          aria-expanded={details}
          aria-controls={detailsId}
          onClick={() => setDetails((value) => !value)}
        >
          <Info />
        </IconButton>
      </div>
      {details && (
        <dl
          id={detailsId}
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 pb-3 text-xs text-muted-foreground"
        >
          <dt>{t(($) => $.devices.sessionId)}</dt>
          <dd className="break-all font-mono">{session.id}</dd>
          <dt>{t(($) => $.devices.workspaceId)}</dt>
          <dd className="break-all font-mono">{session.workspaceId}</dd>
          <dt>{t(($) => $.devices.sessionStatus)}</dt>
          <dd className="break-words">
            {session.state} / {session.webStatus}
          </dd>
          {session.webReason && (
            <dd className="col-span-2 whitespace-pre-wrap break-words">{session.webReason}</dd>
          )}
        </dl>
      )}
    </div>
  );
}
