import { useTranslation } from "react-i18next";

export function useGitStatusLabel() {
  const { t } = useTranslation();
  const labels: Record<string, string> = {
    M: t(($) => $.git.statusModified),
    A: t(($) => $.git.statusAdded),
    D: t(($) => $.git.statusDeleted),
    R: t(($) => $.git.statusRenamed),
    C: t(($) => $.git.statusCopied),
    T: t(($) => $.git.statusTypeChanged),
    U: t(($) => $.git.statusUnmerged),
    "?": t(($) => $.git.statusUntracked),
    ".": t(($) => $.git.statusUnchanged),
    " ": t(($) => $.git.statusUnchanged),
  };
  return (status: string) => labels[status] ?? status;
}
