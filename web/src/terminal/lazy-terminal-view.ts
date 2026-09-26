import { deferredView } from "../components/deferred-view";

export const TerminalView = deferredView(async () => ({
  default: (await import("./terminal-view")).TerminalView,
}));
