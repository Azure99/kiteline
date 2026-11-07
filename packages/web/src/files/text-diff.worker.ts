import { diff } from "@codemirror/merge";

self.onmessage = ({ data: [before, after] }: MessageEvent<[string, string]>) => {
  self.postMessage(diff(before, after));
};
