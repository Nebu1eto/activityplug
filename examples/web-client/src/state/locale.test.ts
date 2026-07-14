// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs the shared test setup.
import "../test/setup.ts";
import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";

import { localeAtom, localeStorageKey, resolveLocale, supportedLocales } from "./locale.js";
import { installTestLocalStorage } from "./locale.test-support.js";

describe("locale state", () => {
  beforeEach(() => {
    installTestLocalStorage();
  });

  it("prefers a supported stored locale", () => {
    expect(resolveLocale("ko", ["ja-JP"])).toBe("ko");
  });

  it("uses the first supported navigator language and falls back to English", () => {
    expect(resolveLocale(null, ["fr-FR", "JA-jp", "ko-KR"])).toBe("ja");
    expect(resolveLocale("unsupported", ["fr-FR", "de-DE"])).toBe("en");
  });

  it("persists only a validated locale value", () => {
    const store = createStore();
    window.localStorage.setItem("unrelated", "preserved");

    store.set(localeAtom, "ja");

    expect(window.localStorage.getItem(localeStorageKey)).toBe("ja");
    expect(window.localStorage.getItem("unrelated")).toBe("preserved");
    expect(supportedLocales).toEqual(["en", "ko", "ja"]);
  });
});
