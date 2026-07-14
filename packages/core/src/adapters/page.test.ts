import { describe, expect, it } from "vitest";

import { type PageInfo } from "../types/entities.js";
import { decodePageCursor, encodePageCursor, PORTABLE_PAGE_LIMIT } from "./page.js";

describe("page cursors", () => {
  it("round-trips opaque cursors whose payload contains underscores", () => {
    const raw = {
      adapter: "mastodon",
      origin: "https://social.example",
      operation: "account.posts",
      cursor: "max_id_with_underscores",
    };

    expect(decodePageCursor(encodePageCursor(raw), raw)).toBe(raw.cursor);
  });

  it("preserves every cursor payload byte and fixes the portable limit at 100", () => {
    const raw = {
      adapter: "custom-adapter.v2",
      origin: "https://social.example",
      operation: "timeline.home",
      cursor: "opaque:+/=?\u0000한글",
    };

    expect(decodePageCursor(encodePageCursor(raw), raw)).toBe(raw.cursor);
    expect(PORTABLE_PAGE_LIMIT).toBe(100);
  });

  it("keeps PageInfo limited to portable cursors and direction flags", () => {
    const pageInfo: PageInfo = {
      startCursor: "first",
      endCursor: "last",
      hasNextPage: true,
      hasPreviousPage: false,
    };

    expect(pageInfo).not.toHaveProperty("raw");
  });
});
