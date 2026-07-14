import { describe, expect, it } from "vitest";

import { createOriginPolicy } from "./origin-policy.js";

describe("createOriginPolicy", () => {
  it("denies every origin when the allowlist is empty", async () => {
    const policy = createOriginPolicy([]);

    await expect(
      policy.assertAllowed("https://social.example", "instance.detect"),
    ).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { origin: "https://social.example", operation: "instance.detect" },
    });
  });

  it("canonicalizes entries and requires an exact origin match", async () => {
    const policy = createOriginPolicy(["HTTPS://SOCIAL.EXAMPLE:443"]);

    await expect(
      policy.assertAllowed("https://social.example", "account.get"),
    ).resolves.toBeUndefined();
    await expect(
      policy.assertAllowed("https://sub.social.example", "account.get"),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });

  it("rejects malformed allowlist entries instead of silently trimming them", () => {
    for (const origin of [
      "https://social.example/path",
      "https://social.example?query=1",
      "https://social.example#fragment",
      "https://user:secret@social.example",
    ]) {
      expect(() => createOriginPolicy([origin])).toThrowError(
        expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }),
      );
    }
  });

  it("does not treat private-address permission as origin membership", async () => {
    const policy = createOriginPolicy(["http://127.0.0.1:3000"]);

    await expect(
      policy.assertAllowed("http://127.0.0.1:3000", "instance.get"),
    ).resolves.toBeUndefined();
    await expect(policy.assertAllowed("http://10.0.0.2", "instance.get")).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
  });
});
