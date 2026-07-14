// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs shared DOM test helpers.
import "../../test/setup.js";
import { QueryClientProvider, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type PropsWithChildren, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestQueryClient } from "../../test/render.js";
import { searchQueryKey, SearchView, type SearchApi, type SearchResponse } from "./search.js";

describe("SearchView", () => {
  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it("waits 300 ms, accepts two Unicode code points, and renders every result kind", async () => {
    vi.useFakeTimers();
    const search = vi.fn<SearchApi["search"]>(async () => response());
    renderSearch({ search });

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "한글" } });
    expect(search).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(search).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(search).toHaveBeenCalledWith("한글", "all", undefined, expect.any(AbortSignal));
    expect(screen.getByRole("link", { name: "Alice" })).toHaveAttribute(
      "href",
      "/profile?id=opaque%2Faccount%2B%2F%3D",
    );
    expect(screen.getByText("post result")).toBeVisible();
    expect(screen.getByRole("link", { name: "#activitypub" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("3 results");
  });

  it("aborts a superseded request and keeps the debounced query in the URL", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const search = vi.fn<SearchApi["search"]>((query, _type, _cursor, signal) => {
      if (signal !== undefined) signals.push(signal);
      return query === "abc" ? Promise.resolve(emptyResponse()) : new Promise(() => undefined);
    });
    window.history.replaceState(null, "", "/search");
    renderSearch({ search });

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ab" } });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(search).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "abc" } });
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(signals[0]?.aborted).toBe(true);
    expect(window.location.pathname).toBe("/search");
    expect(new URLSearchParams(window.location.search).get("q")).toBe("abc");
  });

  it("passes the opaque search cursor verbatim", async () => {
    const search = vi
      .fn<SearchApi["search"]>()
      .mockResolvedValueOnce({ ...response(), pageInfo: { nextCursor: "opaque:+/=?cursor" } })
      .mockResolvedValueOnce(emptyResponse());
    const user = userEvent.setup();
    renderSearch({ search }, "activityplug");

    await screen.findByText("post result");
    await user.click(screen.getByRole("button", { name: "Load more results" }));

    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(
        "activityplug",
        "all",
        "opaque:+/=?cursor",
        expect.any(AbortSignal),
      ),
    );
  });

  it("caps pagination at ten pages while retaining the initial page", async () => {
    const search = vi.fn<SearchApi["search"]>(async (_query, _type, pageCursor) => {
      const number =
        pageCursor === undefined ? 1 : Number(pageCursor.slice("opaque:search-".length)) + 1;
      return searchPage(`p${number}`, number === 11 ? null : `opaque:search-${number}`);
    });
    const client = createTestQueryClient();
    const user = userEvent.setup();
    renderSearch({ search }, "activityplug", {}, client);

    expect(await screen.findByText("post p1")).toBeVisible();
    for (let number = 2; number <= 10; number += 1) {
      await user.click(screen.getByRole("button", { name: "Load more results" }));
      expect(await screen.findByText(`post p${number}`)).toBeVisible();
    }

    expect(screen.queryByRole("button", { name: "Load more results" })).not.toBeInTheDocument();
    expect(search).toHaveBeenCalledTimes(10);
    expect(search).toHaveBeenLastCalledWith(
      "activityplug",
      "all",
      "opaque:search-9",
      expect.any(AbortSignal),
    );
    const data = client.getQueryData<InfiniteData<SearchResponse, string | undefined>>(
      searchQueryKey("activityplug", "all"),
    );
    expect(data?.pages.map((page) => page.posts[0]?.ref.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
    );
    expect(data?.pageParams).toEqual([
      undefined,
      ...Array.from({ length: 9 }, (_, index) => `opaque:search-${index + 1}`),
    ]);
  });

  it("selects a supported concrete type when hashtag search is unavailable", async () => {
    vi.useFakeTimers();
    const search = vi.fn<SearchApi["search"]>(async () => emptyResponse());
    renderSearch({ search }, "", {
      capabilities: {
        capabilities: [
          { name: "search.accounts", status: "supported" },
          { name: "search.posts", status: "supported" },
          {
            name: "search.hashtags",
            status: "unsupported",
            reason: "Hashtag search is unavailable.",
          },
        ],
      },
    });

    expect(screen.getByRole("radio", { name: "All" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Hashtags" })).toBeDisabled();
    expect(screen.getAllByText("Hashtag search is unavailable.")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "People" })).toBeChecked();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ab" } });
    await act(() => vi.advanceTimersByTimeAsync(300));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(search).toHaveBeenCalledWith("ab", "accounts", undefined, expect.any(AbortSignal));
  });
});

function renderSearch(
  api: SearchApi,
  initialQuery = "",
  props: Omit<Parameters<typeof SearchView>[0], "api" | "initialQuery"> = {},
  client: QueryClient = createTestQueryClient(),
): RenderResult {
  function Wrapper({ children }: PropsWithChildren): ReactElement {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<SearchView api={api} initialQuery={initialQuery} {...props} />, {
    wrapper: Wrapper,
  });
}

function searchPage(id: string, nextCursor: string | null): SearchResponse {
  return {
    ...emptyResponse(),
    posts: [
      {
        ...response().posts[0],
        ref: { id },
        contentHtml: `<p>post ${id}</p>`,
      },
    ],
    pageInfo: { nextCursor },
  };
}

function response(): SearchResponse {
  return {
    accounts: [
      {
        ref: { id: "opaque/account+/=" },
        username: "alice",
        handle: "@alice@example.test",
        displayName: "Alice",
        bot: false,
        locked: false,
      },
    ],
    posts: [
      {
        ref: { id: "opaque/post" },
        author: {
          ref: { id: "opaque/account+/=" },
          username: "alice",
          handle: "@alice@example.test",
          displayName: "Alice",
          bot: false,
          locked: false,
        },
        contentHtml: "<p>post result</p>",
        createdAt: "2026-07-12T00:00:00.000Z",
        sensitive: false,
        media: [],
      },
    ],
    hashtags: [{ name: "activitypub", history: [] }],
    pageInfo: { nextCursor: null },
  };
}

function emptyResponse(): SearchResponse {
  return { accounts: [], posts: [], hashtags: [], pageInfo: { nextCursor: null } };
}
