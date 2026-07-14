// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs the shared test setup.
import "../../test/setup.ts";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ProductApi } from "../../api/client.js";
import { renderApp } from "../../test/render.js";
import { BrowserPostSurface } from "./browser-post-surface.js";

describe("BrowserPostSurface", () => {
  it("keeps reserved relation identifiers on the internal opaque post route", () => {
    renderApp(
      <BrowserPostSurface
        api={{ actOnPost: vi.fn() } as unknown as ProductApi}
        capabilities={{ capabilities: [] }}
        post={{
          ref: { id: "post/current", type: "post" },
          author: { ref: { id: "account/a" }, displayName: "Alice" },
          contentHtml: "<p>Hello</p>",
          createdAt: "2020-01-01T00:00:00Z",
          sensitive: false,
          media: [],
          replyTo: { id: "post/opaque?part=#value", url: "https://remote.invalid/status/1" },
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "Reply" })).toHaveAttribute(
      "href",
      "/post?id=post%2Fopaque%3Fpart%3D%23value",
    );
  });

  it("rejects a post action response whose reference is not a post", async () => {
    const user = userEvent.setup();
    const value = {
      ref: { id: "post/current", type: "post" },
      author: { ref: { id: "account/a" }, displayName: "Alice" },
      contentHtml: "<p>Hello</p>",
      createdAt: "2020-01-01T00:00:00Z",
      sensitive: false,
      media: [],
    } as const;
    const actOnPost = vi.fn(async () => ({
      post: { ...value, ref: { ...value.ref, type: "account" } },
    }));
    renderApp(
      <BrowserPostSurface
        api={{ actOnPost } as unknown as ProductApi}
        capabilities={{
          capabilities: [
            {
              name: "social.favourite",
              status: "supported",
              reason: null,
              source: "static",
              constraints: [],
            },
          ],
        }}
        post={value}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Favourite" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Browser post reference type must be post.",
    );
  });
});
