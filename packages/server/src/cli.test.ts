import { describe, expect, it } from "vitest";

import { createCliOriginPolicy, parseServerCliArgs } from "./cli.js";

describe("server CLI parsing", () => {
  it("accepts explicit host and port options", () => {
    expect(parseServerCliArgs(["--host", "0.0.0.0", "--port", "8080"])).toEqual({
      hostname: "0.0.0.0",
      port: 8080,
      allowedOrigins: [],
    });
  });

  it("accepts explicit remote origin allow-list entries", () => {
    expect(
      parseServerCliArgs([
        "--allow-origin",
        "https://mastodon.example/users/alice",
        "--allow-origin",
        "https://misskey.example",
      ]),
    ).toEqual({
      hostname: "127.0.0.1",
      port: 4000,
      allowedOrigins: ["https://mastodon.example", "https://misskey.example"],
    });
  });

  it("rejects private remote origin allow-list entries", () => {
    expect(() => parseServerCliArgs(["--allow-origin", "http://127.0.0.1:3000"])).toThrow(
      expect.objectContaining({
        exitCode: 1,
      }),
    );
    expect(() => parseServerCliArgs(["--allow-origin", "http://[::ffff:127.0.0.1]"])).toThrow(
      expect.objectContaining({
        exitCode: 1,
      }),
    );
  });

  it("reports malformed policy origins through typed ActivityPlug errors", () => {
    expect(() =>
      createCliOriginPolicy(["https://social.example"])({
        origin: "not an origin",
        operation: "account.get",
      }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
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
