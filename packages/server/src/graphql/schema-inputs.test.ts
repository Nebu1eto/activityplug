import { describe, expect, it } from "vitest";

import { filterInput, postUpdateInput, schedulePostInput } from "./schema-inputs.js";

describe("GraphQL schema input normalization", () => {
  it("rejects empty post update inputs", () => {
    expect(() => postUpdateInput({ id: "post-1", sessionId: "session-1" })).toThrow(
      "Post editing requires at least one editable field.",
    );
  });

  it("rejects empty filter arrays", () => {
    expect(() =>
      filterInput({
        origin: "https://example.com",
        sessionId: "session-1",
        title: "Muted words",
        context: [],
        keywords: [{ keyword: "spoiler" }],
      }),
    ).toThrow("GraphQL input field must be a non-empty array: context.");
    expect(() =>
      filterInput({
        origin: "https://example.com",
        sessionId: "session-1",
        title: "Muted words",
        context: ["home"],
        keywords: [],
      }),
    ).toThrow("GraphQL input field must be a non-empty array: keywords.");
  });

  it("rejects non-positive expiration values", () => {
    expect(() =>
      filterInput({
        origin: "https://example.com",
        sessionId: "session-1",
        title: "Muted words",
        context: ["home"],
        expiresInSeconds: 0,
        keywords: [{ keyword: "spoiler" }],
      }),
    ).toThrow("GraphQL JSON input field must be a positive integer: expiresInSeconds.");
    expect(() =>
      schedulePostInput({
        origin: "https://example.com",
        sessionId: "session-1",
        content: "hello",
        scheduledAt: "2026-05-02T00:00:00Z",
        poll: { options: ["yes", "no"], expiresInSeconds: -1 },
      }),
    ).toThrow("GraphQL JSON input field must be a positive integer: expiresInSeconds.");
  });

  it("rejects underspecified GraphQL poll options", () => {
    expect(() =>
      postUpdateInput({
        id: "post-1",
        sessionId: "session-1",
        poll: { options: ["yes"] },
      }),
    ).toThrow("GraphQL input field must include at least two items: poll.options.");
    expect(() =>
      schedulePostInput({
        origin: "https://example.com",
        sessionId: "session-1",
        content: "",
        scheduledAt: "2026-05-02T00:00:00Z",
        poll: { options: [] },
      }),
    ).toThrow("GraphQL input field must include at least two items: poll.options.");
  });

  it("allows scheduled poll posts with empty text", () => {
    expect(
      schedulePostInput({
        origin: "https://example.com",
        sessionId: "session-1",
        content: "",
        scheduledAt: "2026-05-02T00:00:00Z",
        poll: { options: ["yes", "no"], expiresInSeconds: 300 },
      }),
    ).toMatchObject({
      content: "",
      poll: { options: ["yes", "no"], expiresInSeconds: 300 },
    });
  });

  it("rejects a poll without an explicit expiration", () => {
    expect(() =>
      schedulePostInput({
        origin: "https://example.com",
        sessionId: "session-1",
        content: "",
        scheduledAt: "2026-05-02T00:00:00Z",
        poll: { options: ["yes", "no"] },
      }),
    ).toThrow("GraphQL JSON input field must be a positive integer: expiresInSeconds.");
  });

  it("rejects impossible scheduled date-time values", () => {
    expect(() =>
      schedulePostInput({
        origin: "https://example.com",
        sessionId: "session-1",
        content: "hello",
        scheduledAt: "2026-04-31T00:00:00Z",
      }),
    ).toThrow("GraphQL input field must be a valid date-time string: scheduledAt.");
  });
});
