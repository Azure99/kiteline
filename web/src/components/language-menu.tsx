import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { languagePreference, setLanguagePreference, type LanguagePreference } from "../i18n";
import { IconButton } from "./icon-button";
import { Menu, MenuContent, MenuTrigger, MenuRadioGroup, MenuRadioItem } from "./ui/menu";

export function LanguageMenu() {
  const { t } = useTranslation();
  return (
    <Menu>
      <MenuTrigger render={<IconButton label={t(($) => $.common.language)} />}>
        <Languages />
      </MenuTrigger>
      <MenuContent>
        <MenuRadioGroup
          value={languagePreference()}
          onValueChange={(value) => void setLanguagePreference(value as LanguagePreference)}
        >
          <MenuRadioItem value="auto">{t(($) => $.common.browserLanguage)}</MenuRadioItem>
          <MenuRadioItem value="en">English</MenuRadioItem>
          <MenuRadioItem value="zh-CN">简体中文</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
