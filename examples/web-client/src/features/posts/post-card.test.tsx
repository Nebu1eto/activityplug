// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs shared DOM test helpers.
import "../../test/setup.ts";
import { act, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it } from "vitest";

import { localeAtom, type Locale } from "../../state/locale.js";
import { renderApp } from "../../test/render.js";
import {
  PostCard,
  type PostCardProps,
  type PostCardMedia,
  type PostCardViewModel,
} from "./post-card.js";

describe("PostCard", () => {
  it("keeps sensitive content hidden until the disclosure is activated by keyboard", async () => {
    const user = userEvent.setup();
    renderPostCard(postFixture({ summary: "Spoilers", sensitive: true }));

    expect(screen.getByText("Spoilers")).toBeVisible();
    expect(screen.queryByText("The answer is 42")).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: "Show content" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");

    await user.tab();
    expect(screen.getByRole("link", { name: "View post" })).toHaveFocus();
    await user.tab();
    expect(disclosure).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByText("The answer is 42")).toBeVisible();
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
  });

  it("renders safe mentions, hashtags, media text, and fallback media alt text", () => {
    renderPostCard(
      postFixture({
        contentHtml:
          '<p><a class="u-url mention" href="https://social.example/@alice">@alice</a> <a href="/tags/activityplug">#activityplug</a></p>',
        media: [
          imageMedia({ description: "A red fox" }),
          imageMedia({ id: "image-2", description: undefined }),
        ],
      }),
    );

    expect(screen.getByRole("link", { name: "@alice" })).toHaveAttribute(
      "rel",
      "nofollow noopener noreferrer",
    );
    expect(screen.getByRole("link", { name: "#activityplug" })).toHaveAttribute(
      "href",
      "/tags/activityplug",
    );
    expect(screen.getByRole("img", { name: "A red fox" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Media attachment" })).toBeVisible();
    expect(screen.getByRole("img", { name: "A red fox" })).toHaveClass("post-card__media-content");
    expect(screen.getByRole("list", { name: "Media attachment" })).toHaveClass("post-card__media");
  });

  it("uses the canonical router path for opaque relation IDs by default", () => {
    const opaqueId = "opaque/post+/=%25?&한글";
    renderPostCard(postFixture({ replyTo: { id: opaqueId, label: "Reply" } }));

    expect(screen.getByRole("link", { name: "Reply" })).toHaveAttribute(
      "href",
      "/post?id=opaque%2Fpost%2B%2F%3D%2525%3F%26%ED%95%9C%EA%B8%80",
    );
  });

  it("offers a keyboard-accessible canonical permalink for an opaque current post ID", async () => {
    const user = userEvent.setup();
    const opaqueId = "opaque/post+/=%25?&한글";
    renderPostCard(postFixture({ id: opaqueId }));

    const permalink = screen.getByRole("link", { name: "View post" });
    expect(permalink).toHaveAttribute(
      "href",
      "/post?id=opaque%2Fpost%2B%2F%3D%2525%3F%26%ED%95%9C%EA%B8%80",
    );
    await user.tab();
    expect(permalink).toHaveFocus();
  });

  it("does not render unsafe injected permalink targets", () => {
    renderPostCard(postFixture(), { postHref: () => "javascript:alert(1)" });

    expect(screen.queryByRole("link", { name: "View post" })).not.toBeInTheDocument();
  });

  it("keeps safe injected external permalinks isolated from product navigation", () => {
    renderPostCard(postFixture(), { postHref: () => "https://remote.example/posts/one" });

    const permalink = screen.getByRole("link", { name: "View post" });
    expect(permalink).toHaveAttribute("rel", "nofollow noopener noreferrer");
    expect(permalink).toHaveAttribute("target", "_blank");
  });

  it("uses product navigation for internal relations while keeping remote relations safe", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/local");
    renderPostCard(
      postFixture({
        replyTo: { id: "opaque/reply", label: "Reply" },
        quoteOf: {
          id: "remote-quote",
          label: "Quoted post",
          href: "https://remote.example/posts/quote",
        },
      }),
    );

    await user.click(screen.getByRole("link", { name: "Reply" }));

    expect(window.location.pathname).toBe("/post");
    expect(window.location.search).toBe("?id=opaque%2Freply");
    expect(screen.getByRole("link", { name: "Quoted post" })).toHaveAttribute(
      "rel",
      "nofollow noopener noreferrer",
    );
    expect(screen.getByRole("link", { name: "Quoted post" })).toHaveAttribute("target", "_blank");
  });

  it.each([
    ["en", "Show content", "3 replies, 4 boosts, 5 favourites"],
    ["ko", "내용 보기", "답글 3개, 부스트 4개, 즐겨찾기 5개"],
    ["ja", "内容を表示", "返信 3件、ブースト 4件、お気に入り 5件"],
  ] as const)(
    "localizes disclosure and count accessibility for %s without changing remote labels",
    (locale, disclosure, counts) => {
      renderLocalizedPostCard(
        locale,
        postFixture({
          sensitive: true,
          replyTo: { id: "opaque", label: "Remote relation label" },
          counts: { replies: 3, boosts: 4, favourites: 5 },
        }),
      );

      expect(screen.getByRole("button", { name: disclosure })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.getByLabelText(counts)).toBeVisible();
      expect(screen.getByText("Remote relation label")).toBeVisible();
    },
  );
});

function renderPostCard(post: PostCardViewModel, options: Omit<PostCardProps, "post"> = {}) {
  return renderApp(<PostCard post={post} formatTimestamp={() => "just now"} {...options} />);
}

function renderLocalizedPostCard(locale: Locale, post: PostCardViewModel): void {
  const store = createStore();
  render(
    <JotaiProvider store={store}>
      <PostCard post={post} formatTimestamp={() => "just now"} />
    </JotaiProvider>,
  );
  act(() => store.set(localeAtom, locale));
}

function postFixture(overrides: Partial<PostCardViewModel> = {}): PostCardViewModel {
  return {
    id: "post-1",
    author: { displayName: "Jane Example", avatarUrl: "https://cdn.example/avatar.png" },
    contentHtml: "<p>The answer is 42</p>",
    createdAt: "2026-07-11T01:02:03.000Z",
    sensitive: false,
    media: [],
    counts: { replies: 0, boosts: 0, favourites: 0 },
    ...overrides,
  };
}

function imageMedia(overrides: Partial<PostCardMedia> = {}): PostCardMedia {
  return {
    id: "image-1",
    kind: "image",
    url: "https://cdn.example/image.png",
    ...overrides,
  };
}
