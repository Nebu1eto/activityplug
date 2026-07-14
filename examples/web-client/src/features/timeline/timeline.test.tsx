// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs shared DOM test helpers.
import "../../test/setup.js";
import { QueryClientProvider, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type PropsWithChildren, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { createTestQueryClient } from "../../test/render.js";
import { timelineQueryKey, type TimelineApi, type TimelinePage } from "./queries.js";
import { Timeline } from "./timeline.js";

describe("Timeline", () => {
  it("passes the upstream opaque cursor verbatim and appends the next page", async () => {
    const api = apiFixture()
      .page("home", undefined, page([post("p1")], "opaque:+/=?cursor"))
      .page("home", "opaque:+/=?cursor", page([post("p2")], null));
    const user = userEvent.setup();

    renderTimeline(api.value, "home");

    expect(await screen.findByText("post p1")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load more posts" }));
    expect(await screen.findByText("post p2")).toBeVisible();
    expect(api.timeline).toHaveBeenLastCalledWith(
      "home",
      "opaque:+/=?cursor",
      expect.any(AbortSignal),
    );
  });

  it("caps pagination at ten pages while retaining the initial page", async () => {
    const api = apiFixture();
    for (let number = 1; number <= 11; number += 1) {
      api.page(
        "home",
        number === 1 ? undefined : cursor(number - 1),
        page([post(`p${number}`)], number === 11 ? null : cursor(number)),
      );
    }
    const user = userEvent.setup();
    const client = renderTimeline(api.value, "home");

    expect(await screen.findByText("post p1")).toBeVisible();
    for (let number = 2; number <= 10; number += 1) {
      await user.click(screen.getByRole("button", { name: "Load more posts" }));
      expect(await screen.findByText(`post p${number}`)).toBeVisible();
    }

    expect(screen.queryByRole("button", { name: "Load more posts" })).not.toBeInTheDocument();
    expect(api.timeline).toHaveBeenCalledTimes(10);
    expect(api.timeline).toHaveBeenLastCalledWith("home", cursor(9), expect.any(AbortSignal));
    const data = client.getQueryData<InfiniteData<TimelinePage, string | undefined>>(
      timelineQueryKey("home"),
    );
    expect(data?.pages.map((resultPage) => resultPage.posts[0]?.ref.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
    );
    expect(data?.pageParams).toEqual([
      undefined,
      ...Array.from({ length: 9 }, (_, index) => cursor(index + 1)),
    ]);
  });

  it("retries one failed request only after user activation", async () => {
    const timeline = vi
      .fn<TimelineApi["timeline"]>()
      .mockRejectedValueOnce(new Error("The server is temporarily unavailable."))
      .mockResolvedValueOnce(page([post("recovered")], null));
    const user = userEvent.setup();

    renderTimeline({ timeline }, "federated");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server is temporarily unavailable.",
    );
    expect(timeline).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Retry timeline" }));
    expect(await screen.findByText("post recovered")).toBeVisible();
    expect(timeline).toHaveBeenCalledTimes(2);
  });

  it("routes timeline authors with opaque IDs through the product profile route", async () => {
    const opaqueAccountId = "opaque/account+/=%25?&한글";
    const api = apiFixture().page(
      "home",
      undefined,
      page(
        [
          {
            ...post("author-route"),
            author: {
              ref: { id: opaqueAccountId },
              displayName: "Opaque account",
              url: "https://remote.example/@opaque",
            },
          },
        ],
        null,
      ),
    );

    renderTimeline(api.value, "home");

    expect(
      await screen.findByRole("link", { name: "Post author: Opaque account" }),
    ).toHaveAttribute("href", "/profile?id=opaque%2Faccount%2B%2F%3D%2525%3F%26%ED%95%9C%EA%B8%80");
  });

  it("keeps home local and federated caches independent", async () => {
    const timeline = vi.fn<TimelineApi["timeline"]>(async (kind) => page([post(kind)], null));
    const client = createTestQueryClient();
    function Wrapper({ children }: PropsWithChildren): ReactElement {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const result = render(<Timeline api={{ timeline }} kind="home" />, { wrapper: Wrapper });
    expect(await screen.findByText("post home")).toBeVisible();
    result.rerender(<Timeline api={{ timeline }} kind="local" />);
    expect(await screen.findByText("post local")).toBeVisible();
    result.rerender(<Timeline api={{ timeline }} kind="federated" />);
    expect(await screen.findByText("post federated")).toBeVisible();

    await waitFor(() => expect(timeline).toHaveBeenCalledTimes(3));
    expect(client.getQueryData(timelineQueryKey("home"))).toBeDefined();
    expect(client.getQueryData(timelineQueryKey("local"))).toBeDefined();
    expect(client.getQueryData(timelineQueryKey("federated"))).toBeDefined();
  });
});

function renderTimeline(
  api: TimelineApi,
  kind: "home" | "local" | "federated",
  labels: Parameters<typeof Timeline>[0]["labels"] = {},
): QueryClient {
  const client = createTestQueryClient();
  function Wrapper({ children }: PropsWithChildren): ReactElement {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<Timeline api={api} kind={kind} labels={labels} />, { wrapper: Wrapper });
  return client;
}

function cursor(pageNumber: number): string {
  return `opaque:+/=?cursor-${pageNumber}`;
}

function page(posts: TimelinePage["posts"], nextCursor: string | null): TimelinePage {
  return { pageInfo: { nextCursor }, posts };
}

function post(id: string): TimelinePage["posts"][number] {
  return {
    ref: { id },
    author: { ref: { id: `author-${id}` }, displayName: `Author ${id}` },
    contentHtml: `<p>post ${id}</p>`,
    createdAt: "2026-07-12T00:00:00.000Z",
    sensitive: false,
    media: [],
  };
}

function apiFixture(): {
  readonly value: TimelineApi;
  readonly timeline: ReturnType<typeof vi.fn<TimelineApi["timeline"]>>;
  readonly page: (
    kind: "home" | "local" | "federated",
    pageCursor: string | undefined,
    response: TimelinePage,
  ) => ReturnType<typeof apiFixture>;
} {
  const responses = new Map<string, TimelinePage>();
  const timeline = vi.fn<TimelineApi["timeline"]>(async (kind, pageCursor) => {
    const response = responses.get(`${kind}\u0000${pageCursor ?? ""}`);
    if (response === undefined) throw new Error("Unexpected timeline request.");
    return response;
  });
  const fixture = {
    value: { timeline },
    timeline,
    page(
      kind: "home" | "local" | "federated",
      pageCursor: string | undefined,
      response: TimelinePage,
    ) {
      responses.set(`${kind}\u0000${pageCursor ?? ""}`, response);
      return fixture;
    },
  };
  return fixture;
}
