import {
  type ActivityPlugAdapter,
  type CapabilityName,
  createActivityPlug,
  createEntityRef,
  type CapabilitySet,
} from "@activityplug/core";
import {
  type AdapterE2ETarget,
  fediverseE2EEnabled,
  targetsForAdapter,
} from "@activityplug/e2e-fixtures";
import { createHackersPubAdapter } from "@activityplug/hackerspub";
import { createHolloAdapter } from "@activityplug/hollo";
import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";
import { createPleromaAdapter } from "@activityplug/pleroma";
import { describe, expect, it } from "vitest";

import { expectCapabilitySurfaces } from "./e2e-capabilities.js";
import { expectMediaSurfaces } from "./e2e-media.js";
import { expectPollSurfaces } from "./e2e-polls.js";
import {
  expectSupportedAccountSocialActions,
  expectSupportedPostSocialActions,
  expectSupportedPostSocialActionsGraphQL,
  hasSupportedAccountSocialAction,
  hasSupportedPostSocialAction,
} from "./e2e-social.js";
import { type E2EFetch, isRecord, postGraphQL, readJsonData } from "./e2e-utils.js";
import { createActivityPlugServer } from "./runtime/server.js";

const targets = [
  ...targetsForAdapter("mastodon").map((target) => ({
    target,
    adapter: createMastodonAdapter(),
  })),
  ...targetsForAdapter("misskey").map((target) => ({
    target,
    adapter: createMisskeyAdapter(),
  })),
  ...targetsForAdapter("pleroma").map((target) => ({
    target,
    adapter: createPleromaAdapter(),
  })),
  ...targetsForAdapter("hollo").map((target) => ({
    target,
    adapter: createHolloAdapter(),
  })),
  ...targetsForAdapter("hackerspub").map((target) => ({
    target,
    adapter: createHackersPubAdapter(),
  })),
];

describe.runIf(fediverseE2EEnabled)("server Fediverse E2E surfaces", () => {
  it.each(targets)(
    "serves HTTP and GraphQL read surfaces for $target.adapter",
    async ({ target, adapter }) => {
      await expectServerBaseline(target, adapter);
    },
    60_000,
  );
});

async function expectServerBaseline(
  target: AdapterE2ETarget,
  adapter: ActivityPlugAdapter,
): Promise<void> {
  const client = createActivityPlug({
    adapter,
    origin: target.origin,
  });
  const server = createActivityPlugServer({
    adapters: [adapter],
    originPolicy: () => {},
    tokenImport: { enabled: true },
  });
  const session =
    target.token === undefined ? undefined : await importTokenOverHttp(server.app.fetch, target);
  const graphqlSession =
    target.token === undefined ? undefined : await importTokenOverGraphQL(server.app.fetch, target);
  const capabilities = await expectCapabilitySurfaces(
    server.app.fetch,
    target,
    client.capabilities,
  );
  requireSessionsForAuthenticatedCapabilities(target, capabilities, session, graphqlSession);
  const encodedOrigin = encodeURIComponent(target.origin);
  const instanceResponse = await server.app.fetch(
    new Request(`http://activityplug.test/api/v1/instances/${encodedOrigin}`),
  );

  expect(instanceResponse.status).toBe(200);
  expect(await readJsonData(instanceResponse)).toMatchObject({
    software: { name: expect.any(String) },
  });

  const graphqlInstance = await postGraphQL(server.app.fetch, {
    query: "query($origin: String!) { instance(origin: $origin) { software } }",
    variables: { origin: target.origin },
  });
  expect(graphqlInstance["data"]).toMatchObject({
    instance: { software: { name: expect.any(String) } },
  });

  if (isSupported(capabilities, "timelines.public")) {
    const publicTimelineResponse = await server.app.fetch(
      new Request(
        `http://activityplug.test/api/v1/timelines/public?origin=${encodeURIComponent(
          target.origin,
        )}&limit=5${session === undefined ? "" : `&sessionId=${encodeURIComponent(session.id)}`}`,
      ),
    );
    expect(publicTimelineResponse.status).toBe(200);
    expect(await readJsonData(publicTimelineResponse)).toEqual(expect.any(Array));

    const graphqlPublicTimeline = await postGraphQL(server.app.fetch, {
      query:
        "query($origin: String!, $sessionId: ID) { publicTimeline(origin: $origin, sessionId: $sessionId, page: { limit: 5 }) { nodes { ref { origin rawId } } } }",
      variables: { origin: target.origin, sessionId: graphqlSession?.id },
    });
    expect(graphqlPublicTimeline["data"]).toMatchObject({
      publicTimeline: { nodes: expect.any(Array) },
    });
  }

  if (isSupported(capabilities, "timelines.local")) {
    const localTimelineResponse = await server.app.fetch(
      new Request(
        `http://activityplug.test/api/v1/timelines/local?origin=${encodeURIComponent(
          target.origin,
        )}&limit=5${session === undefined ? "" : `&sessionId=${encodeURIComponent(session.id)}`}`,
      ),
    );
    expect(localTimelineResponse.status).toBe(200);
    expect(await readJsonData(localTimelineResponse)).toEqual(expect.any(Array));

    const graphqlLocalTimeline = await postGraphQL(server.app.fetch, {
      query:
        "query($origin: String!, $sessionId: ID) { publicTimeline(origin: $origin, sessionId: $sessionId, local: true, page: { limit: 5 }) { nodes { ref { origin rawId } } } }",
      variables: { origin: target.origin, sessionId: graphqlSession?.id },
    });
    expect(graphqlLocalTimeline["data"]).toMatchObject({
      publicTimeline: { nodes: expect.any(Array) },
    });
  }

  if (isSupported(capabilities, "timelines.hashtag")) {
    if (target.hashtag === undefined) {
      throw new TypeError("Fediverse server E2E target must provide hashtag.");
    }
    const hashtagTimelineResponse = await server.app.fetch(
      new Request(
        `http://activityplug.test/api/v1/timelines/hashtags/${encodeURIComponent(
          target.hashtag,
        )}?origin=${encodeURIComponent(target.origin)}&limit=5`,
      ),
    );
    expect(hashtagTimelineResponse.status).toBe(200);
    expect(await readJsonData(hashtagTimelineResponse)).toEqual(expect.any(Array));

    const graphqlHashtagTimeline = await postGraphQL(server.app.fetch, {
      query:
        "query($origin: String!, $tag: String!) { hashtagTimeline(origin: $origin, tag: $tag, page: { limit: 5 }) { nodes { ref { origin rawId } } } }",
      variables: { origin: target.origin, tag: target.hashtag },
    });
    expect(graphqlHashtagTimeline["data"]).toMatchObject({
      hashtagTimeline: { nodes: expect.any(Array) },
    });
  }

  if (session !== undefined && isSupported(capabilities, "timelines.home")) {
    const homeTimelineResponse = await server.app.fetch(
      new Request("http://activityplug.test/api/v1/timelines/home?limit=5", {
        headers: { authorization: `Bearer ${session.id}` },
      }),
    );
    expect(homeTimelineResponse.status).toBe(200);
    expect(await readJsonData(homeTimelineResponse)).toEqual(expect.any(Array));

    const graphqlHomeTimeline = await postGraphQL(server.app.fetch, {
      query:
        "query($origin: String!, $sessionId: ID!) { homeTimeline(origin: $origin, sessionId: $sessionId, page: { limit: 5 }) { nodes { ref { origin rawId } } } }",
      variables: { origin: target.origin, sessionId: session.id },
    });
    expect(graphqlHomeTimeline["data"]).toMatchObject({
      homeTimeline: { nodes: expect.any(Array) },
    });
  }

  if (session !== undefined) {
    const viewerResponse = await server.app.fetch(
      new Request("http://activityplug.test/api/v1/viewer", {
        headers: { authorization: `Bearer ${session.id}` },
      }),
    );
    expect(viewerResponse.status).toBe(200);
    expect(await readJsonData(viewerResponse)).toMatchObject({ ref: { origin: target.origin } });
  }

  if (graphqlSession !== undefined) {
    const graphqlViewer = await postGraphQL(server.app.fetch, {
      query: "query($sessionId: ID!) { viewer(sessionId: $sessionId) { ref { origin } } }",
      variables: { sessionId: graphqlSession.id },
    });
    expect(graphqlViewer["data"]).toMatchObject({ viewer: { ref: { origin: target.origin } } });
  }

  await expectPollSurfaces(server.app.fetch, target, capabilities, session?.id, graphqlSession?.id);

  const mediaIds =
    session !== undefined && isSupported(capabilities, "media.upload")
      ? await expectMediaSurfaces(server.app.fetch, target, session.id, graphqlSession?.id)
      : undefined;

  const checksPostSocialActions =
    session !== undefined &&
    graphqlSession !== undefined &&
    hasSupportedPostSocialAction((name) => isSupported(capabilities, name as CapabilityName));
  let checkedPostSocialActions = false;

  if (
    session !== undefined &&
    isSupported(capabilities, "posts.create") &&
    isSupported(capabilities, "posts.delete")
  ) {
    const httpCreated = await createPostOverHttp(
      server.app.fetch,
      target,
      session.id,
      mediaIds?.httpMediaId,
    );
    if (target.adapter === "misskey") await waitForPostOverHttp(server.app.fetch, httpCreated);
    await expectSupportedPostSocialActions(
      server.app.fetch,
      target,
      (name) => isSupported(capabilities, name as CapabilityName),
      httpCreated,
      session.id,
      waitForPostOverHttp,
    );
    await deletePostOverHttp(server.app.fetch, httpCreated, session.id);

    if (graphqlSession !== undefined) {
      const graphqlCreated = await createPostOverGraphQL(
        server.app.fetch,
        target,
        graphqlSession.id,
        mediaIds?.graphqlMediaId,
      );
      if (target.adapter === "misskey") await waitForPostOverHttp(server.app.fetch, graphqlCreated);
      await expectSupportedPostSocialActionsGraphQL(
        server.app.fetch,
        target,
        (name) => isSupported(capabilities, name as CapabilityName),
        graphqlCreated,
        graphqlSession.id,
        postGraphQL,
        waitForPostOverHttp,
      );
      await deletePostOverGraphQL(server.app.fetch, graphqlCreated, graphqlSession.id);
    }
    checkedPostSocialActions = true;
  } else if (session !== undefined && isSupported(capabilities, "posts.delete")) {
    if (target.httpDeletePostId === undefined || target.graphqlDeletePostId === undefined) {
      throw new TypeError("Fediverse server E2E target must provide delete post ids.");
    }
    if (target.httpDeletePostId !== undefined) {
      await deletePostOverHttp(
        server.app.fetch,
        publicPostId(target, target.httpDeletePostId),
        session.id,
      );
    }
    if (graphqlSession !== undefined && target.graphqlDeletePostId !== undefined) {
      await deletePostOverGraphQL(
        server.app.fetch,
        publicPostId(target, target.graphqlDeletePostId),
        graphqlSession.id,
      );
    }
  }

  if (
    session !== undefined &&
    isSupported(capabilities, "posts.create") &&
    isSupported(capabilities, "posts.delete") &&
    isSupported(capabilities, "polls.create")
  ) {
    const httpPollPost = await createPollPostOverHttp(server.app.fetch, target, session.id);
    await deletePostOverHttp(server.app.fetch, httpPollPost, session.id);
    if (graphqlSession !== undefined) {
      const graphqlPollPost = await createPollPostOverGraphQL(
        server.app.fetch,
        target,
        graphqlSession.id,
      );
      await deletePostOverGraphQL(server.app.fetch, graphqlPollPost, graphqlSession.id);
    }
  }

  if (
    session !== undefined &&
    graphqlSession !== undefined &&
    checksPostSocialActions &&
    !checkedPostSocialActions
  ) {
    const seededPostId = await ownedSeededPostId(
      server.app.fetch,
      target,
      capabilities,
      session.id,
    );
    if (seededPostId === undefined) {
      throw new TypeError("Fediverse server E2E target must provide a seeded post.");
    }
    await expectSupportedPostSocialActions(
      server.app.fetch,
      target,
      (name) => isSupported(capabilities, name as CapabilityName),
      seededPostId,
      session.id,
      waitForPostOverHttp,
    );
    await expectSupportedPostSocialActionsGraphQL(
      server.app.fetch,
      target,
      (name) => isSupported(capabilities, name as CapabilityName),
      seededPostId,
      graphqlSession.id,
      postGraphQL,
      waitForPostOverHttp,
    );
  }

  if (target.accountHandle !== undefined && isSupported(capabilities, "search.accounts")) {
    const expectedAccountId = await accountIdByHandleOverHttp(
      server.app.fetch,
      target,
      target.accountHandle,
    );
    const searchResponse = await server.app.fetch(
      new Request(
        `http://activityplug.test/api/v1/search?origin=${encodeURIComponent(
          target.origin,
        )}&q=${encodeURIComponent(target.accountHandle)}&type=accounts&limit=5${
          session === undefined ? "" : `&sessionId=${encodeURIComponent(session.id)}`
        }`,
      ),
    );
    expect(searchResponse.status).toBe(200);
    const search = await readJsonData(searchResponse);
    expect(accountRefIds(search)).toContain(expectedAccountId);

    const graphqlSearch = await postGraphQL(server.app.fetch, {
      query:
        "query($input: SearchInput!) { search(input: $input) { accounts { ref { id origin rawId } } } }",
      variables: {
        input: {
          origin: target.origin,
          query: target.accountHandle,
          type: "ACCOUNTS",
          ...(session === undefined ? {} : { sessionId: session.id }),
          page: { limit: 5 },
        },
      },
    });
    expect(graphqlAccountRefIds(graphqlSearch)).toContain(expectedAccountId);
  }

  if (isSupported(capabilities, "search.hashtags")) {
    if (target.hashtag === undefined) {
      throw new TypeError("Fediverse server E2E target must provide hashtag for hashtag search.");
    }
    const hashtagSearchResponse = await server.app.fetch(
      new Request(
        `http://activityplug.test/api/v1/search?origin=${encodeURIComponent(
          target.origin,
        )}&q=${encodeURIComponent(target.hashtag)}&type=hashtags&limit=5${
          session === undefined ? "" : `&sessionId=${encodeURIComponent(session.id)}`
        }`,
      ),
    );
    expect(hashtagSearchResponse.status).toBe(200);
    const hashtagSearch = await readJsonData(hashtagSearchResponse);
    expect(hashtagNames(hashtagSearch)).toContain(normalizedHashtag(target.hashtag));

    const graphqlHashtagSearch = await postGraphQL(server.app.fetch, {
      query: "query($input: SearchInput!) { search(input: $input) { hashtags { name } } }",
      variables: {
        input: {
          origin: target.origin,
          query: target.hashtag,
          type: "HASHTAGS",
          ...(session === undefined ? {} : { sessionId: session.id }),
          page: { limit: 5 },
        },
      },
    });
    const hashtags = (
      graphqlHashtagSearch["data"] as { readonly search?: { readonly hashtags?: unknown[] } }
    ).search?.hashtags;
    expect(hashtagNames({ hashtags })).toContain(normalizedHashtag(target.hashtag));
  }
  if (
    isSupported(capabilities, "search.accounts") &&
    isSupported(capabilities, "search.posts") &&
    isSupported(capabilities, "search.hashtags")
  ) {
    if (target.hashtag === undefined) {
      throw new TypeError("Fediverse server E2E target must provide hashtag for broad search.");
    }
    if (target.accountHandle === undefined) {
      throw new TypeError(
        "Fediverse server E2E target must provide accountHandle for broad search.",
      );
    }
    if (target.postSearchQuery === undefined || target.postSearchRawId === undefined) {
      throw new TypeError(
        "Fediverse server E2E target must provide post search data for broad search.",
      );
    }
    const expectedBroadAccountId = await accountIdByHandleOverHttp(
      server.app.fetch,
      target,
      target.accountHandle,
    );
    const broadAccountSearchResponse = await server.app.fetch(
      new Request(
        `http://activityplug.test/api/v1/search?origin=${encodeURIComponent(
          target.origin,
        )}&q=${encodeURIComponent(target.accountHandle)}&limit=5${
          session === undefined ? "" : `&sessionId=${encodeURIComponent(session.id)}`
        }`,
      ),
    );
    expect(broadAccountSearchResponse.status).toBe(200);
    expect(accountRefIds(await readJsonData(broadAccountSearchResponse))).toContain(
      expectedBroadAccountId,
    );
    const broadPostSearchResponse = await server.app.fetch(
      new Request(
        `http://activityplug.test/api/v1/search?origin=${encodeURIComponent(
          target.origin,
        )}&q=${encodeURIComponent(target.postSearchQuery)}&limit=5${
          session === undefined ? "" : `&sessionId=${encodeURIComponent(session.id)}`
        }`,
      ),
    );
    expect(broadPostSearchResponse.status).toBe(200);
    expect(postRawIds(await readJsonData(broadPostSearchResponse))).toContain(
      target.postSearchRawId,
    );
    const broadHashtagSearchResponse = await server.app.fetch(
      new Request(
        `http://activityplug.test/api/v1/search?origin=${encodeURIComponent(
          target.origin,
        )}&q=${encodeURIComponent(target.hashtag)}&limit=5${
          session === undefined ? "" : `&sessionId=${encodeURIComponent(session.id)}`
        }`,
      ),
    );
    expect(broadHashtagSearchResponse.status).toBe(200);
    const broadSearchResult = await readJsonData(broadHashtagSearchResponse);
    expect(hashtagNames(broadSearchResult)).toContain(normalizedHashtag(target.hashtag));

    const broadAccountSearch = await postGraphQL(server.app.fetch, {
      query: "query($input: SearchInput!) { search(input: $input) { accounts { ref { id } } } }",
      variables: {
        input: {
          origin: target.origin,
          query: target.accountHandle,
          ...(session === undefined ? {} : { sessionId: session.id }),
          page: { limit: 5 },
        },
      },
    });
    expect(graphqlAccountRefIds(broadAccountSearch)).toContain(expectedBroadAccountId);

    const broadPostSearch = await postGraphQL(server.app.fetch, {
      query: "query($input: SearchInput!) { search(input: $input) { posts { ref { rawId } } } }",
      variables: {
        input: {
          origin: target.origin,
          query: target.postSearchQuery,
          ...(session === undefined ? {} : { sessionId: session.id }),
          page: { limit: 5 },
        },
      },
    });
    const broadPosts = (
      broadPostSearch["data"] as { readonly search?: { readonly posts?: unknown[] } }
    ).search?.posts;
    expect(postRawIds({ posts: broadPosts })).toContain(target.postSearchRawId);

    const broadHashtagSearch = await postGraphQL(server.app.fetch, {
      query: "query($input: SearchInput!) { search(input: $input) { hashtags { name } } }",
      variables: {
        input: {
          origin: target.origin,
          query: target.hashtag,
          ...(session === undefined ? {} : { sessionId: session.id }),
          page: { limit: 5 },
        },
      },
    });
    const broadHashtags = (
      broadHashtagSearch["data"] as { readonly search?: { readonly hashtags?: unknown[] } }
    ).search?.hashtags;
    expect(hashtagNames({ hashtags: broadHashtags })).toContain(normalizedHashtag(target.hashtag));
  }

  if (
    session !== undefined &&
    graphqlSession !== undefined &&
    isSupported(capabilities, "accounts.lookupByHandle")
  ) {
    if (
      target.socialActionHandle === undefined &&
      hasSupportedAccountSocialAction((name) => isSupported(capabilities, name as CapabilityName))
    ) {
      throw new TypeError("Fediverse server E2E target must provide socialActionHandle.");
    }
    if (target.socialActionHandle !== undefined) {
      const accountId = await accountIdByHandleOverHttp(
        server.app.fetch,
        target,
        target.socialActionHandle,
      );
      await expectSupportedAccountSocialActions(
        server.app.fetch,
        (name) => isSupported(capabilities, name as CapabilityName),
        accountId,
        session.id,
        graphqlSession.id,
        postGraphQL,
      );
    }
  }

  if (!isSupported(capabilities, "search.posts")) return;
  if (target.postSearchQuery === undefined) {
    throw new TypeError("Fediverse server E2E target must provide postSearchQuery.");
  }
  if (target.postSearchRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide postSearchRawId.");
  }

  const postSearchResponse = await server.app.fetch(
    new Request(
      `http://activityplug.test/api/v1/search?origin=${encodeURIComponent(
        target.origin,
      )}&q=${encodeURIComponent(target.postSearchQuery)}&type=posts&limit=5${
        session === undefined ? "" : `&sessionId=${encodeURIComponent(session.id)}`
      }`,
    ),
  );
  expect(postSearchResponse.status).toBe(200);
  const postSearch = await readJsonData(postSearchResponse);
  expect(postSearch).toMatchObject({ posts: expect.any(Array) });
  expect(postRawIds(postSearch)).toContain(target.postSearchRawId);

  const graphqlPostSearch = await postGraphQL(server.app.fetch, {
    query:
      "query($input: SearchInput!) { search(input: $input) { posts { ref { rawId } url contentText contentHtml } } }",
    variables: {
      input: {
        origin: target.origin,
        query: target.postSearchQuery,
        type: "POSTS",
        ...(session === undefined ? {} : { sessionId: session.id }),
        page: { limit: 5 },
      },
    },
  });
  expect(graphqlPostSearch["data"]).toMatchObject({
    search: { posts: expect.any(Array) },
  });
  const posts = (graphqlPostSearch["data"] as { readonly search?: { readonly posts?: unknown[] } })
    .search?.posts;
  expect(postRawIds({ posts })).toContain(target.postSearchRawId);
}

function isSupported(capabilities: CapabilitySet, name: CapabilityName): boolean {
  return capabilities[name]?.status === "supported";
}

function requireSessionsForAuthenticatedCapabilities(
  target: AdapterE2ETarget,
  capabilities: CapabilitySet,
  session: { readonly id: string } | undefined,
  graphqlSession: { readonly id: string } | undefined,
): void {
  const requiresSession = [
    "auth.tokenInjection",
    "timelines.home",
    "media.upload",
    "posts.create",
    "posts.delete",
    "polls.vote",
    "accounts.relationships",
    "social.follow",
    "social.block",
    "social.mute",
    "social.favourite",
    "social.bookmark",
    "social.boost",
    "social.reaction",
  ].some((capability) => isSupported(capabilities, capability as CapabilityName));
  if (requiresSession && (session === undefined || graphqlSession === undefined)) {
    throw new TypeError(
      `Fediverse server E2E target must provide token for authenticated capabilities: ${target.adapter}.`,
    );
  }
}

async function importTokenOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
): Promise<{ readonly id: string }> {
  if (target.token === undefined) throw new TypeError("Token import requires a target token.");
  const response = await fetch(
    new Request("http://activityplug.test/api/v1/auth/import-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: target.origin,
        adapter: target.adapter,
        token: {
          accessToken: target.token,
          tokenType: "Bearer",
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
  return parseSessionId(await readJsonData(response));
}

async function importTokenOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
): Promise<{ readonly id: string }> {
  if (target.token === undefined) throw new TypeError("Token import requires a target token.");
  const result = await postGraphQL(fetch, {
    query:
      "mutation($input: ImportTokenInput!) { importToken(input: $input) { id adapter origin } }",
    variables: {
      input: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        token: {
          accessToken: target.token,
          tokenType: "Bearer",
        },
      },
    },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL importToken response must include data.");
  return parseSessionId(data["importToken"]);
}

function parseSessionId(value: unknown): { readonly id: string } {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    throw new TypeError("Expected an auth session id.");
  }
  return { id: value["id"] };
}

async function createPostOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  mediaId?: string,
): Promise<string> {
  const response = await fetch(
    new Request("http://activityplug.test/api/v1/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${authSessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: target.origin,
        adapter: target.adapter,
        content: `ActivityPlug server HTTP E2E ${Date.now()}`,
        visibility: "public",
        ...(mediaId === undefined ? {} : { mediaIds: [mediaId] }),
      }),
    }),
  );
  expect(response.status).toBe(200);
  const post = await readJsonData(response);
  if (mediaId !== undefined) {
    expect(mediaRefIds(post)).toEqual([mediaId]);
  }
  return refId(post);
}

async function deletePostOverHttp(
  fetch: E2EFetch,
  id: string,
  authSessionId: string,
): Promise<void> {
  const response = await fetch(
    new Request(`http://activityplug.test/api/v1/posts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${authSessionId}` },
    }),
  );
  expect(response.status).toBe(200);
  const deleted = await readJsonData(response);
  expect(deleted).toMatchObject({ deleted: true });
  expect(refId(deleted)).toBe(id);
}

async function createPostOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  mediaId?: string,
): Promise<string> {
  const result = await postGraphQL(fetch, {
    query:
      "mutation($input: CreatePostInput!) { createPost(input: $input) { ref { id origin rawId } media { ref { id } } } }",
    variables: {
      input: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
        content: `ActivityPlug server GraphQL E2E ${Date.now()}`,
        visibility: "PUBLIC",
        ...(mediaId === undefined ? {} : { mediaIds: [mediaId] }),
      },
    },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL createPost response must include data.");
  const created = data["createPost"];
  if (mediaId !== undefined) {
    expect(mediaRefIds(created)).toEqual([mediaId]);
  }
  return refId(created);
}

async function createPollPostOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<string> {
  const response = await fetch(
    new Request("http://activityplug.test/api/v1/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${authSessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: target.origin,
        adapter: target.adapter,
        content: `ActivityPlug server HTTP poll E2E ${Date.now()}`,
        visibility: "public",
        poll: {
          options: ["TypeScript", "ActivityPub"],
          multiple: false,
          expiresInSeconds: 3600,
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
  const post = await readJsonData(response);
  expect(pollRefId(post)).toEqual(expect.any(String));
  expectExpectedPostPollPayload(post);
  return refId(post);
}

async function createPollPostOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<string> {
  const result = await postGraphQL(fetch, {
    query:
      "mutation($input: CreatePostInput!) { createPost(input: $input) { ref { id } poll { ref { id } multiple options { title } } } }",
    variables: {
      input: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
        content: `ActivityPlug server GraphQL poll E2E ${Date.now()}`,
        visibility: "PUBLIC",
        poll: {
          options: ["TypeScript", "ActivityPub"],
          multiple: false,
          expiresInSeconds: 3600,
        },
      },
    },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL createPost response must include data.");
  const created = data["createPost"];
  expect(pollRefId(created)).toEqual(expect.any(String));
  expectExpectedPostPollPayload(created);
  return refId(created);
}

async function deletePostOverGraphQL(
  fetch: E2EFetch,
  id: string,
  authSessionId: string,
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query:
      "mutation($id: ID!, $sessionId: ID!) { deletePost(id: $id, sessionId: $sessionId) { ref { id } deleted } }",
    variables: { id, sessionId: authSessionId },
  });
  expect(result["data"]).toMatchObject({ deletePost: { deleted: true } });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL deletePost response must include data.");
  expect(refId(data["deletePost"])).toBe(id);
}

async function ownedSeededPostId(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  capabilities: CapabilitySet,
  sessionId: string,
): Promise<string | undefined> {
  if (
    target.accountHandle === undefined ||
    !isSupported(capabilities, "accounts.lookupByHandle") ||
    !isSupported(capabilities, "posts.read")
  ) {
    return undefined;
  }
  const accountId = await accountIdByHandleOverHttp(fetch, target, target.accountHandle);
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/accounts/${encodeURIComponent(accountId)}/posts?limit=5`,
      { headers: { authorization: `Bearer ${sessionId}` } },
    ),
  );
  expect(response.status).toBe(200);
  const posts = await readJsonData(response);
  if (!Array.isArray(posts)) return undefined;
  const firstPost = posts[0];
  return firstPost === undefined ? undefined : refId(firstPost);
}

async function accountIdByHandleOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  handle: string,
): Promise<string> {
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/accounts/lookup?origin=${encodeURIComponent(
        target.origin,
      )}&adapter=${encodeURIComponent(target.adapter)}&handle=${encodeURIComponent(handle)}`,
    ),
  );
  expect(response.status).toBe(200);
  return refId(await readJsonData(response));
}

function refId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value["ref"]) || typeof value["ref"]["id"] !== "string") {
    throw new TypeError("Expected a serialized entity ref with a public id.");
  }
  return value["ref"]["id"];
}

function mediaRefIds(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value["media"])) {
    throw new TypeError("Expected post media.");
  }
  return value["media"].map((attachment) => refId(attachment));
}

function pollRefId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value["poll"])) {
    throw new TypeError("Expected post poll.");
  }
  return refId(value["poll"]);
}

function expectExpectedPostPollPayload(value: unknown): void {
  if (!isRecord(value) || !isRecord(value["poll"])) {
    throw new TypeError("Expected post poll.");
  }
  const poll = value["poll"];
  if (!Array.isArray(poll["options"])) {
    throw new TypeError("Expected poll options.");
  }
  expect(poll["multiple"]).toBe(false);
  expect(
    poll["options"].map((option) => {
      if (!isRecord(option) || typeof option["title"] !== "string") {
        throw new TypeError("Expected poll option title.");
      }
      return option["title"];
    }),
  ).toEqual(["TypeScript", "ActivityPub"]);
}

function accountRefIds(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value["accounts"])) {
    throw new TypeError("Expected search account results.");
  }
  return value["accounts"].map((account) => refId(account));
}

function graphqlAccountRefIds(value: unknown): readonly string[] {
  if (!isRecord(value) || !isRecord(value["data"]) || !isRecord(value["data"]["search"])) {
    throw new TypeError("Expected GraphQL search account results.");
  }
  return accountRefIds(value["data"]["search"]);
}

function hashtagNames(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value["hashtags"])) {
    throw new TypeError("Expected search hashtag results.");
  }
  return value["hashtags"].map((hashtag) => {
    if (!isRecord(hashtag) || typeof hashtag["name"] !== "string") {
      throw new TypeError("Expected hashtag search result names.");
    }
    return normalizedHashtag(hashtag["name"]);
  });
}

function normalizedHashtag(value: string): string {
  return value.replace(/^#/, "").toLowerCase();
}

function postRawIds(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value["posts"])) {
    throw new TypeError("Expected search post results.");
  }
  return value["posts"].map((post) => {
    if (!isRecord(post) || !isRecord(post["ref"]) || typeof post["ref"]["rawId"] !== "string") {
      throw new TypeError("Expected post search result raw IDs.");
    }
    return post["ref"]["rawId"];
  });
}

function publicPostId(target: AdapterE2ETarget, rawId: string): string {
  return createEntityRef({
    adapter: target.adapter,
    origin: target.origin,
    type: "post",
    id: rawId,
  }).id;
}

function adapterKind(adapter: string): string {
  return adapter.toUpperCase();
}

async function waitForPostOverHttp(fetch: E2EFetch, postId: string): Promise<void> {
  await pollUntil(async () => {
    const response = await fetch(
      new Request(`http://activityplug.test/api/v1/posts/${encodeURIComponent(postId)}`),
    );
    if (response.status !== 200) {
      return { ok: false, detail: await response.text() };
    }
    const data = await readJsonData(response);
    return {
      ok: isRecord(data) && isRecord(data["ref"]) && data["ref"]["id"] === postId,
      detail: data,
    };
  });
}

async function pollUntil(
  check: () => Promise<{ readonly ok: boolean; readonly detail?: unknown }>,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastDetail: unknown;
  while (Date.now() <= deadline) {
    const result = await check();
    if (result.ok) return;
    lastDetail = result.detail;
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new TypeError(`Timed out while polling E2E state: ${JSON.stringify(lastDetail)}`);
}
