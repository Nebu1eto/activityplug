import { createCapabilitySet, type AdapterOperationContext } from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { assertMutationSuccess } from "./mapping.js";

const context: AdapterOperationContext = {
  adapterId: "hackerspub",
  origin: "https://hackerspub.example",
  capabilities: createCapabilitySet(),
  fetch: vi.fn<typeof globalThis.fetch>(),
};

describe("HackersPub mutation payload guards", () => {
  it.each([
    ["createNote", "CreateNotePayload"],
    ["deletePost", "DeletePostPayload"],
    ["followActor", "FollowActorPayload"],
    ["unfollowActor", "UnfollowActorPayload"],
    ["blockActor", "BlockActorPayload"],
    ["unblockActor", "UnblockActorPayload"],
    ["sharePost", "SharePostPayload"],
    ["unsharePost", "UnsharePostPayload"],
    ["addReactionToPost", "AddReactionToPostPayload"],
    ["removeReactionFromPost", "RemoveReactionFromPostPayload"],
    ["uploadMedia", "UploadMediaPayload"],
  ] as const)("accepts only the exact %s success typename", (mutation, typename) => {
    expect(() =>
      assertMutationSuccess({ __typename: typename }, mutation, "test.operation", context),
    ).not.toThrow();

    const receivedTypename = `${"X".repeat(200)}Payload`;
    expect(() =>
      assertMutationSuccess({ __typename: receivedTypename }, mutation, "test.operation", context),
    ).toThrowError(
      expect.objectContaining({
        code: "REMOTE_PROTOCOL_ERROR",
        context: {
          adapter: "hackerspub",
          origin: "https://hackerspub.example",
          operation: "test.operation",
          raw: {
            expectedTypename: typename,
            receivedTypename: receivedTypename.slice(0, 128),
          },
        },
      }),
    );
  });

  it("keeps declared domain errors typed", () => {
    expect(() =>
      assertMutationSuccess(
        { __typename: "InvalidInputError", inputPath: "input.content" },
        "createNote",
        "post.create",
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("rejects error typenames that belong to a different mutation", () => {
    expect(() =>
      assertMutationSuccess(
        { __typename: "SharedPostDeletionNotAllowedError" },
        "createNote",
        "post.create",
        context,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "REMOTE_PROTOCOL_ERROR",
        context: expect.objectContaining({
          raw: {
            expectedTypename: "CreateNotePayload",
            receivedTypename: "SharedPostDeletionNotAllowedError",
          },
        }),
      }),
    );
  });
});
