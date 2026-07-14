import { useAtom } from "jotai";
import { useCallback, useMemo } from "react";

import { localeAtom, type Locale } from "../state/locale.js";
import { type MessageKey, messages } from "./messages.js";

export type MessageValues = Readonly<Record<string, string | number>>;

export interface I18nApi {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: (key: MessageKey, values?: MessageValues) => string;
  readonly formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly formatNumber: (value: number | bigint, options?: Intl.NumberFormatOptions) => string;
}

export function useI18n(): I18nApi {
  const [locale, writeLocale] = useAtom(localeAtom);

  const setLocale = useCallback(
    (nextLocale: Locale) => {
      writeLocale(nextLocale);
    },
    [writeLocale],
  );
  const t = useCallback(
    (key: MessageKey, values?: MessageValues) => formatMessage(messages[locale][key], values),
    [locale],
  );
  const formatDate = useCallback(
    (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale, options).format(value),
    [locale],
  );
  const formatNumber = useCallback(
    (value: number | bigint, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(locale, options).format(value),
    [locale],
  );

  return useMemo(
    () => ({ locale, setLocale, t, formatDate, formatNumber }),
    [formatDate, formatNumber, locale, setLocale, t],
  );
}

export function formatMessage(message: string, values: MessageValues = {}): string {
  return message.replace(/\{([^{}]+)\}/gu, (placeholder, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });
}
