import { describe, expect, it } from "vitest";

import { parseOAuthCallback, validateOAuthCallbackState } from "./oauth.js";

describe("OAuth callback primitives", () => {
  it("parses successful callbacks without a callback HTTP server", () => {
    const callback = parseOAuthCallback(
      "https://client.example/callback?code=abc&state=state-1&iss=https%3A%2F%2Fsocial.example",
    );

    expect(callback).toMatchObject({
      ok: true,
      code: "abc",
      state: "state-1",
      issuer: "https://social.example",
    });
  });

  it("parses denied callbacks as typed results", () => {
    const callback = parseOAuthCallback(
      "https://client.example/callback?error=access_denied&error_description=Denied&state=state-1",
    );

    expect(callback).toMatchObject({
      ok: false,
      error: "access_denied",
      errorDescription: "Denied",
      state: "state-1",
    });
  });

  it("parses callback parameters without reconstructing a URL", () => {
    const callback = parseOAuthCallback(
      new URLSearchParams([
        ["code", "abc"],
        ["state", "state-1"],
      ]),
    );

    expect(callback).toMatchObject({
      ok: true,
      code: "abc",
      state: "state-1",
    });
  });

  it("parses documented callback request bodies", () => {
    const callback = parseOAuthCallback({
      params: {
        error: "access_denied",
        errorDescription: "Denied",
        state: "state-1",
      },
    });

    expect(callback).toMatchObject({
      ok: false,
      error: "access_denied",
      errorDescription: "Denied",
      state: "state-1",
    });
  });

  it("parses documented direct callback parameter objects", () => {
    const callback = parseOAuthCallback({
      error: "access_denied",
      errorDescription: "Denied",
      state: "state-1",
    });

    expect(callback).toMatchObject({
      ok: false,
      error: "access_denied",
      errorDescription: "Denied",
      state: "state-1",
    });
  });

  it("validates callback state", () => {
    const callback = parseOAuthCallback("https://client.example/callback?code=abc&state=actual");

    expect(() => validateOAuthCallbackState(callback, { expectedState: "expected" })).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        context: expect.objectContaining({ operation: "auth.oauth.callback" }),
      }),
    );
  });

  it("validates callback state bindings", () => {
    const callback = parseOAuthCallback("https://client.example/callback?code=abc&state=actual");

    expect(() =>
      validateOAuthCallbackState(callback, {
        expectedState: "actual",
        expectedBinding: {
          adapter: "mastodon",
          origin: "https://social.example",
          clientRequestId: "request-1",
        },
        actualBinding: {
          adapter: "misskey",
          origin: "https://social.example",
          clientRequestId: "request-1",
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        context: expect.objectContaining({
          operation: "auth.oauth.callback",
          adapter: "misskey",
          origin: "https://social.example",
        }),
      }),
    );
  });
});
