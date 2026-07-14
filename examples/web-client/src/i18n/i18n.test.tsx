// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs the shared test setup.
import "../test/setup.ts";
import { screen } from "@testing-library/react";
import { render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import { type ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { localeAtom, localeStorageKey } from "../state/locale.js";
import { installTestLocalStorage } from "../state/locale.test-support.js";
import { formatMessage, useI18n } from "./i18n.js";
import { messages } from "./messages.js";

describe("i18n", () => {
  beforeEach(() => {
    installTestLocalStorage();
    document.documentElement.lang = "en";
  });

  it("keeps every locale complete and non-blank", () => {
    const englishKeys = Object.keys(messages.en).toSorted();

    for (const locale of ["ko", "ja"] as const) {
      expect(Object.keys(messages[locale]).toSorted()).toEqual(englishKeys);
    }
    for (const catalog of Object.values(messages)) {
      expect(Object.values(catalog).every((message) => message.trim().length > 0)).toBe(true);
    }
  });

  it("preserves every interpolation variable across locales", () => {
    for (const key of Object.keys(messages.en) as (keyof typeof messages.en)[]) {
      const expectedVariables = interpolationVariables(messages.en[key]);
      expect(interpolationVariables(messages.ko[key])).toEqual(expectedVariables);
      expect(interpolationVariables(messages.ja[key])).toEqual(expectedVariables);
    }
  });

  it("interpolates values without interpreting opaque text", () => {
    expect(
      formatMessage(messages.en["composer.altText"], {
        filename: "opaque:+/=?{value}",
      }),
    ).toBe("Alt text for opaque:+/=?{value}");
  });

  it("updates the document language and persistent locale", async () => {
    const user = userEvent.setup();
    const store = createStore();
    store.set(localeAtom, "ko");
    render(
      <Provider store={store}>
        <I18nProbe />
      </Provider>,
    );

    expect(screen.getByText("홈")).toBeVisible();
    expect(document.documentElement).toHaveAttribute("lang", "ko");

    await user.click(screen.getByRole("button", { name: "Japanese" }));

    expect(screen.getByText("ホーム")).toBeVisible();
    expect(document.documentElement).toHaveAttribute("lang", "ja");
    expect(window.localStorage.getItem(localeStorageKey)).toBe("ja");
  });
});

function I18nProbe(): ReactElement {
  const { setLocale, t } = useI18n();
  return (
    <>
      <span>{t("nav.home")}</span>
      <button onClick={() => setLocale("ja")} type="button">
        Japanese
      </button>
    </>
  );
}

function interpolationVariables(message: string): string[] {
  return [...message.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]).toSorted();
}
