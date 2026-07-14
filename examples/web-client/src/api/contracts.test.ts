import { describe, expect, it } from "vitest";

import { isPostResponse, isTimelineResponse } from "./contracts.js";

const ref = {
  id: "post-1",
  type: "post",
  adapter: "mastodon",
  origin: "https://social.example",
};

const author = {
  ref: { ...ref, id: "alice", type: "account" },
  username: "alice",
  handle: "@alice@social.example",
  displayName: "Alice",
  bot: false,
  locked: false,
};

function summary() {
  return {
    ref,
    author,
    contentHtml: "<p>Hello</p>",
    createdAt: "2026-07-12T00:00:00.000Z",
    visibility: "public",
    sensitive: false,
    media: [],
  };
}

function post() {
  return {
    ...summary(),
    author: { ...author, fields: [] },
  };
}

describe("browser post response contracts", () => {
  it.each([
    ["reply references", (value: Record<string, unknown>) => (value.replyTo = { id: "reply" })],
    ["quote references", (value: Record<string, unknown>) => (value.quoteOf = [])],
    ["boost references", (value: Record<string, unknown>) => (value.boostOf = { ...ref, id: 1 })],
    ["counts", (value: Record<string, unknown>) => (value.counts = { favourites: "4" })],
    [
      "viewer reactions",
      (value: Record<string, unknown>) =>
        (value.viewerState = { reactions: [{ emoji: "+1", me: "yes" }] }),
    ],
  ])("rejects malformed optional %s before post rendering", (_label, mutate) => {
    const value = summary() as Record<string, unknown>;
    mutate(value);

    expect(isTimelineResponse({ posts: [value], pageInfo: { nextCursor: null } })).toBe(false);
  });

  it("rejects malformed detail-only poll fields before post rendering", () => {
    const value = post() as Record<string, unknown>;
    value.poll = {
      ref: { ...ref, id: "poll-1", type: "poll" },
      expired: false,
      multiple: false,
      options: [{ title: "First", votesCount: "two" }],
    };

    expect(isPostResponse({ post: value })).toBe(false);
  });

  it("rejects non-post references before list or detail rendering", () => {
    const listValue = { ...summary(), ref: { ...ref, type: "account" } };
    const detailValue = { ...post(), ref: { ...ref, type: "media" } };

    expect(isTimelineResponse({ posts: [listValue], pageInfo: { nextCursor: null } })).toBe(false);
    expect(isPostResponse({ post: detailValue })).toBe(false);
  });

  it("accepts fully structured optional post details", () => {
    const value = post() as Record<string, unknown>;
    Object.assign(value, {
      replyTo: { ...ref, id: "reply" },
      quoteOf: { ...ref, id: "quote" },
      boostOf: { ...ref, id: "boost" },
      counts: { replies: 1, reblogs: 2, favourites: 3 },
      viewerState: {
        favourited: true,
        boosted: false,
        bookmarked: true,
        reactions: [{ emoji: "+1", count: 2, me: true }],
      },
      poll: {
        ref: { ...ref, id: "poll-1", type: "poll" },
        expired: false,
        multiple: false,
        votesCount: 2,
        votersCount: 2,
        voted: true,
        ownVotes: [0],
        options: [{ title: "First", votesCount: 2 }],
      },
    });

    expect(isPostResponse({ post: value })).toBe(true);
  });
});
