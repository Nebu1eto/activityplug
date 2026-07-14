import { describe, expect, it } from "vitest";

import {
  createCliOriginPolicy,
  createServerFromCliOptions,
  createTrustedProxyClientIp,
  parseServerCliArgs,
} from "./cli.js";

describe("server CLI parsing", () => {
  it("accepts explicit host and port options", () => {
    expect(parseServerCliArgs(["--host", "0.0.0.0", "--port", "8080"])).toEqual({
      hostname: "0.0.0.0",
      port: 8080,
      allowedOrigins: [],
      allowPrivateNetworks: false,
    });
  });

  it("accepts explicit remote origin allow-list entries", () => {
    expect(
      parseServerCliArgs([
        "--allow-origin",
        "https://mastodon.example",
        "--allow-origin",
        "https://misskey.example",
      ]),
    ).toEqual({
      hostname: "127.0.0.1",
      port: 4000,
      allowedOrigins: ["https://mastodon.example", "https://misskey.example"],
      allowPrivateNetworks: false,
    });
  });

  it("enables the browser boundary only with an environment-provided signing key", async () => {
    const signingKey = new Uint8Array(32).fill(17);
    const options = parseServerCliArgs(
      [
        "--browser-origin",
        "https://client.example",
        "--browser-memory-stores",
        "--trusted-proxy",
        "10.0.0.1",
      ],
      { ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY: Buffer.from(signingKey).toString("base64url") },
    );

    expect(options.browser).toEqual({
      publicOrigin: "https://client.example",
      cookieSigningKey: signingKey,
      memoryStores: true,
      trustedProxyAddresses: ["10.0.0.1"],
    });
    const server = createServerFromCliOptions(options);
    const response = await server.app.request("https://client.example/v1/browser/session");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("__Host-activityplug=");
  });

  it("rejects incomplete or insecure browser CLI configuration", () => {
    expect(() => parseServerCliArgs(["--browser-origin", "https://client.example"], {})).toThrow(
      expect.objectContaining({ exitCode: 1 }),
    );
    expect(() =>
      parseServerCliArgs(["--browser-origin", "http://client.example"], {
        ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY: Buffer.alloc(32).toString("base64url"),
      }),
    ).toThrow(expect.objectContaining({ exitCode: 1 }));
    expect(() =>
      parseServerCliArgs([], {
        ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY: Buffer.alloc(32).toString("base64url"),
      }),
    ).toThrow(expect.objectContaining({ exitCode: 1 }));
    expect(() => parseServerCliArgs(["--browser-memory-stores"], {})).toThrow(
      expect.objectContaining({ exitCode: 1 }),
    );
    expect(() =>
      parseServerCliArgs(
        [
          "--browser-origin",
          "https://client.example",
          "--browser-memory-stores",
          "--trusted-proxy",
          "not-an-ip",
        ],
        {
          ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY: Buffer.alloc(32).toString("base64url"),
        },
      ),
    ).toThrow(expect.objectContaining({ exitCode: 1 }));
  });

  it("accepts forwarded client addresses only from configured proxy peers", () => {
    const resolveClientIp = createTrustedProxyClientIp(["10.0.0.1", "10.0.0.2"]);
    const spoofed = new Request("https://client.example/", {
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
    const forwarded = new Request("https://client.example/", {
      headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.2" },
    });

    expect(resolveClientIp(spoofed, "203.0.113.9")).toBe("203.0.113.9");
    expect(resolveClientIp(forwarded, "10.0.0.1")).toBe("198.51.100.7");
    expect(resolveClientIp(spoofed, "::ffff:10.0.0.1")).toBe("198.51.100.7");
  });

  it("rejects allowlist entries that are not strict origins", () => {
    for (const origin of [
      "https://social.example/path",
      "https://social.example?query=1",
      "https://social.example#fragment",
      "https://user:secret@social.example",
    ]) {
      expect(() => parseServerCliArgs(["--allow-origin", origin])).toThrow(
        expect.objectContaining({ exitCode: 1 }),
      );
    }
  });

  it("rejects plaintext remote origins even when private networks are enabled", () => {
    expect(() =>
      parseServerCliArgs(["--allow-origin", "http://127.0.0.1:3000", "--allow-private-networks"]),
    ).toThrow(expect.objectContaining({ exitCode: 1 }));
  });

  it("requires an explicit private-network flag in addition to the allowlist", () => {
    expect(
      parseServerCliArgs(["--allow-origin", "https://127.0.0.1:3000", "--allow-private-networks"]),
    ).toEqual({
      hostname: "127.0.0.1",
      port: 4000,
      allowedOrigins: ["https://127.0.0.1:3000"],
      allowPrivateNetworks: true,
    });
  });

  it("reports malformed policy origins through typed ActivityPlug errors", async () => {
    await expect(
      createCliOriginPolicy(["https://social.example"]).assertAllowed(
        "not an origin",
        "account.get",
      ),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });

  it("rejects invalid runtime options before the server starts", () => {
    expect(() => parseServerCliArgs(["--port", "0"])).toThrow(
      expect.objectContaining({
        exitCode: 1,
      }),
    );
    expect(() => parseServerCliArgs(["--host", "", "--port", "4000"])).toThrow(
      expect.objectContaining({
        exitCode: 1,
      }),
    );
  });

  it("lets Optique handle help output without treating it as a validation error", () => {
    expect(() => parseServerCliArgs(["--help"])).toThrow(
      expect.objectContaining({
        exitCode: 0,
      }),
    );
  });
});
