import { describe, expect, it, vi } from "vitest";

import { resolveClientIp } from "./client-ip.js";

describe("resolveClientIp", () => {
  const request = new Request("https://api.example", {
    headers: { "x-forwarded-for": "198.51.100.77", "x-real-ip": "198.51.100.78" },
  });

  it("uses the transport peer and ignores forwarding headers by default", () => {
    expect(resolveClientIp(request, undefined, "203.0.113.10")).toBe("203.0.113.10");
    expect(resolveClientIp(request, undefined, undefined)).toBe("unknown");
  });

  it("delegates forwarding-header trust to an explicit resolver", () => {
    const resolver = vi.fn((input: Request, peerAddress: string | undefined) => {
      expect(peerAddress).toBe("203.0.113.10");
      return input.headers.get("x-forwarded-for") ?? "unknown";
    });

    expect(resolveClientIp(request, resolver, "203.0.113.10")).toBe("198.51.100.77");
    expect(resolver).toHaveBeenCalledOnce();
  });

  it.each(["", " \t ", "198.51.100.1\nspoofed", "x".repeat(257)])(
    "rejects malformed resolver identities: %j",
    (identity) => {
      expect(resolveClientIp(request, () => identity, "203.0.113.10")).toBeUndefined();
    },
  );
});
