import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../api/openapi.js";
import {
  createTestService,
  getFirstGraphQLError,
  getGraphQLIntrospection,
  inputFieldTypeName,
  inputTypeName,
  jsonRequest,
  testMedia,
  testPoll,
  testPost,
  testRelationship,
  testSession,
  testViewerAccount,
} from "./app-test-utils.js";
import { createActivityPlugApp } from "./app.js";

describe("ActivityPlug HTTP and GraphQL input contracts", () => {
  it("keeps operation inputs narrow at the HTTP and GraphQL boundaries", async () => {
    const seenMuteInputs: unknown[] = [];
    const seenCreateInputs: unknown[] = [];
    const seenMediaInputs: unknown[] = [];
    const seenVoteInputs: unknown[] = [];
    const app = createActivityPlugApp({
      service: createTestService({
        posts: {
          ...createTestService().posts,
          create: async (input) => {
            seenCreateInputs.push(input);
            return testPost;
          },
        },
        media: {
          ...createTestService().media,
          upload: async (input) => {
            seenMediaInputs.push(input);
            return testMedia;
          },
        },
        polls: {
          ...createTestService().polls,
          vote: async (input) => {
            seenVoteInputs.push(input);
            return testPoll;
          },
        },
        social: {
          ...createTestService().social,
          mute: async (input) => {
            seenMuteInputs.push(input);
            return testRelationship;
          },
        },
      }),
    });

    const searchCursorResponse = await app.request(
      "/api/v1/search?origin=https://example.test&q=alice&after=remote",
    );
    expect(searchCursorResponse.status).toBe(400);
    await expect(searchCursorResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const invalidSearchResolveResponse = await app.request(
      "/api/v1/search?origin=https://example.test&q=alice&resolve=yes",
    );
    expect(invalidSearchResolveResponse.status).toBe(400);
    await expect(invalidSearchResolveResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const emptySearchTypeResponse = await app.request(
      "/api/v1/search?origin=https://example.test&q=alice&type=",
    );
    expect(emptySearchTypeResponse.status).toBe(400);
    await expect(emptySearchTypeResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const emptySearchResolveResponse = await app.request(
      "/api/v1/search?origin=https://example.test&q=alice&resolve=",
    );
    expect(emptySearchResolveResponse.status).toBe(400);
    await expect(emptySearchResolveResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const invalidPublicTimelineLocalResponse = await app.request(
      "/api/v1/timelines/public?origin=https://example.test&local=yes",
    );
    expect(invalidPublicTimelineLocalResponse.status).toBe(400);
    await expect(invalidPublicTimelineLocalResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const emptyPublicTimelineLocalResponse = await app.request(
      "/api/v1/timelines/public?origin=https://example.test&local=",
    );
    expect(emptyPublicTimelineLocalResponse.status).toBe(400);
    await expect(emptyPublicTimelineLocalResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    for (const path of [
      "/api/v1/instances/https%3A%2F%2Fexample.test?adapter=",
      "/api/v1/accounts/lookup?origin=https://example.test&handle=alice@example.test&adapter=",
      `/api/v1/accounts/${encodeURIComponent(testViewerAccount.ref.id)}/posts?sessionId=`,
      "/api/v1/timelines/public?origin=https://example.test&sessionId=",
      "/api/v1/timelines/local?origin=https://example.test&sessionId=",
      "/api/v1/search?origin=https://example.test&q=alice&sessionId=",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED" },
      });
    }

    const invalidMediaForm = new FormData();
    invalidMediaForm.set("origin", "https://example.test");
    invalidMediaForm.set("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
    invalidMediaForm.set("sensitive", "yes");
    const invalidMediaResponse = await app.request("/api/v1/media", {
      method: "POST",
      headers: { authorization: `Bearer ${testSession.id}` },
      body: invalidMediaForm,
    });
    expect(invalidMediaResponse.status).toBe(400);
    await expect(invalidMediaResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const emptyMetadataMediaForm = new FormData();
    emptyMetadataMediaForm.set("origin", "https://example.test");
    emptyMetadataMediaForm.set("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
    emptyMetadataMediaForm.set("filename", "");
    emptyMetadataMediaForm.set("description", "");
    const emptyMetadataMediaResponse = await app.request("/api/v1/media", {
      method: "POST",
      headers: { authorization: `Bearer ${testSession.id}` },
      body: emptyMetadataMediaForm,
    });
    expect(emptyMetadataMediaResponse.status).toBe(200);
    expect(seenMediaInputs.at(-1)).toMatchObject({ filename: "", description: "" });

    await expect(
      jsonRequest(
        app.request(`/api/v1/accounts/${testViewerAccount.ref.id}/mute`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${testSession.id}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ notifications: false, durationSeconds: 60 }),
        }),
      ),
    ).resolves.toMatchObject({ data: { account: { rawId: "1" } } });
    expect(seenMuteInputs).toEqual([
      {
        accountId: testViewerAccount.ref.id,
        sessionId: testSession.id,
        notifications: false,
        durationSeconds: 60,
      },
    ]);

    const nonJsonMuteResponse = await app.request(
      `/api/v1/accounts/${testViewerAccount.ref.id}/mute`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${testSession.id}`,
          "content-type": "text/plain",
        },
        body: JSON.stringify({ notifications: false }),
      },
    );
    expect(nonJsonMuteResponse.status).toBe(400);
    await expect(nonJsonMuteResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const nonJsonBoostResponse = await app.request(`/api/v1/posts/${testPost.ref.id}/boost`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "text/plain",
      },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(nonJsonBoostResponse.status).toBe(400);
    await expect(nonJsonBoostResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const invalidBase64 = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: UploadMediaInput!) { uploadMedia(input: $input) { ref { rawId } } }`,
        variables: {
          input: {
            origin: "https://example.test",
            sessionId: testSession.id,
            fileBase64: "not base64!",
          },
        },
      }),
    });
    expect(getFirstGraphQLError(await jsonRequest(invalidBase64)).extensions.activityplug).toEqual({
      code: "VALIDATION_FAILED",
      message: "GraphQL input field must be valid base64: fileBase64.",
    });

    const invalidPollResponse = await app.request("/api/v1/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: "https://example.test",
        content: "",
        poll: { options: ["yes", " "] },
      }),
    });
    expect(invalidPollResponse.status).toBe(400);
    await expect(invalidPollResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const blankContentResponse = await app.request("/api/v1/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: "https://example.test",
        content: "   ",
      }),
    });
    expect(blankContentResponse.status).toBe(400);
    await expect(blankContentResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const invalidReactionResponse = await app.request(
      `/api/v1/posts/${testPost.ref.id}/reactions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${testSession.id}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ emoji: " " }),
      },
    );
    expect(invalidReactionResponse.status).toBe(400);
    await expect(invalidReactionResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const invalidGraphQLPoll = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: CreatePostInput!) { createPost(input: $input) { ref { rawId } } }`,
        variables: {
          input: {
            origin: "https://example.test",
            sessionId: testSession.id,
            content: "",
            poll: { options: [] },
          },
        },
      }),
    });
    expect(
      getFirstGraphQLError(await jsonRequest(invalidGraphQLPoll)).extensions.activityplug,
    ).toEqual(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    const blankGraphQLContent = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: CreatePostInput!) { createPost(input: $input) { ref { rawId } } }`,
        variables: {
          input: {
            origin: "https://example.test",
            sessionId: testSession.id,
            content: "   ",
          },
        },
      }),
    });
    expect(
      getFirstGraphQLError(await jsonRequest(blankGraphQLContent)).extensions.activityplug,
    ).toEqual(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    const introspection = getGraphQLIntrospection(
      await jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query:
              '{ __schema { queryType { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } } mutationType { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } } } __type(name: "SearchInput") { name inputFields { name type { kind name ofType { kind name ofType { kind name } } } } } }',
          }),
        }),
      ),
    );
    expect(inputTypeName(introspection, "query", "search", "input")).toBe("SearchInput");
    expect(inputTypeName(introspection, "query", "accountPosts", "sessionId")).toBe("ID");
    expect(inputFieldTypeName(introspection, "SearchInput", "sessionId")).toBe("ID");
    expect(inputTypeName(introspection, "mutation", "uploadMedia", "input")).toBe(
      "UploadMediaInput",
    );
    expect(inputTypeName(introspection, "mutation", "createPost", "input")).toBe("CreatePostInput");
    expect(inputTypeName(introspection, "mutation", "muteAccount", "input")).toBe(
      "MuteAccountInput",
    );
    expect(inputTypeName(introspection, "mutation", "boostPost", "input")).toBe("BoostPostInput");
    expect(inputTypeName(introspection, "mutation", "reactToPost", "input")).toBe("ReactPostInput");
    expect(
      (
        createOpenApiDocument({ tokenImport: "open" }).paths["/api/v1/timelines/public"].get
          .parameters as readonly { readonly name?: string }[]
      ).some((parameter) => parameter.name === "local"),
    ).toBe(true);

    const searchCursorGraphQL = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query($input: SearchInput!) { search(input: $input) { accounts { ref { rawId } } } }`,
          variables: {
            input: {
              origin: "https://example.test",
              query: "alice",
              page: { after: "remote" },
            },
          },
        }),
      }),
    );
    expect(getFirstGraphQLError(searchCursorGraphQL).message).toContain(
      'Field "after" is not defined by type "SearchPageInput".',
    );

    await expect(
      jsonRequest(
        app.request("/api/v1/posts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${testSession.id}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: "https://example.test",
            content: "",
            mediaIds: ["media-1"],
          }),
        }),
      ),
    ).resolves.toMatchObject({ data: { ref: { rawId: "post-1" } } });

    await expect(
      jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `mutation($input: CreatePostInput!) { createPost(input: $input) { ref { rawId } } }`,
            variables: {
              input: {
                origin: "https://example.test",
                sessionId: testSession.id,
                content: "Poll",
                poll: {
                  options: ["Yes", "No"],
                  multiple: false,
                  expiresInSeconds: 3600,
                },
              },
            },
          }),
        }),
      ),
    ).resolves.toMatchObject({ data: { createPost: { ref: { rawId: "post-1" } } } });
    const mediaForm = new FormData();
    mediaForm.set("origin", "https://example.test");
    mediaForm.set("file", new Blob(["x"], { type: "image/png" }), "from-part.png");
    await expect(
      jsonRequest(
        app.request("/api/v1/media", {
          method: "POST",
          headers: { authorization: `Bearer ${testSession.id}` },
          body: mediaForm,
        }),
      ),
    ).resolves.toMatchObject({ data: { ref: { rawId: "media-1" } } });
    expect(seenMediaInputs.at(-1)).toMatchObject({
      filename: "from-part.png",
    });
    await expect(
      jsonRequest(
        app.request(`/api/v1/polls/${testPoll.ref.id}/votes`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${testSession.id}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ choices: [1] }),
        }),
      ),
    ).resolves.toMatchObject({ data: { ref: { rawId: "poll-1" } } });
    await expect(
      jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `mutation($input: VotePollInput!) { votePoll(input: $input) { ref { rawId } } }`,
            variables: {
              input: {
                id: testPoll.ref.id,
                sessionId: testSession.id,
                choices: [0],
              },
            },
          }),
        }),
      ),
    ).resolves.toMatchObject({ data: { votePoll: { ref: { rawId: "poll-1" } } } });
    await expect(
      jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `mutation($input: VotePollInput!) { votePoll(input: $input) { ref { rawId } } }`,
            variables: {
              input: {
                id: testPoll.ref.id,
                sessionId: testSession.id,
                choices: [],
              },
            },
          }),
        }),
      ),
    ).resolves.toMatchObject({
      errors: [
        {
          extensions: {
            activityplug: { code: "VALIDATION_FAILED" },
          },
        },
      ],
    });
    await expect(
      jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `mutation($input: VotePollInput!) { votePoll(input: $input) { ref { rawId } } }`,
            variables: {
              input: {
                id: testPoll.ref.id,
                sessionId: testSession.id,
                choices: [-1],
              },
            },
          }),
        }),
      ),
    ).resolves.toMatchObject({
      errors: [
        {
          extensions: {
            activityplug: { code: "VALIDATION_FAILED" },
          },
        },
      ],
    });
    expect(seenVoteInputs).toEqual([
      { id: testPoll.ref.id, sessionId: testSession.id, choices: [1] },
      { id: testPoll.ref.id, sessionId: testSession.id, choices: [0] },
    ]);
    expect(seenCreateInputs).toEqual([
      {
        origin: "https://example.test",
        sessionId: testSession.id,
        content: "",
        mediaIds: ["media-1"],
      },
      {
        origin: "https://example.test",
        sessionId: testSession.id,
        content: "Poll",
        poll: {
          options: ["Yes", "No"],
          multiple: false,
          expiresInSeconds: 3600,
        },
      },
    ]);
  });
});
