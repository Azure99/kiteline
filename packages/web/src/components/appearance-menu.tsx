import { SunMoon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppearance, setAppearance, type Appearance } from "../lib/appearance";
import { IconButton } from "./icon-button";
import { Menu, MenuContent, MenuTrigger, MenuRadioGroup, MenuRadioItem } from "./ui/menu";

export function AppearanceOptions() {
  const { t } = useTranslation();
  const value = useAppearance();
  return (
    <MenuRadioGroup
      aria-label={t(($) => $.common.appearance)}
      value={value}
      onValueChange={(value) => setAppearance(value as Appearance)}
    >
      <MenuRadioItem value="system">{t(($) => $.common.systemAppearance)}</MenuRadioItem>
      <MenuRadioItem value="light">{t(($) => $.common.lightAppearance)}</MenuRadioItem>
      <MenuRadioItem value="dark">{t(($) => $.common.darkAppearance)}</MenuRadioItem>
    </MenuRadioGroup>
  );
}

export function AppearanceMenu() {
  const { t } = useTranslation();
  return (
    <Menu>
      <MenuTrigger render={<IconButton label={t(($) => $.common.appearance)} />}>
        <SunMoon />
      </MenuTrigger>
      <MenuContent>
        <AppearanceOptions />
      </MenuContent>
    </Menu>
  );
}
