import type { FileData } from "react-diff-view";
import { inlineDiff } from "./inline-diff";

self.onmessage = ({ data }: MessageEvent<FileData[]>) => {
  self.postMessage(data.map((file) => file.hunks.map(inlineDiff)));
};
