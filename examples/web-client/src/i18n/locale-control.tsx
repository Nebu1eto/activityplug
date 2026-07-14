import { type ChangeEvent, type ReactElement, useId } from "react";

import { isLocale, supportedLocales } from "../state/locale.js";
import { useI18n } from "./i18n.js";

/** A shared language selector that is available before and after sign-in. */
export function LocaleControl(): ReactElement {
  const localeSelectId = useId();
  const { locale, setLocale, t } = useI18n();

  const handleLocaleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const nextLocale = event.currentTarget.value;
    if (isLocale(nextLocale)) setLocale(nextLocale);
  };

  return (
    <label className="locale-control" htmlFor={localeSelectId}>
      <span>{t("locale.label")}</span>
      <select id={localeSelectId} onChange={handleLocaleChange} value={locale}>
        {supportedLocales.map((optionLocale) => (
          <option key={optionLocale} value={optionLocale}>
            {t(`locale.${optionLocale}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
