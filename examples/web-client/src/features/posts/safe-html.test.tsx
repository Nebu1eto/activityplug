// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs shared DOM test helpers.
import "../../test/setup.ts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SafeHtml, sanitizeRemoteHtml } from "./safe-html.js";

describe("SafeHtml", () => {
  it("removes active content, handlers, and unsafe URLs", () => {
    render(
      <SafeHtml
        html={
          '<p onclick="alert(1)">Hello<script>alert(1)</script><iframe src="https://evil.example"></iframe><a href="javascript:alert(2)">bad</a><a href="https://safe.example">safe</a></p>'
        }
      />,
    );

    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("Hello")).not.toHaveAttribute("onclick");
    expect(screen.getByText("bad")).not.toHaveAttribute("href");
    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute(
      "rel",
      "nofollow noopener noreferrer",
    );
  });

  it("retains ActivityPub-safe markup and hardens every usable link", () => {
    render(
      <SafeHtml
        html={
          '<p><span class="h-card">Hello</span> <a href="/tags/activityplug">#activityplug</a> <a href="mailto:person@example.test">@person</a></p>'
        }
      />,
    );

    expect(screen.getByText("Hello")).toHaveClass("h-card");
    expect(screen.getByRole("link", { name: "#activityplug" })).toHaveAttribute(
      "href",
      "/tags/activityplug",
    );
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "nofollow noopener noreferrer");
    }
  });

  it("fails closed for non-string HTML values", () => {
    expect(sanitizeRemoteHtml(null as unknown as string)).toBe("");
  });
});
