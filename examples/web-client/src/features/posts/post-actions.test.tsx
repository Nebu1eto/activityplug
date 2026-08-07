// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs the shared test setup.
import "../../test/setup.ts";
import { QueryClientProvider, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createStore, Provider as JotaiProvider } from "jotai";
import { type PropsWithChildren, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { localeAtom, type Locale } from "../../state/locale.js";
import { createTestQueryClient } from "../../test/render.js";
import { type CapabilityCollection } from "./capability.js";
import {
  PostActions,
  type ActionablePost,
  type PostActionInput,
  type PostActionResponse,
} from "./post-actions.js";

interface TestPost extends ActionablePost {
  readonly label: string;
}

const supportedCapabilities: CapabilityCollection = {
  capabilities: [
    { name: "posts.reply", status: "supported" },
    { name: "posts.quote", status: "supported" },
    { name: "social.favourite", status: "supported" },
    { name: "social.boost", status: "supported" },
    { name: "social.bookmark", status: "supported" },
    { name: "social.reaction", status: "supported" },
  ],
};

function post(overrides: Partial<TestPost> = {}): TestPost {
  return {
    ref: { id: "post/opaque?part=#one", type: "post" },
    label: "A post",
    viewerState: {
      favourited: false,
      boosted: false,
      bookmarked: false,
      reactions: [],
    },
    ...overrides,
  };
}

function queryClient(): QueryClient {
  return createTestQueryClient();
}

function renderActions(
  options: {
    readonly value?: TestPost;
    readonly capabilities?: CapabilityCollection;
    readonly actOnPost?: (
      id: string,
      input: PostActionInput,
    ) => Promise<PostActionResponse<TestPost>>;
    readonly client?: QueryClient;
    readonly onQuote?: (id: string) => void;
    readonly onReply?: (id: string) => void;
    readonly locale?: Locale;
  } = {},
): QueryClient {
  const client = options.client ?? queryClient();
  const store = createStore();
  const locale = options.locale;
  const value = options.value ?? post();
  const actOnPost =
    options.actOnPost ??
    (async () => {
      return { post: value };
    });

  function Wrapper({ children }: PropsWithChildren): ReactElement {
    return (
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </JotaiProvider>
    );
  }

  render(
    <PostActions
      actOnPost={actOnPost}
      capabilities={options.capabilities ?? supportedCapabilities}
      onQuote={options.onQuote ?? (() => undefined)}
      onReply={options.onReply ?? (() => undefined)}
      post={value}
    />,
    { wrapper: Wrapper },
  );
  if (locale !== undefined) act(() => store.set(localeAtom, locale));
  return client;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function findPost(value: unknown, id: string): TestPost | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPost(item, id);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const ref = record["ref"];
  if (
    typeof ref === "object" &&
    ref !== null &&
    (ref as Readonly<Record<string, unknown>>)["id"] === id &&
    (ref as Readonly<Record<string, unknown>>)["type"] === "post"
  ) {
    return value as TestPost;
  }
  for (const child of Object.values(record)) {
    const found = findPost(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe("PostActions", () => {
  it("localizes controls while preserving an exact server capability reason", () => {
    const reason = "Remote policy says no reactions.";
    renderActions({
      locale: "ja",
      capabilities: {
        capabilities: [
          ...supportedCapabilities.capabilities.filter(
            (capability) => capability.name !== "social.reaction",
          ),
          { name: "social.reaction", status: "unsupported", reason },
        ],
      },
    });

    expect(screen.getByRole("button", { name: "お気に入り" })).toBeVisible();
    const react = screen.getByRole("button", { name: "リアクション" });
    expect(react).toHaveAccessibleDescription(reason);
    expect(react).not.toHaveAttribute("title");
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("disables unsupported reactions with the server-provided reason", () => {
    renderActions({
      capabilities: {
        capabilities: [
          ...supportedCapabilities.capabilities.filter(
            (capability) => capability.name !== "social.reaction",
          ),
          {
            name: "social.reaction",
            status: "unsupported",
            reason: "This server has no emoji reactions.",
          },
        ],
      },
    });

    const button = screen.getByRole("button", { name: "React" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAccessibleDescription("This server has no emoji reactions.");
    expect(button).not.toHaveAttribute("title");
    expect(screen.getByText("This server has no emoji reactions.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Reaction" })).not.toBeInTheDocument();
  });

  it("shows and hides an unsupported action tooltip on hover and focus", async () => {
    const user = userEvent.setup();
    const reason = "Replies are unavailable on this server.";
    renderActions({
      capabilities: {
        capabilities: [
          ...supportedCapabilities.capabilities.filter(
            (capability) => capability.name !== "posts.reply",
          ),
          { name: "posts.reply", status: "unsupported", reason },
        ],
      },
    });

    const reply = screen.getByRole("button", { name: "Reply" });
    expect(reply).toHaveAttribute("aria-disabled", "true");
    expect(reply).not.toBeDisabled();
    expect(reply).toHaveAccessibleDescription(reason);
    expect(reply).not.toHaveAttribute("title");

    const tooltip = screen.getByText(reason);
    expect(tooltip).toHaveAttribute("role", "tooltip");
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveAttribute("data-visible", "false");
    vi.spyOn(reply, "getBoundingClientRect").mockReturnValue({
      bottom: 132,
      height: 32,
      left: 120,
      right: 152,
      top: 100,
      width: 32,
      x: 120,
      y: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(tooltip, "getBoundingClientRect").mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 256,
      top: 0,
      width: 256,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    await user.hover(reply);
    expect(tooltip).toHaveAttribute("data-visible", "true");
    expect(tooltip).toHaveStyle({ left: "120px" });
    await user.unhover(reply);
    expect(tooltip).toHaveAttribute("data-visible", "false");

    fireEvent.focus(reply);
    expect(tooltip).toHaveAttribute("data-visible", "true");
    fireEvent.blur(reply);
    expect(tooltip).toHaveAttribute("data-visible", "false");
  });

  it("forwards opaque IDs unchanged to reply and quote integration callbacks", async () => {
    const user = userEvent.setup();
    const value = post();
    const actOnPost = vi.fn(async () => ({ post: value }));
    const onQuote = vi.fn();
    const onReply = vi.fn();
    renderActions({ actOnPost, onQuote, onReply, value });

    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.click(screen.getByRole("button", { name: "Quote" }));

    expect(onReply).toHaveBeenCalledWith(value.ref.id);
    expect(onQuote).toHaveBeenCalledWith(value.ref.id);
    expect(actOnPost).not.toHaveBeenCalled();
  });

  it("optimistically updates every cached copy and invalidates affected queries", async () => {
    const user = userEvent.setup();
    const value = post({ ref: { id: "post/opaque?part=#one", type: "post" } });
    const updated = post({ viewerState: { ...value.viewerState, favourited: true } });
    const result = deferred<PostActionResponse<TestPost>>();
    const actOnPost = vi.fn(() => result.promise);
    const client = queryClient();
    const keys: readonly QueryKey[] = [
      ["timeline", "home"],
      ["search", "cats"],
      ["profile", "person/opaque"],
      ["post", value.ref.id],
      ["context", "thread/opaque"],
    ];
    client.setQueryData(keys[0], { pages: [{ posts: [value] }] });
    client.setQueryData(keys[1], { posts: [value] });
    client.setQueryData(keys[2], { profile: { posts: [value] } });
    client.setQueryData(keys[3], { post: value });
    client.setQueryData(keys[4], { ancestors: [value], descendants: [] });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderActions({ actOnPost, client, value });

    await user.click(screen.getByRole("button", { name: "Favourite" }));

    await waitFor(() => {
      expect(actOnPost).toHaveBeenCalledWith(value.ref.id, {
        enabled: true,
        kind: "favourite",
      });
      for (const key of keys) {
        expect(findPost(client.getQueryData(key), value.ref.id)).toMatchObject({
          viewerState: { favourited: true },
        });
      }
    });

    result.resolve({ post: updated });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    for (const key of keys) {
      expect(findPost(client.getQueryData(key), value.ref.id)).toEqual(updated);
    }
  });

  it("does not treat a non-post reference with the same raw ID as the target", async () => {
    const user = userEvent.setup();
    const value = post();
    const collision = {
      label: "Account with a colliding ID",
      ref: { id: value.ref.id, type: "account" },
      viewerState: { favourited: false },
    };
    const client = queryClient();
    const key = ["timeline", "home"] as const;
    client.setQueryData(key, { account: collision, posts: [value] });
    const result = deferred<PostActionResponse<TestPost>>();
    renderActions({ actOnPost: () => result.promise, client, value });

    await user.click(screen.getByRole("button", { name: "Favourite" }));

    await waitFor(() =>
      expect(findPost(client.getQueryData(key), value.ref.id)).toMatchObject({
        viewerState: { favourited: true },
      }),
    );
    expect((client.getQueryData(key) as { readonly account: typeof collision }).account).toEqual(
      collision,
    );
  });

  it("rolls back optimistic state and announces the server error", async () => {
    const user = userEvent.setup();
    const value = post();
    const result = deferred<PostActionResponse<TestPost>>();
    const client = queryClient();
    const key = ["timeline", "home"] as const;
    client.setQueryData(key, { posts: [value] });
    renderActions({
      actOnPost: () => result.promise,
      client,
      value,
    });

    await user.click(screen.getByRole("button", { name: "Favourite" }));
    await waitFor(() => {
      expect(findPost(client.getQueryData(key), value.ref.id)).toMatchObject({
        viewerState: { favourited: true },
      });
    });

    result.reject(new Error("The remote server rejected this action."));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The remote server rejected this action.",
    );
    expect(findPost(client.getQueryData(key), value.ref.id)).toEqual(value);
  });

  it("rolls back only the target post and preserves concurrent cache changes", async () => {
    const user = userEvent.setup();
    const value = post();
    const other = post({ label: "Another post", ref: { id: "post/other", type: "post" } });
    const result = deferred<PostActionResponse<TestPost>>();
    const client = queryClient();
    const key = ["timeline", "home"] as const;
    client.setQueryData(key, { posts: [value, other] });
    renderActions({ actOnPost: () => result.promise, client, value });

    await user.click(screen.getByRole("button", { name: "Favourite" }));
    await waitFor(() =>
      expect(findPost(client.getQueryData(key), value.ref.id)).toMatchObject({
        viewerState: { favourited: true },
      }),
    );
    client.setQueryData(key, (current: unknown) => {
      if (typeof current !== "object" || current === null) return current;
      const timeline = current as { readonly posts: readonly TestPost[] };
      return {
        posts: timeline.posts.map((item) =>
          item.ref.id === other.ref.id
            ? post({
                ...item,
                viewerState: { ...item.viewerState, favourited: true },
              })
            : item,
        ),
      };
    });

    result.reject(new Error("Action failed."));

    expect(await screen.findByRole("alert")).toHaveTextContent("Action failed.");
    expect(findPost(client.getQueryData(key), value.ref.id)).toEqual(value);
    expect(findPost(client.getQueryData(key), other.ref.id)).toMatchObject({
      viewerState: { favourited: true },
    });
  });

  it.each([
    [
      "Remove favourite",
      post({ viewerState: { favourited: true } }),
      { kind: "favourite", enabled: false },
    ],
    ["Boost", post({ viewerState: { boosted: false } }), { kind: "reblog", enabled: true }],
    ["Remove boost", post({ viewerState: { boosted: true } }), { kind: "reblog", enabled: false }],
    ["Bookmark", post({ viewerState: { bookmarked: false } }), { kind: "bookmark", enabled: true }],
    [
      "Remove bookmark",
      post({ viewerState: { bookmarked: true } }),
      { kind: "bookmark", enabled: false },
    ],
  ] as const)("sends the exact %s toggle", async (label, value, expected) => {
    const user = userEvent.setup();
    const actOnPost = vi.fn(async () => ({ post: value }));
    renderActions({ actOnPost, value });

    await user.click(screen.getByRole("button", { name: label }));

    await waitFor(() => expect(actOnPost).toHaveBeenCalledWith(value.ref.id, expected));
  });

  it("requires a non-blank reaction and preserves the Unicode value", async () => {
    const user = userEvent.setup();
    const value = post();
    const actOnPost = vi.fn(async () => ({
      post: post({ viewerState: { reactions: [{ count: 1, emoji: "✨", me: true }] } }),
    }));
    renderActions({ actOnPost, value });
    const input = screen.getByRole("textbox", { name: "Reaction" });
    const button = screen.getByRole("button", { name: "React" });

    expect(button).toBeDisabled();
    fireEvent.change(input, { target: { value: "  ✨  " } });
    expect(button).toBeEnabled();
    await user.click(button);

    await waitFor(() =>
      expect(actOnPost).toHaveBeenCalledWith(value.ref.id, {
        enabled: true,
        kind: "reaction",
        reaction: "  ✨  ",
      }),
    );
  });

  it("supports removing the viewer's existing reaction", async () => {
    const user = userEvent.setup();
    const value = post({
      viewerState: { reactions: [{ count: 2, emoji: "🔥", me: true }] },
    });
    const actOnPost = vi.fn(async () => ({ post: post() }));
    renderActions({ actOnPost, value });

    await user.type(screen.getByRole("textbox", { name: "Reaction" }), "🔥");
    await user.click(screen.getByRole("button", { name: "Remove reaction" }));

    await waitFor(() =>
      expect(actOnPost).toHaveBeenCalledWith(value.ref.id, {
        enabled: false,
        kind: "reaction",
        reaction: "🔥",
      }),
    );
  });

  it("serializes same-post mutations and ignores a stale success", async () => {
    const user = userEvent.setup();
    const value = post();
    const first = deferred<PostActionResponse<TestPost>>();
    const second = deferred<PostActionResponse<TestPost>>();
    const actOnPost = vi
      .fn<(id: string, input: PostActionInput) => Promise<PostActionResponse<TestPost>>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const client = queryClient();
    const key = ["timeline", "home"] as const;
    client.setQueryData(key, { posts: [value] });
    renderActions({ actOnPost, client, value });
    renderActions({ actOnPost, client, value });
    const groups = screen.getAllByRole("group", { name: "Post actions" });

    await user.click(within(groups[0]).getByRole("button", { name: "Favourite" }));
    await user.click(within(groups[1]).getByRole("button", { name: "Bookmark" }));
    await waitFor(() =>
      expect(findPost(client.getQueryData(key), value.ref.id)).toMatchObject({
        viewerState: { bookmarked: true, favourited: true },
      }),
    );
    expect(actOnPost).toHaveBeenCalledTimes(1);

    first.resolve({
      post: post({
        label: "Stale first response",
        viewerState: { bookmarked: false, favourited: true },
      }),
    });
    await waitFor(() => expect(actOnPost).toHaveBeenCalledTimes(2));
    expect(findPost(client.getQueryData(key), value.ref.id)).toMatchObject({
      label: "A post",
      viewerState: { bookmarked: true, favourited: true },
    });

    const canonical = post({
      label: "Newest response",
      viewerState: { ...value.viewerState, bookmarked: true, favourited: true },
    });
    second.resolve({ post: canonical });
    await waitFor(() =>
      expect(findPost(client.getQueryData(key), value.ref.id)).toEqual(canonical),
    );
  });

  it("keeps newer optimistic state when an older same-post mutation rolls back", async () => {
    const user = userEvent.setup();
    const value = post();
    const first = deferred<PostActionResponse<TestPost>>();
    const second = deferred<PostActionResponse<TestPost>>();
    const actOnPost = vi
      .fn<(id: string, input: PostActionInput) => Promise<PostActionResponse<TestPost>>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const client = queryClient();
    const key = ["timeline", "home"] as const;
    client.setQueryData(key, { posts: [value] });
    renderActions({ actOnPost, client, value });
    renderActions({ actOnPost, client, value });
    const groups = screen.getAllByRole("group", { name: "Post actions" });

    await user.click(within(groups[0]).getByRole("button", { name: "Favourite" }));
    await user.click(within(groups[1]).getByRole("button", { name: "Bookmark" }));
    first.reject(new Error("The older mutation failed."));

    expect(await screen.findByRole("alert")).toHaveTextContent("The older mutation failed.");
    await waitFor(() => expect(actOnPost).toHaveBeenCalledTimes(2));
    expect(findPost(client.getQueryData(key), value.ref.id)).toMatchObject({
      viewerState: { bookmarked: true, favourited: true },
    });

    const canonical = post({
      label: "Newest response",
      viewerState: { ...value.viewerState, bookmarked: true, favourited: false },
    });
    second.resolve({ post: canonical });
    await waitFor(() =>
      expect(findPost(client.getQueryData(key), value.ref.id)).toEqual(canonical),
    );
  });
});
