import type { Terminal } from "@xterm/xterm";
import { ApiError } from "../lib/api";
import { releasedModifiers, type Modifiers } from "./auxiliary-input";
import { TerminalDisplay, type DisplayState, type TerminalTarget } from "./display";

export interface TerminalScreenSnapshot {
  terminal?: Terminal;
  title: string;
  reading: boolean;
  modifiers: Modifiers;
  state: DisplayState;
}

interface Screen {
  host: HTMLDivElement;
  display: TerminalDisplay;
  title: string;
  reading: boolean;
  modifiers: Modifiers;
  suspended: boolean;
}

export class TerminalScreens {
  private current?: Screen;
  private candidate?: Screen;
  // Recovery feedback may belong to a failed candidate while the current screen stays readable.
  private feedback: DisplayState = { status: "connecting" };

  constructor(
    private host: HTMLElement,
    private target: TerminalTarget,
    private changed: (snapshot: TerminalScreenSnapshot) => void,
  ) {
    this.current = this.createScreen("retained", "current");
    this.publish();
  }

  get display() {
    return this.current?.display;
  }

  get connecting() {
    return !!this.candidate || this.current?.display.state.status === "connecting";
  }

  restore(history: "retained" | "screen") {
    this.feedback = { status: "connecting" };
    const previous = this.current;
    if (previous && !previous.display.terminal) {
      this.disposeScreen(previous);
      this.current = this.createScreen(history, "current");
    } else {
      if (previous && !previous.suspended) {
        previous.suspended = true;
        previous.display.retainScreen();
      }
      this.candidate = this.createScreen(history, "candidate");
    }
    this.publish();
  }

  private publish() {
    this.changed({
      terminal: this.current?.display.terminal,
      title: this.current?.title ?? "",
      reading: this.current?.reading ?? false,
      modifiers: this.current?.modifiers ?? releasedModifiers,
      state: this.feedback,
    });
  }

  private stateChanged(screen: Screen, state: DisplayState) {
    if (screen === this.candidate) {
      if (state.status === "ready") this.promote(screen, state);
      else if (state.status === "error" || state.status === "ended") this.reject(screen, state);
    } else if (screen === this.current && (!screen.suspended || state.missing)) {
      this.feedback = state;
      this.publish();
    }
  }

  private promote(screen: Screen, state: DisplayState) {
    const previous = this.current;
    this.candidate = undefined;
    this.current = screen;
    screen.host.style.visibility = "";
    this.feedback = state;
    this.publish();
    if (previous) this.disposeScreen(previous);
  }

  private reject(screen: Screen, state: DisplayState) {
    this.candidate = undefined;
    this.disposeScreen(screen);
    if (state.error instanceof ApiError && state.error.code === "not_found") {
      this.current?.display.sessionMissing();
      this.feedback = { status: "ended", missing: true };
    } else {
      this.feedback = state;
    }
    this.publish();
  }

  private createScreen(history: "retained" | "screen", role: "current" | "candidate"): Screen {
    const host = document.createElement("div");
    host.className = "terminal-canvas absolute inset-0";
    if (role === "candidate") {
      host.style.visibility = "hidden";
    }
    this.host.append(host);
    const screen: Screen = {
      host,
      title: "",
      reading: false,
      modifiers: releasedModifiers,
      suspended: false,
      display: new TerminalDisplay({
        host,
        target: this.target,
        history,
        events: {
          state: (state) => this.stateChanged(screen, state),
          opened: () => {
            if (screen === this.current) this.publish();
          },
          title: (title) => {
            if (screen.title === title) return;
            screen.title = title;
            if (screen === this.current) this.publish();
          },
          reading: (reading) => {
            if (screen.reading === reading) return;
            screen.reading = reading;
            if (screen === this.current) this.publish();
          },
          modifiers: (modifiers) => {
            screen.modifiers = modifiers;
            if (screen === this.current) this.publish();
          },
        },
      }),
    };
    return screen;
  }

  private disposeScreen(screen: Screen) {
    screen.display.dispose();
    screen.host.remove();
  }

  dispose() {
    const { current, candidate } = this;
    this.current = undefined;
    this.candidate = undefined;
    if (candidate) this.disposeScreen(candidate);
    if (current) this.disposeScreen(current);
  }
}
