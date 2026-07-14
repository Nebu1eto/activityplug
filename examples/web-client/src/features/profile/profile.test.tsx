// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs shared DOM test helpers.
import "../../test/setup.js";
import { QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type PropsWithChildren, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { createTestQueryClient } from "../../test/render.js";
import {
  ProfileView,
  profileQueryKey,
  type FollowCapability,
  type ProfileApi,
  type ProfileLabels,
  type ProfileResponse,
} from "./profile.js";

describe("ProfileView", () => {
  it("loads the exact opaque ID and sanitizes the bio and profile fields", async () => {
    const api = profileApi(profileResponse(false));
    renderProfile(api.value);

    expect(await screen.findByRole("heading", { level: 1, name: "Alice" })).toBeVisible();
    expect(screen.getByText("Safe biography")).toBeVisible();
    expect(screen.getByText("ActivityPlug")).toBeVisible();
    expect(screen.queryByText("stolen-cookie")).not.toBeInTheDocument();
    expect(api.profile).toHaveBeenCalledWith(
      "opaque/profile+/=",
      undefined,
      expect.any(AbortSignal),
    );
  });

  it("passes the opaque post cursor verbatim and appends posts", async () => {
    const first = { ...profileResponse(false), pageInfo: { nextCursor: "opaque:+/=?cursor" } };
    const second = {
      ...profileResponse(false),
      posts: [post("second")],
      pageInfo: { nextCursor: null },
    };
    const profile = vi
      .fn<ProfileApi["profile"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const user = userEvent.setup();
    renderProfile({ ...profileApi(first).value, profile });

    expect(await screen.findByText("post first")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load more posts" }));

    expect(await screen.findByText("post second")).toBeVisible();
    expect(profile).toHaveBeenLastCalledWith(
      "opaque/profile+/=",
      "opaque:+/=?cursor",
      expect.any(AbortSignal),
    );
  });

  it("caps pagination at ten pages while retaining the initial page", async () => {
    const profile = vi.fn<ProfileApi["profile"]>(async (_id, pageCursor) => {
      const number =
        pageCursor === undefined ? 1 : Number(pageCursor.slice("opaque:profile-".length)) + 1;
      return {
        ...profileResponse(false),
        posts: [post(`p${number}`)],
        pageInfo: { nextCursor: number === 11 ? null : `opaque:profile-${number}` },
      };
    });
    const client = createTestQueryClient();
    const user = userEvent.setup();
    renderProfile(
      { ...profileApi(profileResponse(false)).value, profile },
      supportedFollow(),
      client,
    );

    expect(await screen.findByText("post p1")).toBeVisible();
    for (let number = 2; number <= 10; number += 1) {
      await user.click(screen.getByRole("button", { name: "Load more posts" }));
      expect(await screen.findByText(`post p${number}`)).toBeVisible();
    }

    expect(screen.queryByRole("button", { name: "Load more posts" })).not.toBeInTheDocument();
    expect(profile).toHaveBeenCalledTimes(10);
    expect(profile).toHaveBeenLastCalledWith(
      "opaque/profile+/=",
      "opaque:profile-9",
      expect.any(AbortSignal),
    );
    const data = client.getQueryData<InfiniteData<ProfileResponse, string | undefined>>(
      profileQueryKey("opaque/profile+/="),
    );
    expect(data?.pages.map((page) => page.posts[0]?.ref.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
    );
    expect(data?.pageParams).toEqual([
      undefined,
      ...Array.from({ length: 9 }, (_, index) => `opaque:profile-${index + 1}`),
    ]);
  });

  it("disables follow with the exact capability reason when it is unsupported", async () => {
    renderProfile(profileApi(profileResponse(false)).value, {
      name: "social.follow",
      status: "unsupported",
      reason: "This server does not support following accounts.",
    });

    expect(
      await screen.findByText("This server does not support following accounts."),
    ).toBeVisible();
    const follow = screen.getByRole("button", { name: "Follow" });
    expect(follow).toBeDisabled();
    expect(follow).toHaveAccessibleDescription("This server does not support following accounts.");
  });

  it("keeps follow disabled when support is unknown", async () => {
    renderProfile(profileApi(profileResponse(false)).value, {
      name: "social.follow",
      status: "unknown",
      reason: null,
    });

    const follow = await screen.findByRole("button", { name: "Follow" });
    expect(follow).toBeDisabled();
    expect(follow).toHaveAccessibleDescription("Follow state is unavailable.");
  });

  it("follows and unfollows the exact ID with canonical cache replacement", async () => {
    const api = profileApi(profileResponse(false));
    const client = createTestQueryClient();
    const user = userEvent.setup();
    renderProfile(api.value, supportedFollow(), client);

    await user.click(await screen.findByRole("button", { name: "Follow" }));
    expect(api.followProfile).toHaveBeenCalledWith("opaque/profile+/=");
    expect(await screen.findByRole("button", { name: "Unfollow" })).toBeVisible();
    expect(client.getQueryData(profileQueryKey("opaque/profile+/="))).toMatchObject({
      pages: [{ relationship: { following: true } }],
    });

    await user.click(screen.getByRole("button", { name: "Unfollow" }));
    expect(api.unfollowProfile).toHaveBeenCalledWith("opaque/profile+/=");
    await waitFor(() =>
      expect(client.getQueryData(profileQueryKey("opaque/profile+/="))).toMatchObject({
        pages: [{ relationship: { following: false } }],
      }),
    );
  });

  it("keeps a late follow response scoped to the initiating profile", async () => {
    const profileA = profileResponse(false);
    const profileB = profileResponseFor("profile-b", "Bob", false);
    const followedA = profileResponse(true);
    const pendingFollow = Promise.withResolvers<ProfileResponse>();
    const api: ProfileApi = {
      profile: vi.fn(async (id) => (id === "profile-b" ? profileB : profileA)),
      followProfile: vi.fn(async () => pendingFollow.promise),
      unfollowProfile: vi.fn(async () => profileA),
    };
    const client = createTestQueryClient();
    const user = userEvent.setup();
    function Wrapper({ children }: PropsWithChildren): ReactElement {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const view = render(
      <ProfileView api={api} followCapability={supportedFollow()} id="opaque/profile+/=" />,
      { wrapper: Wrapper },
    );

    await user.click(await screen.findByRole("button", { name: "Follow" }));
    view.rerender(<ProfileView api={api} followCapability={supportedFollow()} id="profile-b" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Bob" })).toBeVisible();

    pendingFollow.resolve(followedA);
    await waitFor(() =>
      expect(client.getQueryData(profileQueryKey("opaque/profile+/="))).toMatchObject({
        pages: [{ relationship: { following: true } }],
      }),
    );
    expect(client.getQueryData(profileQueryKey("profile-b"))).toMatchObject({
      pages: [{ profile: { displayName: "Bob" }, relationship: { following: false } }],
    });
  });

  it("keeps loaded profile pages after follow and unfollow", async () => {
    const first = { ...profileResponse(false), pageInfo: { nextCursor: "next-page" } };
    const second = {
      ...profileResponse(false),
      posts: [post("second")],
      pageInfo: { nextCursor: null },
    };
    const profile = vi
      .fn<ProfileApi["profile"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const api = profileApi(first).value;
    const client = createTestQueryClient();
    const user = userEvent.setup();
    renderProfile({ ...api, profile }, supportedFollow(), client);

    expect(await screen.findByText("post first")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load more posts" }));
    expect(await screen.findByText("post second")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Follow" }));
    expect(await screen.findByRole("button", { name: "Unfollow" })).toBeVisible();
    expect(screen.getByText("post first")).toBeVisible();
    expect(screen.getByText("post second")).toBeVisible();
    expect(
      client.getQueryData<InfiniteData<ProfileResponse>>(profileQueryKey("opaque/profile+/=")),
    ).toMatchObject({
      pages: [{ relationship: { following: true } }, { posts: [post("second")] }],
    });

    await user.click(screen.getByRole("button", { name: "Unfollow" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Follow" })).toBeVisible());
    expect(screen.getByText("post first")).toBeVisible();
    expect(screen.getByText("post second")).toBeVisible();
  });

  it("does not fabricate follow state when the relationship is absent", async () => {
    const response = { ...profileResponse(false), relationship: undefined };
    renderProfile(profileApi(response).value, supportedFollow());

    expect(await screen.findByRole("heading", { level: 1, name: "Alice" })).toBeVisible();
    const follow = screen.getByRole("button", { name: "Follow" });
    expect(follow).toBeDisabled();
    expect(follow).toHaveAccessibleDescription("Follow state is unavailable.");
  });
});

function renderProfile(
  api: ProfileApi,
  followCapability: FollowCapability = supportedFollow(),
  client = createTestQueryClient(),
  labels?: Partial<ProfileLabels>,
): void {
  function Wrapper({ children }: PropsWithChildren): ReactElement {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(
    <ProfileView
      api={api}
      followCapability={followCapability}
      id="opaque/profile+/="
      labels={labels}
    />,
    { wrapper: Wrapper },
  );
}

function supportedFollow() {
  return { name: "social.follow", status: "supported", reason: null } as const;
}

function profileResponse(following: boolean): ProfileResponse {
  return {
    profile: {
      ref: { id: "opaque/profile+/=" },
      username: "alice",
      handle: "@alice@example.test",
      displayName: "Alice",
      bot: true,
      locked: true,
      bioHtml: "<p>Safe biography</p><script>stolen-cookie</script>",
      fields: [
        {
          name: "Project",
          valueHtml:
            '<a href="https://activityplug.example">ActivityPlug</a><script>stolen-cookie</script>',
        },
      ],
      followersCount: 10,
      followingCount: 20,
      postsCount: 30,
    },
    posts: [post("first")],
    relationship: {
      account: { id: "opaque/profile+/=" },
      following,
      followedBy: false,
      requested: false,
      blocking: false,
      muting: false,
    },
    pageInfo: { nextCursor: null },
  };
}

function profileResponseFor(id: string, displayName: string, following: boolean): ProfileResponse {
  const response = profileResponse(following);
  return {
    ...response,
    profile: {
      ...response.profile,
      ref: { id },
      username: displayName.toLowerCase(),
      handle: `@${displayName.toLowerCase()}@example.test`,
      displayName,
    },
    relationship:
      response.relationship === undefined
        ? undefined
        : { ...response.relationship, account: { id } },
  };
}

function post(id: string): ProfileResponse["posts"][number] {
  return {
    ref: { id },
    author: {
      ref: { id: "opaque/profile+/=" },
      username: "alice",
      handle: "@alice@example.test",
      displayName: "Alice",
      bot: false,
      locked: false,
    },
    contentHtml: `<p>post ${id}</p>`,
    createdAt: "2026-07-12T00:00:00.000Z",
    sensitive: false,
    media: [],
  };
}

function profileApi(initial: ProfileResponse) {
  const profile = vi.fn<ProfileApi["profile"]>(async () => initial);
  const followProfile = vi.fn<ProfileApi["followProfile"]>(async () => profileResponse(true));
  const unfollowProfile = vi.fn<ProfileApi["unfollowProfile"]>(async () => profileResponse(false));
  return {
    value: { profile, followProfile, unfollowProfile },
    profile,
    followProfile,
    unfollowProfile,
  };
}
