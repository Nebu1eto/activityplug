import { atom } from "jotai";

export const supportedLocales = ["en", "ko", "ja"] as const;

export type Locale = (typeof supportedLocales)[number];

export const localeStorageKey = "activityplug.locale";

export function isLocale(value: unknown): value is Locale {
  return supportedLocales.some((locale) => locale === value);
}

export function resolveLocale(storedLocale: unknown, languages: readonly string[]): Locale {
  if (isLocale(storedLocale)) return storedLocale;

  for (const language of languages) {
    const primaryLanguage = language.split(/[-_]/u, 1)[0]?.toLowerCase();
    if (isLocale(primaryLanguage)) return primaryLanguage;
  }

  return "en";
}

export function detectLocale(): Locale {
  return resolveLocale(readStoredLocale(), readNavigatorLanguages());
}

const localeValueAtom = atom<Locale>(resolveLocale(null, readNavigatorLanguages()));

localeValueAtom.onMount = (setLocale) => {
  const locale = detectLocale();
  setLocale(locale);
  setDocumentLocale(locale);

  if (typeof window === "undefined") return undefined;
  const handleStorage = (event: StorageEvent): void => {
    if (event.key !== localeStorageKey || !isLocale(event.newValue)) return;
    setLocale(event.newValue);
    setDocumentLocale(event.newValue);
  };
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
};

export const localeAtom = atom(
  (get) => get(localeValueAtom),
  (_get, set, locale: Locale) => {
    if (!isLocale(locale)) return;
    set(localeValueAtom, locale);
    persistLocale(locale);
    setDocumentLocale(locale);
  },
);

export function setDocumentLocale(locale: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

function readStoredLocale(): string | null {
  const storage = browserStorage();
  if (storage === null) return null;
  try {
    return storage.getItem(localeStorageKey);
  } catch {
    return null;
  }
}

function persistLocale(locale: Locale): void {
  const storage = browserStorage();
  if (storage === null) return;
  try {
    storage.setItem(localeStorageKey, locale);
  } catch {
    // Storage can be disabled; the in-memory atom remains usable.
  }
}

function readNavigatorLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
