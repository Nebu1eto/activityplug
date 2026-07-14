// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs the shared test setup.
import "../test/setup.ts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ProductLink,
  productRouteHref,
  parseProductLocation,
  shouldUseHistoryNavigation,
  useProductLocation,
} from "./location.js";

describe("product location", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/");
  });

  it("recognizes every product route", () => {
    expect(parseProductLocation(new URL("https://client.example/"))).toEqual({ name: "home" });
    expect(parseProductLocation(new URL("https://client.example/local"))).toEqual({
      name: "local",
    });
    expect(parseProductLocation(new URL("https://client.example/federated"))).toEqual({
      name: "federated",
    });
    expect(parseProductLocation(new URL("https://client.example/search?q=activityplug"))).toEqual({
      name: "search",
      query: "activityplug",
    });
    expect(parseProductLocation(new URL("https://client.example/profile"))).toEqual({
      name: "profile",
      id: null,
    });
    expect(parseProductLocation(new URL("https://client.example/post"))).toEqual({
      name: "post",
      id: null,
    });
  });

  it("round-trips opaque query values through URLSearchParams once", () => {
    const opaqueId = "opaque/profile+/=%25?&한글";
    const profileHref = productRouteHref({ name: "profile", id: opaqueId });
    const postHref = productRouteHref({ name: "post", id: opaqueId });

    expect(profileHref).toContain("%2F");
    expect(parseProductLocation(new URL(profileHref, "https://client.example"))).toEqual({
      name: "profile",
      id: opaqueId,
    });
    expect(parseProductLocation(new URL(postHref, "https://client.example"))).toEqual({
      name: "post",
      id: opaqueId,
    });
  });

  it("updates the hook after an unmodified same-origin link click", async () => {
    const user = userEvent.setup();
    render(<LocationProbe />);

    await user.click(screen.getByRole("link", { name: "Local" }));

    expect(screen.getByRole("status")).toHaveTextContent("local");
    expect(location.pathname).toBe("/local");
  });

  it("intercepts only unmodified same-origin primary navigation", () => {
    expect(
      shouldUseHistoryNavigation({
        href: `${location.origin}/search?q=opaque%2Bvalue`,
        button: 0,
      }),
    ).toBe(true);
    expect(
      shouldUseHistoryNavigation({
        href: `${location.origin}/search`,
        button: 0,
        metaKey: true,
      }),
    ).toBe(false);
    expect(
      shouldUseHistoryNavigation({
        href: "https://external.example/search",
        button: 0,
      }),
    ).toBe(false);
    expect(
      shouldUseHistoryNavigation({
        href: `${location.origin}/search`,
        button: 1,
      }),
    ).toBe(false);
  });
});

function LocationProbe(): ReactElement {
  const productLocation = useProductLocation();
  return (
    <>
      <ProductLink href="/local">Local</ProductLink>
      <output aria-live="polite" role="status">
        {productLocation.name}
      </output>
    </>
  );
}
