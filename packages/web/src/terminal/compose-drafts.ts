import { rpc } from "../lib/api";

interface ComposeTarget {
  deviceId: string;
  workspaceId: string;
  sessionId: string;
}

interface DraftState {
  text: string;
  sending: boolean;
  error?: unknown;
}

class ComposeDraft {
  private state: DraftState = { text: "", sending: false };
  private listeners = new Set<() => void>();
  selection: [number, number] = [0, 0];

  constructor(private target: ComposeTarget) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  snapshot = () => this.state;

  private publish(state: DraftState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  setText(text: string, selection = this.selection) {
    this.selection = selection;
    this.publish({ ...this.state, text });
  }

  insert(value: string) {
    const [start, end] = this.selection;
    const position = start + value.length;
    this.setText(this.state.text.slice(0, start) + value + this.state.text.slice(end), [
      position,
      position,
    ]);
  }

  async send(enter: boolean) {
    const text = this.state.text;
    if (!text || this.state.sending) return false;
    this.publish({ ...this.state, sending: true, error: undefined });
    try {
      // Not tied to the panel: closing it must not abandon input tmux may already have received.
      const { deviceId, workspaceId, sessionId } = this.target;
      await rpc(deviceId, "sessions.send", {
        workspaceId,
        sessionId,
        input: { type: "paste", text, enter },
      });
      // Edits made while the request was in flight belong to the next input.
      if (this.state.text === text) this.setText("", [0, 0]);
      this.publish({ ...this.state, sending: false });
      return true;
    } catch (error) {
      this.publish({ ...this.state, sending: false, error });
      return false;
    }
  }
}

export class ComposeDrafts {
  private drafts = new Map<string, ComposeDraft>();

  get(target: ComposeTarget) {
    const key = `${target.deviceId}/${target.sessionId}`;
    let draft = this.drafts.get(key);
    if (!draft) {
      draft = new ComposeDraft(target);
      this.drafts.set(key, draft);
    }
    return draft;
  }

  clear() {
    this.drafts.clear();
  }
}
