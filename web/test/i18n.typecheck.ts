import { i18n } from "../src/i18n";

i18n.t(($) => $.auth.login);
i18n.t(($) => $.shell.downloadFailed, { path: "project/a.txt", error: "original" });
i18n.t(($) => $.shell.uploadStatus, { count: 2 });
// @ts-expect-error Translation keys must exist in the static resources.
i18n.t(($) => $.auth.missingKey);
// @ts-expect-error Required interpolation values cannot be omitted.
i18n.t(($) => $.shell.downloadFailed, { path: "project/a.txt" });
