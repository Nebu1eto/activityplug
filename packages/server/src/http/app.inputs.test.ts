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
  it("keeps the synchronous OAuth callback parser input signal-free", async () => {
    const base = createTestService();
    let seen: unknown;
    const app = createActivityPlugApp({
      service: createTestService({
        auth: {
          ...base.auth,
          parseCallback: (input) => {
            seen = input;
            if (typeof input !== "object" || input === null || Object.hasOwn(input, "signal")) {
              throw new TypeError("OAuth callback input must remain exact.");
            }
            return base.auth.parseCallback(input);
          },
        },
      }),
    });

    const response = await app.request("/api/v1/auth/parse-callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: { code: "code", state: "state" } }),
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual({ params: { code: "code", state: "state" } });
  });

  it("rejects legacy session credentials and accepts bearer authentication", async () => {
    const seen: unknown[] = [];
    const app = createActivityPlugApp({
      service: createTestService({
        viewer: async (input) => {
          seen.push(input);
          return { account: testViewerAccount, session: testSession };
        },
      }),
    });

    for (const path of [
      `/api/v1/posts/${encodeURIComponent(testPost.ref.id)}?sessionId=query-secret`,
      "/api/v1/timelines/public?origin=https://example.test&sessionId=query-secret",
      "/api/v1/streams?sessionId=query-secret",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED" },
      });
    }

    const bodyCredential = await app.request("/api/v1/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: "https://example.test",
        content: "hello",
        sessionId: "body-secret",
      }),
    });
    expect(bodyCredential.status).toBe(400);
    await expect(bodyCredential.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const bearerResponse = await app.request("/api/v1/viewer", {
      headers: { authorization: `Bearer ${testSession.id}` },
    });
    expect(bearerResponse.status).toBe(200);
    expect(withoutRequestSignals(seen)).toEqual([{ sessionId: testSession.id }]);
  });

  it("exposes no GraphQL sessionId argument or input field", async () => {
    const app = createActivityPlugApp({ service: createTestService() });
    const response = (await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `{ __schema {
            queryType { fields { name args { name } } }
            mutationType { fields { name args { name } } }
            subscriptionType { fields { name args { name } } }
            types { name inputFields { name } }
          } }`,
        }),
      }),
    )) as {
      readonly data: {
        readonly __schema: {
          readonly queryType: {
            readonly fields: readonly {
              readonly name: string;
              readonly args: readonly { readonly name: string }[];
            }[];
          };
          readonly mutationType: {
            readonly fields: readonly {
              readonly name: string;
              readonly args: readonly { readonly name: string }[];
            }[];
          };
          readonly subscriptionType: {
            readonly fields: readonly {
              readonly name: string;
              readonly args: readonly { readonly name: string }[];
            }[];
          };
          readonly types: readonly {
            readonly name: string;
            readonly inputFields?: readonly { readonly name: string }[] | null;
          }[];
        };
      };
    };
    const schema = response.data["__schema"];
    const credentialFields = [
      ...schema.queryType.fields.flatMap((field) =>
        field.args.map((arg) => `${field.name}.${arg.name}`),
      ),
      ...schema.mutationType.fields.flatMap((field) =>
        field.args.map((arg) => `${field.name}.${arg.name}`),
      ),
      ...schema.subscriptionType.fields.flatMap((field) =>
        field.args.map((arg) => `${field.name}.${arg.name}`),
      ),
      ...schema.types.flatMap((type) =>
        (type.inputFields ?? []).map((field) => `${type.name}.${field.name}`),
      ),
    ].filter((name) => name.endsWith(".sessionId"));

    expect(credentialFields).toEqual([]);
  });

  it("keeps operation inputs narrow at the HTTP and GraphQL boundaries", async () => {
    const seenMuteInputs: unknown[] = [];
    const seenCreateInputs: unknown[] = [];
    const seenMediaInputs: unknown[] = [];
    const seenSearchInputs: unknown[] = [];
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
        search: {
          search: async (input) => {
            seenSearchInputs.push(input);
            return {
              accounts: [],
              posts: [],
              hashtags: [],
              pageInfo: { hasNextPage: false, hasPreviousPage: false },
              raw: {},
            };
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
      "/api/v1/search?origin=https://example.test&q=alice&after=opaque%3A%2B%2F%3D%3Fcursor&limit=999",
    );
    expect(searchCursorResponse.status).toBe(200);
    expect(withoutRequestSignals(seenSearchInputs)).toEqual([
      {
        origin: "https://example.test",
        query: "alice",
        page: { after: "opaque:+/=?cursor", limit: 100 },
      },
    ]);

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

    const invalidScheduledPostResponse = await app.request("/api/v1/scheduled-posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: "https://example.test",
        content: "later",
        scheduledAt: "2026-04-31T00:00:00Z",
      }),
    });
    expect(invalidScheduledPostResponse.status).toBe(400);
    await expect(invalidScheduledPostResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    for (const path of [
      "/api/v1/instances/https%3A%2F%2Fexample.test?adapter=",
      "/api/v1/accounts/lookup?origin=https://example.test&handle=alice@example.test&adapter=",
      `/api/v1/accounts/${encodeURIComponent(testViewerAccount.ref.id)}/posts?sessionId=`,
      `/api/v1/posts/${encodeURIComponent(testPost.ref.id)}/history?sessionId=`,
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

    const conflictingPollSession = await app.request(
      `/api/v1/polls/${testPoll.ref.id}?sessionId=other-session`,
      {
        headers: { authorization: `Bearer ${testSession.id}` },
      },
    );
    expect(conflictingPollSession.status).toBe(400);
    await expect(conflictingPollSession.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const seenPostHistoryInputs: unknown[] = [];
    const postHistoryApp = createActivityPlugApp({
      service: createTestService({
        posts: {
          ...createTestService().posts,
          history: async (input) => {
            seenPostHistoryInputs.push(input);
            return [];
          },
        },
      }),
    });
    const postHistoryResponse = await postHistoryApp.request(
      `/api/v1/posts/${encodeURIComponent(testPost.ref.id)}/history`,
    );
    expect(postHistoryResponse.status).toBe(200);
    const authenticatedPostHistory = await postHistoryApp.request(
      `/api/v1/posts/${encodeURIComponent(testPost.ref.id)}/history`,
      {
        headers: { authorization: `Bearer ${testSession.id}` },
      },
    );
    expect(authenticatedPostHistory.status).toBe(200);
    expect(withoutRequestSignals(seenPostHistoryInputs)).toEqual([
      { id: testPost.ref.id },
      { id: testPost.ref.id, sessionId: testSession.id },
    ]);
    const legacyPostHistorySession = await postHistoryApp.request(
      `/api/v1/posts/${encodeURIComponent(testPost.ref.id)}/history?sessionId=other-session`,
    );
    expect(legacyPostHistorySession.status).toBe(400);
    await expect(legacyPostHistorySession.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const seenNotificationInputs: unknown[] = [];
    const notificationApp = createActivityPlugApp({
      service: createTestService({
        notifications: {
          ...createTestService().notifications,
          list: async (input) => {
            seenNotificationInputs.push(input);
            return { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } };
          },
        },
      }),
    });
    const blankNotificationType = await notificationApp.request(
      "/api/v1/notifications?origin=https://example.test&type=",
      { headers: { authorization: `Bearer ${testSession.id}` } },
    );
    expect(blankNotificationType.status).toBe(400);
    const mixedNotificationTypes = await notificationApp.request(
      "/api/v1/notifications?origin=https://example.test&type=mention&types=follow,reblog",
      { headers: { authorization: `Bearer ${testSession.id}` } },
    );
    expect(mixedNotificationTypes.status).toBe(200);
    expect(withoutRequestSignals(seenNotificationInputs)).toEqual([
      {
        origin: "https://example.test",
        sessionId: testSession.id,
        types: ["mention", "follow", "reblog"],
      },
    ]);

    for (const body of [
      {
        origin: "https://example.test",
        title: "Muted words",
        context: [],
        keywords: [{ keyword: "spoiler" }],
      },
      {
        origin: "https://example.test",
        title: "Muted words",
        context: ["home"],
        keywords: [],
      },
    ]) {
      const invalidFilterResponse = await app.request("/api/v1/filters", {
        method: "POST",
        headers: {
          authorization: `Bearer ${testSession.id}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(invalidFilterResponse.status).toBe(400);
      await expect(invalidFilterResponse.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED" },
      });
    }

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
    expect(withoutRequestSignals(seenMuteInputs)).toEqual([
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
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation($input: UploadMediaInput!) { uploadMedia(input: $input) { ref { rawId } } }`,
        variables: {
          input: {
            origin: "https://example.test",
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
        poll: { options: ["yes", " "], expiresInSeconds: 300 },
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
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation($input: CreatePostInput!) { createPost(input: $input) { ref { rawId } } }`,
        variables: {
          input: {
            origin: "https://example.test",
            content: "",
            poll: { options: [], expiresInSeconds: 300 },
          },
        },
      }),
    });
    expect(
      getFirstGraphQLError(await jsonRequest(invalidGraphQLPoll)).extensions.activityplug,
    ).toEqual(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    const blankGraphQLContent = await app.request("/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation($input: CreatePostInput!) { createPost(input: $input) { ref { rawId } } }`,
        variables: {
          input: {
            origin: "https://example.test",
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
    expect(inputTypeName(introspection, "query", "accountPosts", "sessionId")).toBeUndefined();
    expect(inputFieldTypeName(introspection, "SearchInput", "sessionId")).toBeUndefined();
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
    expect(searchCursorGraphQL).toMatchObject({ data: { search: { accounts: [] } } });
    expect(withoutRequestSignals([seenSearchInputs.at(-1)])[0]).toEqual({
      origin: "https://example.test",
      query: "alice",
      page: { after: "remote" },
    });

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
          headers: {
            authorization: `Bearer ${testSession.id}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: `mutation($input: CreatePostInput!) { createPost(input: $input) { ref { rawId } } }`,
            variables: {
              input: {
                origin: "https://example.test",
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
          headers: {
            authorization: `Bearer ${testSession.id}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: `mutation($input: VotePollInput!) { votePoll(input: $input) { ref { rawId } } }`,
            variables: {
              input: {
                id: testPoll.ref.id,
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
          headers: {
            authorization: `Bearer ${testSession.id}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: `mutation($input: VotePollInput!) { votePoll(input: $input) { ref { rawId } } }`,
            variables: {
              input: {
                id: testPoll.ref.id,
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
          headers: {
            authorization: `Bearer ${testSession.id}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: `mutation($input: VotePollInput!) { votePoll(input: $input) { ref { rawId } } }`,
            variables: {
              input: {
                id: testPoll.ref.id,
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
    expect(withoutRequestSignals(seenVoteInputs)).toEqual([
      { id: testPoll.ref.id, sessionId: testSession.id, choices: [1] },
      { id: testPoll.ref.id, sessionId: testSession.id, choices: [0] },
    ]);
    expect(withoutRequestSignals(seenCreateInputs)).toEqual([
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

  it("accepts optional bearer auth for post reads without credential inputs", async () => {
    const seen: unknown[] = [];
    const app = createActivityPlugApp({
      service: createTestService({
        posts: {
          ...createTestService().posts,
          get: async (input) => {
            seen.push(input);
            return testPost;
          },
        },
      }),
    });
    const path = `/api/v1/posts/${encodeURIComponent(testPost.ref.id)}`;
    const query = `query($id: ID!) { post(id: $id) { ref { id } } }`;
    const graphQLBody = JSON.stringify({ query, variables: { id: testPost.ref.id } });

    await expect(jsonRequest(app.request(path))).resolves.toMatchObject({
      data: { ref: { id: testPost.ref.id } },
    });
    await expect(
      jsonRequest(
        app.request(path, {
          headers: { authorization: `Bearer ${testSession.id}` },
        }),
      ),
    ).resolves.toMatchObject({ data: { ref: { id: testPost.ref.id } } });
    await expect(jsonRequest(app.request(`${path}?sessionId=query-secret`))).resolves.toMatchObject(
      {
        error: { code: "VALIDATION_FAILED" },
      },
    );
    for (const authorization of [undefined, `Bearer ${testSession.id}`]) {
      await expect(
        jsonRequest(
          app.request("/graphql", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authorization === undefined ? {} : { authorization }),
            },
            body: graphQLBody,
          }),
        ),
      ).resolves.toMatchObject({ data: { post: { ref: { id: testPost.ref.id } } } });
    }
    expect(withoutRequestSignals(seen)).toEqual([
      { id: testPost.ref.id },
      { id: testPost.ref.id, sessionId: testSession.id },
      { id: testPost.ref.id },
      { id: testPost.ref.id, sessionId: testSession.id },
    ]);

    await expect(
      jsonRequest(app.request(path, { headers: { authorization: "Basic malformed" } })),
    ).resolves.toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    await expect(
      jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: {
            authorization: "Basic malformed",
            "content-type": "application/json",
          },
          body: graphQLBody,
        }),
      ),
    ).resolves.toMatchObject({
      errors: [{ extensions: { activityplug: { code: "AUTH_REQUIRED" } } }],
    });
    expect(seen).toHaveLength(4);

    const graphQLCredentialArgument = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `query($id: ID!, $sessionId: ID!) {
          post(id: $id, sessionId: $sessionId) { ref { id } }
        }`,
        variables: { id: testPost.ref.id, sessionId: "body-secret" },
      }),
    });
    expect(graphQLCredentialArgument.status).toBe(400);
    const operation = createOpenApiDocument({ tokenImport: "open" }).paths["/api/v1/posts/{id}"]
      .get;
    expect(
      (operation.parameters as readonly { readonly name?: string }[]).map(
        (parameter) => parameter.name,
      ),
    ).not.toContain("sessionId");
    expect(operation).not.toHaveProperty("requestBody");
  });
});

function withoutRequestSignals(inputs: readonly unknown[]): unknown[] {
  return inputs.map((input) => {
    expect(input).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const { signal: _signal, ...narrowInput } = input as Readonly<Record<string, unknown>>;
    return narrowInput;
  });
}
