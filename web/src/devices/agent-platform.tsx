import { useTranslation } from "react-i18next";

export type AgentPlatform = "linux" | "windows";

export function AgentPlatformChoice({
  value,
  onChange,
}: {
  value: AgentPlatform;
  onChange: (platform: AgentPlatform) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="flex flex-wrap items-center gap-3 text-sm">
      <legend className="mb-2 text-xs text-muted-foreground">{t(($) => $.devices.platform)}</legend>
      {(["linux", "windows"] as const).map((platform) => (
        <label key={platform} className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name="agent-platform"
            value={platform}
            checked={value === platform}
            onChange={() => onChange(platform)}
            className="size-4 accent-primary"
          />
          {platform === "linux" ? "Linux" : "Windows (PowerShell 7)"}
        </label>
      ))}
    </fieldset>
  );
}
