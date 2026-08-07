import { describe, expect, it } from "vitest";

import { createOpenOriginPolicy, createOriginPolicy } from "./origin-policy.js";

describe("createOriginPolicy", () => {
  it("admits any HTTPS origin when the allowlist is empty", async () => {
    const policy = createOriginPolicy([]);

    await expect(
      policy.assertAllowed("https://social.example", "instance.detect"),
    ).resolves.toBeUndefined();
    await expect(
      policy.assertAllowed("https://unknown.example", "instance.detect"),
    ).resolves.toBeUndefined();
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

describe("createOpenOriginPolicy", () => {
  it("admits arbitrary HTTPS origins and rejects other schemes", async () => {
    const policy = createOpenOriginPolicy({ allowInsecureLoopback: false });

    await expect(
      policy.assertAllowed("https://any.example", "instance.get"),
    ).resolves.toBeUndefined();
    await expect(
      policy.assertAllowed("HTTPS://MASTODON.SOCIAL:443", "instance.get"),
    ).resolves.toBeUndefined();
    for (const origin of ["http://any.example", "ftp://any.example", "file:///etc/passwd"]) {
      await expect(policy.assertAllowed(origin, "instance.get")).rejects.toMatchObject({
        code: "ORIGIN_NOT_ALLOWED",
      });
    }
  });

  it("admits HTTP loopback origins only while insecure loopback is allowed", async () => {
    const development = createOpenOriginPolicy({ allowInsecureLoopback: true });
    const production = createOpenOriginPolicy({ allowInsecureLoopback: false });

    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      await expect(development.assertAllowed(origin, "instance.get")).resolves.toBeUndefined();
      await expect(production.assertAllowed(origin, "instance.get")).rejects.toMatchObject({
        code: "ORIGIN_NOT_ALLOWED",
      });
    }
    // A non-loopback private address stays outside the loopback exception.
    await expect(
      development.assertAllowed("http://10.0.0.2", "instance.get"),
    ).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
  });

  it("rejects origins carrying credentials or a path", async () => {
    const policy = createOpenOriginPolicy();

    for (const origin of ["https://user:secret@any.example", "https://any.example/path"]) {
      await expect(policy.assertAllowed(origin, "instance.get")).rejects.toMatchObject({
        code: "ORIGIN_NOT_ALLOWED",
      });
    }
  });
});
