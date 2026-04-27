import { describe, expect, it } from "vitest";

import { decodePageCursor, encodePageCursor } from "./page.js";

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
});
