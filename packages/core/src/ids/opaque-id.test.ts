import { describe, expect, it } from "vitest";

import { isActivityPlugError } from "../errors/error.js";
import { createEntityRef, decodeOpaqueId, encodeOpaqueId } from "./opaque-id.js";

describe("opaque IDs", () => {
  it("round-trips raw remote IDs without losing adapter, origin, type, or raw ID", () => {
    const raw = {
      adapter: "mastodon",
      origin: "https://social.example",
      type: "post",
      id: "109335734512345678",
    } as const;

    const encoded = encodeOpaqueId(raw);

    expect(encoded).not.toContain(raw.id);
    expect(decodeOpaqueId(encoded)).toEqual(raw);
  });

  it("preserves raw IDs that contain punctuation and non-ASCII text", () => {
    const raw = {
      adapter: "misskey",
      origin: "https://misskey.example",
      type: "account",
      id: "9f:local/ユーザー",
    } as const;

    expect(decodeOpaqueId(encodeOpaqueId(raw))).toEqual(raw);
  });

  it("creates entity refs that expose both the opaque ID and the raw remote ID", () => {
    const raw = {
      adapter: "hackerspub",
      origin: "https://hackers.pub",
      type: "account",
      id: "42",
      rawUrl: "https://hackers.pub/@alice",
    } as const;

    const ref = createEntityRef(raw);

    expect(decodeOpaqueId(ref.id)).toEqual({
      adapter: raw.adapter,
      origin: raw.origin,
      type: raw.type,
      id: raw.id,
    });
    expect(ref.adapter).toBe(raw.adapter);
    expect(ref.origin).toBe(raw.origin);
    expect(ref.rawId).toBe(raw.id);
    expect(ref.rawUrl).toBe(raw.rawUrl);
    expect(ref.type).toBe("account");
  });

  it("rejects malformed opaque IDs instead of returning ambiguous raw IDs", () => {
    expect(() => decodeOpaqueId("not-an-activityplug-id")).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    try {
      decodeOpaqueId("not-an-activityplug-id");
    } catch (error) {
      expect(isActivityPlugError(error)).toBe(true);
    }
  });

  it("rejects decoded payloads with empty raw ID parts", () => {
    const crafted = "ap_1_WyIiLCIiLCIiLCIiXQ";

    expect(() => decodeOpaqueId(crafted)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});
