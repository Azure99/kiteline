import { i18n } from "../i18n";

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes.toLocaleString(i18n.resolvedLanguage)} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toLocaleString(i18n.resolvedLanguage, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KiB`;
  return `${(bytes / 1024 / 1024).toLocaleString(i18n.resolvedLanguage, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MiB`;
}
