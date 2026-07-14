// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs the shared test setup.
import "../../test/setup.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createStore, Provider as JotaiProvider } from "jotai";
import { type PropsWithChildren, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { localeAtom, type Locale } from "../../state/locale.js";
import { createTestQueryClient } from "../../test/render.js";
import { type CapabilityCollection } from "./capability.js";
import {
  ThreadView,
  type ThreadContext,
  type ThreadPost,
  type ThreadRenderContext,
} from "./thread-view.js";

interface TestPost extends ThreadPost {
  readonly label: string;
}

function post(id: string, label: string): TestPost {
  return { ref: { id }, label };
}

function renderPost(value: TestPost, context: ThreadRenderContext): ReactElement {
  return (
    <span>
      {context.relation}:{value.label}:depth-{context.maxQuoteDepth}
    </span>
  );
}

function renderThread(options: {
  readonly current: TestPost;
  readonly loadContext: (id: string) => Promise<ThreadContext<TestPost>>;
  readonly capabilities?: CapabilityCollection;
  readonly locale?: Locale;
}): void {
  const client = createTestQueryClient();
  const store = createStore();
  const locale = options.locale;
  function Wrapper({ children }: PropsWithChildren): ReactElement {
    return (
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </JotaiProvider>
    );
  }
  render(
    <ThreadView
      {...options}
      capabilities={options.capabilities ?? [{ name: "posts.context", status: "supported" }]}
      renderPost={renderPost}
    />,
    { wrapper: Wrapper },
  );
  if (locale !== undefined) act(() => store.set(localeAtom, locale));
}

describe("ThreadView", () => {
  it("uses localized conversation labels while preserving an exact capability reason", () => {
    const reason = "Remote policy prevents context lookup.";
    const loadContext = vi.fn(async () => ({ ancestors: [], descendants: [] }));
    renderThread({
      capabilities: [{ name: "posts.context", reason, status: "unsupported" }],
      current: post("opaque/current", "Current"),
      loadContext,
      locale: "ko",
    });

    const show = screen.getByRole("button", { name: "대화 보기" });
    expect(show).toHaveAccessibleDescription(reason);
    expect(screen.getByRole("region", { name: "대화" })).toBeVisible();
  });

  it("loads opaque post context only after activation and renders thread order", async () => {
    const user = userEvent.setup();
    const current = post("post/opaque?part=#current", "Current");
    const loadContext = vi.fn(async () => ({
      ancestors: [post("ancestor/one", "Ancestor one"), post("ancestor/two", "Ancestor two")],
      descendants: [post("descendant/one", "Descendant one")],
    }));
    renderThread({ current, loadContext });

    expect(loadContext).not.toHaveBeenCalled();
    expect(screen.getByText("current:Current:depth-1")).toBeVisible();

    const show = screen.getByRole("button", { name: "Show conversation" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    await user.click(show);

    await waitFor(() =>
      expect(loadContext).toHaveBeenCalledWith(current.ref.id, expect.any(AbortSignal)),
    );
    expect(show).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "ancestor:Ancestor one:depth-1",
      "ancestor:Ancestor two:depth-1",
      "current:Current:depth-1",
      "descendant:Descendant one:depth-1",
    ]);
  });

  it("announces context errors and retries through the injected port", async () => {
    const user = userEvent.setup();
    const current = post("opaque/thread/id", "Current");
    const loadContext = vi
      .fn<(id: string) => Promise<ThreadContext<TestPost>>>()
      .mockRejectedValueOnce(new Error("Conversation is temporarily unavailable."))
      .mockResolvedValueOnce({
        ancestors: [],
        descendants: [post("opaque/descendant", "Recovered descendant")],
      });
    renderThread({ current, loadContext });

    await user.click(screen.getByRole("button", { name: "Show conversation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Conversation is temporarily unavailable.",
    );

    await user.click(screen.getByRole("button", { name: "Retry conversation" }));

    await waitFor(() => expect(loadContext).toHaveBeenCalledTimes(2));
    expect(screen.getByText("descendant:Recovered descendant:depth-1")).toBeVisible();
  });

  it("keeps unsupported context explicit and never calls the port", async () => {
    const user = userEvent.setup();
    const loadContext = vi.fn(async () => ({ ancestors: [], descendants: [] }));
    renderThread({
      capabilities: [
        {
          name: "posts.context",
          reason: "Conversation lookup is unavailable.",
          status: "unsupported",
        },
      ],
      current: post("opaque/current", "Current"),
      loadContext,
    });

    const show = screen.getByRole("button", { name: "Show conversation" });
    expect(show).toBeDisabled();
    expect(show).toHaveAccessibleDescription("Conversation lookup is unavailable.");
    expect(screen.getByText("Conversation lookup is unavailable.")).toBeVisible();
    await user.click(show);
    expect(loadContext).not.toHaveBeenCalled();
  });
});
