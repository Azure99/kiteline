import { i18n } from "../i18n";
import type { Draft } from "./drafts";

export function draftLabel(draft: Draft) {
  return draft.path || i18n.t(($) => $.files.untitled, { number: draft.untitled!.number });
}
