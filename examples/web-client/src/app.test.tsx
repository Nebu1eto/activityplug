// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs the shared test setup.
import "./test/setup.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ProductApi } from "./api/client.js";
import { WebApiError } from "./api/http.js";
import { App } from "./app.js";
import { renderApp } from "./test/render.js";

const authenticatedSession = {
  authenticated: true as const,
  csrfToken: "csrf",
  adapter: "mastodon",
  origin: "https://example.test",
  strategy: "oauth",
  account: {
    ref: {
      id: "account/opaque?x=1",
      type: "account",
      adapter: "mastodon",
      origin: "https://example.test",
    },
    username: "alice",
    handle: "@alice@example.test",
    displayName: "Alice",
    bot: false,
    locked: false,
    fields: [],
  },
  capabilities: { capabilities: [] },
};

function api(session: unknown = authenticatedSession): ProductApi {
  return {
    session: vi.fn().mockResolvedValue(session),
    capabilities: vi.fn(),
    startAuth: vi.fn(),
    completeAuth: vi.fn(),
    logout: vi.fn(),
    setCsrfToken: vi.fn(),
    abortUnsafeRequests: vi.fn(),
    timeline: vi.fn().mockResolvedValue({ posts: [], pageInfo: { nextCursor: null } }),
    search: vi
      .fn()
      .mockResolvedValue({ accounts: [], posts: [], hashtags: [], pageInfo: { nextCursor: null } }),
    profile: vi.fn(),
    followProfile: vi.fn(),
    unfollowProfile: vi.fn(),
    post: vi.fn(),
    postContext: vi.fn(),
    createPost: vi.fn(),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    actOnPost: vi.fn(),
  };
}

afterEach(() => window.history.replaceState(null, "", "/"));

describe("App", () => {
  it("routes local timelines without transforming opaque values", async () => {
    window.history.replaceState(null, "", "/local");
    const productApi = api();
    renderApp(<App api={productApi} />);

    await waitFor(() =>
      expect(productApi.timeline).toHaveBeenCalledWith("local", undefined, expect.any(AbortSignal)),
    );
  });

  it("does not call the BFF for missing profile and post identifiers", async () => {
    window.history.replaceState(null, "", "/profile");
    const productApi = api();
    const view = renderApp(<App api={productApi} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("A profile identifier is required.");
    expect(productApi.profile).not.toHaveBeenCalled();
    view.unmount();

    window.history.replaceState(null, "", "/post?id=");
    renderApp(<App api={productApi} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("A post identifier is required.");
    expect(productApi.post).not.toHaveBeenCalled();
  });

  it("does not render an unsupported reply reason without a target", async () => {
    const productApi = api({
      ...authenticatedSession,
      capabilities: {
        capabilities: [
          {
            name: "posts.reply",
            status: "unsupported",
            reason: "Reply policy forbids this.",
            source: "server",
            constraints: [],
          },
        ],
      },
    });
    renderApp(<App api={productApi} />);

    await screen.findByLabelText("Post content");
    expect(screen.queryByText("Reply policy forbids this.")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Reply to post" })).not.toBeInTheDocument();
  });

  it("preserves an image draft when navigation rerenders the authenticated shell", async () => {
    const productApi = api({
      ...authenticatedSession,
      capabilities: {
        capabilities: [
          {
            name: "posts.create",
            status: "supported",
            reason: null,
            source: "server",
            constraints: [],
          },
          {
            name: "media.upload",
            status: "supported",
            reason: null,
            source: "server",
            constraints: [],
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderApp(<App api={productApi} />);

    await user.upload(
      await screen.findByLabelText("Add images", { selector: "input" }),
      new File(["image"], "cat.png", { type: "image/png" }),
    );
    expect(screen.getByRole("img", { name: "cat.png" })).toBeVisible();

    await user.click(
      within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("link", {
        name: "Local",
      }),
    );

    await waitFor(() => expect(screen.getByRole("img", { name: "cat.png" })).toBeVisible());
  });

  it("keeps legacy create controls available until input constraints are advertised", async () => {
    const productApi = api({
      ...authenticatedSession,
      capabilities: {
        capabilities: [
          {
            name: "posts.create",
            status: "supported",
            reason: null,
            source: "server",
            constraints: [],
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderApp(<App api={productApi} />);

    expect(await screen.findByLabelText("Post content")).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Content warning" }));
    expect(screen.getByLabelText("Content warning", { selector: "input" })).toBeEnabled();
    expect(screen.getByLabelText("Mark media as sensitive")).toBeEnabled();
    expect(screen.getByLabelText("Visibility")).toHaveValue("public");
    expect(
      [...screen.getByLabelText("Visibility").querySelectorAll("option")].map(
        (option) => option.value,
      ),
    ).toEqual(["public", "unlisted", "followers", "direct", "local"]);
  });

  it("offers only the inputs advertised by the connected server", async () => {
    const productApi = api({
      ...authenticatedSession,
      capabilities: {
        capabilities: [
          {
            name: "posts.create",
            status: "supported",
            reason: null,
            source: "server",
            constraints: [
              { name: "acceptedInput", value: "content" },
              { name: "acceptedInput", value: "visibility.public" },
              { name: "acceptedInput", value: "visibility.unlisted" },
              { name: "acceptedInput", value: "visibility.followers" },
              { name: "acceptedInput", value: "visibility.direct" },
            ],
          },
        ],
      },
    });
    renderApp(<App api={productApi} />);

    expect(await screen.findByLabelText("Post content")).toBeEnabled();
    expect(screen.getByLabelText("Content warning", { selector: "input" })).toBeDisabled();
    expect(screen.getByLabelText("Mark media as sensitive")).toBeDisabled();
    expect(
      [...screen.getByLabelText("Visibility").querySelectorAll("option")].map(
        (option) => option.value,
      ),
    ).toEqual(["public", "unlisted", "followers", "direct"]);
  });

  it("fails closed when post creation omits every visibility value", async () => {
    const productApi = api({
      ...authenticatedSession,
      capabilities: {
        capabilities: [
          {
            name: "posts.create",
            status: "supported",
            reason: null,
            source: "server",
            constraints: [{ name: "acceptedInput", value: "content" }],
          },
        ],
      },
    });
    renderApp(<App api={productApi} />);

    expect(await screen.findByLabelText("Post content")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
  });

  it("recovers once from a private BFF authentication error without retaining the account", async () => {
    const session = vi
      .fn<ProductApi["session"]>()
      .mockResolvedValueOnce(authenticatedSession as Awaited<ReturnType<ProductApi["session"]>>)
      .mockResolvedValueOnce({ authenticated: false, csrfToken: "" });
    const productApi = api({ ...authenticatedSession, capabilities: { capabilities: [] } });
    productApi.session = session;
    productApi.timeline = vi
      .fn()
      .mockRejectedValue(new WebApiError("UNAUTHENTICATED", "Expired.", 401));
    renderApp(<App api={productApi} />);

    await waitFor(() => expect(screen.getByRole("region", { name: "Sign in" })).toBeVisible());
    expect(session).toHaveBeenCalledTimes(2);
    expect(productApi.abortUnsafeRequests).toHaveBeenCalledTimes(1);
    expect(productApi.setCsrfToken).toHaveBeenCalledWith("");
  });

  it("keeps the session query failed when anonymous recovery cannot refresh", async () => {
    const session = vi
      .fn<ProductApi["session"]>()
      .mockResolvedValueOnce(authenticatedSession as Awaited<ReturnType<ProductApi["session"]>>)
      .mockRejectedValueOnce(new Error("Session endpoint unavailable."));
    const productApi = api({ ...authenticatedSession, capabilities: { capabilities: [] } });
    productApi.session = session;
    productApi.timeline = vi
      .fn()
      .mockRejectedValue(new WebApiError("UNAUTHENTICATED", "Expired.", 401));
    renderApp(<App api={productApi} />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Session endpoint unavailable."),
    );
    expect(session).toHaveBeenCalledTimes(2);
    expect(productApi.abortUnsafeRequests).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });
});
