import {
  type ActivityPlugAdapter,
  type CapabilityName,
  createActivityPlug,
  createEntityRef,
  decodeOpaqueId,
  type CapabilitySet,
} from "@activityplug/core";
import { type AdapterE2ETarget } from "@activityplug/e2e-fixtures";
import { expect } from "vitest";

import { expectCapabilitySurfaces } from "./e2e-capabilities.js";
import { expectMediaSurfaces } from "./e2e-media.js";
import { expectPollSurfaces } from "./e2e-polls.js";
import {
  createScheduledPostOverGraphQL,
  createScheduledPostOverHttp,
  deleteScheduledPostOverGraphQL,
  deleteScheduledPostOverHttp,
  expectScheduledPostReadOverGraphQL,
  expectScheduledPostReadOverHttp,
  updateScheduledPostOverGraphQL,
  updateScheduledPostOverHttp,
} from "./e2e-scheduled.js";
import {
  expectSupportedAccountSocialActions,
  expectSupportedPostSocialActions,
  expectSupportedPostSocialActionsGraphQL,
  hasSupportedAccountSocialAction,
  hasSupportedPostSocialAction,
} from "./e2e-social.js";
import { type E2EFetch, isRecord, postGraphQL, readJsonData } from "./e2e-utils.js";
import { createActivityPlugServer } from "./runtime/server.js";

export async function expectServerBaseline(
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

    if (graphqlSession !== undefined) {
      const graphqlHomeTimeline = await postGraphQL(server.app.fetch, {
        query:
          "query($origin: String!, $sessionId: ID!) { homeTimeline(origin: $origin, sessionId: $sessionId, page: { limit: 5 }) { nodes { ref { origin rawId } } } }",
        variables: { origin: target.origin, sessionId: graphqlSession.id },
      });
      expect(graphqlHomeTimeline["data"]).toMatchObject({
        homeTimeline: { nodes: expect.any(Array) },
      });
    }
  }

  if (session !== undefined && isSupported(capabilities, "followRequests.list")) {
    await expectFollowRequestsOverHttp(server.app.fetch, target, session.id);
    if (graphqlSession !== undefined) {
      await expectFollowRequestsOverGraphQL(server.app.fetch, target, graphqlSession.id);
    }
    if (isSupported(capabilities, "followRequests.accept")) {
      await expectFollowRequestAcceptOverHttp(server.app.fetch, target, session.id);
      if (graphqlSession !== undefined) {
        await expectFollowRequestAcceptOverGraphQL(server.app.fetch, target, graphqlSession.id);
      }
    }
    if (isSupported(capabilities, "followRequests.reject")) {
      await expectFollowRequestRejectOverHttp(server.app.fetch, target, session.id);
      if (graphqlSession !== undefined) {
        await expectFollowRequestRejectOverGraphQL(server.app.fetch, target, graphqlSession.id);
      }
    }
  }

  if (session !== undefined && isSupported(capabilities, "notifications.list")) {
    await expectNotificationsOverHttp(server.app.fetch, target, session.id);
    if (isSupported(capabilities, "notifications.unreadCount")) {
      await expectNotificationUnreadCountOverHttp(server.app.fetch, target, session.id);
    }
    if (graphqlSession !== undefined) {
      await expectNotificationsOverGraphQL(server.app.fetch, target, graphqlSession.id);
      if (isSupported(capabilities, "notifications.unreadCount")) {
        await expectNotificationUnreadCountOverGraphQL(server.app.fetch, target, graphqlSession.id);
      }
    }
    if (isSupported(capabilities, "notifications.dismiss")) {
      await expectNotificationDismissOverHttp(server.app.fetch, target, session.id);
      if (graphqlSession !== undefined) {
        await expectNotificationDismissOverGraphQL(server.app.fetch, target, graphqlSession.id);
      }
    }
    if (isSupported(capabilities, "notifications.clear")) {
      await expectNotificationClearOverHttp(server.app.fetch, target, session.id);
      if (graphqlSession !== undefined) {
        await expectNotificationClearOverGraphQL(server.app.fetch, target, graphqlSession.id);
      }
    }
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
    const httpUpdatePost = publicUpdatePostId(target, httpCreated);
    if (isSupported(capabilities, "posts.update")) {
      await updatePostOverHttp(server.app.fetch, httpUpdatePost, session.id);
    }
    if (isSupported(capabilities, "posts.history")) {
      await expectPostHistoryOverHttp(server.app.fetch, httpUpdatePost, session.id);
    }
    if (isSupported(capabilities, "posts.quote")) {
      const httpQuote = await createQuotePostOverHttp(
        server.app.fetch,
        target,
        session.id,
        httpCreated,
      );
      await deletePostOverHttp(server.app.fetch, httpQuote, session.id);
    }
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
      const graphqlUpdatePost = publicUpdatePostId(target, graphqlCreated);
      if (isSupported(capabilities, "posts.update")) {
        await updatePostOverGraphQL(server.app.fetch, graphqlUpdatePost, graphqlSession.id);
      }
      if (isSupported(capabilities, "posts.history")) {
        await expectPostHistoryOverGraphQL(server.app.fetch, graphqlUpdatePost, graphqlSession.id);
      }
      if (isSupported(capabilities, "posts.quote")) {
        const graphqlQuote = await createQuotePostOverGraphQL(
          server.app.fetch,
          target,
          graphqlSession.id,
          graphqlCreated,
        );
        await deletePostOverGraphQL(server.app.fetch, graphqlQuote, graphqlSession.id);
      }
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
    isSupported(capabilities, "filters.read") &&
    isSupported(capabilities, "filters.create") &&
    isSupported(capabilities, "filters.delete")
  ) {
    await expectFilterLifecycleOverHttp(
      server.app.fetch,
      target,
      session.id,
      isSupported(capabilities, "filters.update"),
    );
    if (graphqlSession !== undefined) {
      await expectFilterLifecycleOverGraphQL(
        server.app.fetch,
        target,
        graphqlSession.id,
        isSupported(capabilities, "filters.update"),
      );
    }
  }

  if (
    session !== undefined &&
    isSupported(capabilities, "scheduledPosts.create") &&
    isSupported(capabilities, "scheduledPosts.delete")
  ) {
    const httpScheduled = await createScheduledPostOverHttp(server.app.fetch, target, session.id);
    if (isSupported(capabilities, "scheduledPosts.read")) {
      await expectScheduledPostReadOverHttp(server.app.fetch, target, session.id, httpScheduled);
    }
    if (isSupported(capabilities, "scheduledPosts.update")) {
      await updateScheduledPostOverHttp(server.app.fetch, session.id, httpScheduled);
    }
    await deleteScheduledPostOverHttp(server.app.fetch, session.id, httpScheduled);

    if (graphqlSession !== undefined) {
      const graphqlScheduled = await createScheduledPostOverGraphQL(
        server.app.fetch,
        target,
        graphqlSession.id,
      );
      if (isSupported(capabilities, "scheduledPosts.read")) {
        await expectScheduledPostReadOverGraphQL(
          server.app.fetch,
          target,
          graphqlSession.id,
          graphqlScheduled,
        );
      }
      if (isSupported(capabilities, "scheduledPosts.update")) {
        await updateScheduledPostOverGraphQL(server.app.fetch, graphqlSession.id, graphqlScheduled);
      }
      await deleteScheduledPostOverGraphQL(server.app.fetch, graphqlSession.id, graphqlScheduled);
    }
  }

  if (session !== undefined) {
    await expectUnsupportedAuxiliaryOperations(server.app.fetch, target, capabilities, session.id);
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
        )}&q=${encodeURIComponent(target.accountHandle)}&type=accounts&limit=20${
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
          ...(graphqlSession === undefined ? {} : { sessionId: graphqlSession.id }),
          page: { limit: 20 },
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
          ...(graphqlSession === undefined ? {} : { sessionId: graphqlSession.id }),
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
        )}&q=${encodeURIComponent(target.accountHandle)}&limit=20${
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
          ...(graphqlSession === undefined ? {} : { sessionId: graphqlSession.id }),
          page: { limit: 20 },
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
          ...(graphqlSession === undefined ? {} : { sessionId: graphqlSession.id }),
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
          ...(graphqlSession === undefined ? {} : { sessionId: graphqlSession.id }),
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
      if (isSupported(capabilities, "lists.create") && isSupported(capabilities, "lists.delete")) {
        await expectListLifecycleOverHttp(server.app.fetch, target, session.id, accountId);
        await expectListLifecycleOverGraphQL(
          server.app.fetch,
          target,
          graphqlSession.id,
          accountId,
        );
      }
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
        ...(graphqlSession === undefined ? {} : { sessionId: graphqlSession.id }),
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
    "notifications.list",
    "notifications.clear",
    "filters.read",
    "filters.create",
    "filters.update",
    "filters.delete",
    "scheduledPosts.read",
    "scheduledPosts.create",
    "scheduledPosts.update",
    "scheduledPosts.delete",
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

async function expectUnsupportedAuxiliaryOperations(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  capabilities: CapabilitySet,
  authSessionId: string,
): Promise<void> {
  if (!isSupported(capabilities, "notifications.unreadCount")) {
    await expectUnsupportedHttp(
      await fetch(
        new Request(
          `http://activityplug.test/api/v1/notifications/unread-count?origin=${encodeURIComponent(
            target.origin,
          )}&adapter=${encodeURIComponent(target.adapter)}`,
          { headers: { authorization: `Bearer ${authSessionId}` } },
        ),
      ),
      "notifications.unreadCount",
    );
    await expectUnsupportedGraphQL(fetch, {
      query:
        "query($origin: String!, $adapter: AdapterKind, $sessionId: ID!) { notificationUnreadCount(origin: $origin, adapter: $adapter, sessionId: $sessionId) }",
      variables: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
      },
      capability: "notifications.unreadCount",
    });
  }
  if (!isSupported(capabilities, "notifications.clear")) {
    await expectUnsupportedHttp(
      await fetch(
        new Request(
          `http://activityplug.test/api/v1/notifications/clear?origin=${encodeURIComponent(
            target.origin,
          )}&adapter=${encodeURIComponent(target.adapter)}`,
          { method: "POST", headers: { authorization: `Bearer ${authSessionId}` } },
        ),
      ),
      "notifications.clear",
    );
    await expectUnsupportedGraphQL(fetch, {
      query:
        "mutation($origin: String!, $adapter: AdapterKind, $sessionId: ID!) { clearNotifications(origin: $origin, adapter: $adapter, sessionId: $sessionId) }",
      variables: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
      },
      capability: "notifications.clear",
    });
  }
  if (!isSupported(capabilities, "posts.update") && target.postSearchRawId !== undefined) {
    const postId = publicPostId(target, target.postSearchRawId);
    await expectUnsupportedHttp(
      await fetch(
        new Request(`http://activityplug.test/api/v1/posts/${encodeURIComponent(postId)}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${authSessionId}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ content: "ActivityPlug unsupported update check" }),
        }),
      ),
      "posts.update",
    );
    await expectUnsupportedGraphQL(fetch, {
      query: "mutation($input: UpdatePostInput!) { updatePost(input: $input) { ref { id } } }",
      variables: {
        input: {
          id: postId,
          sessionId: authSessionId,
          content: "ActivityPlug unsupported update check",
        },
      },
      capability: "posts.update",
    });
  }
  if (!isSupported(capabilities, "filters.read")) {
    await expectUnsupportedHttp(
      await fetch(
        new Request(
          `http://activityplug.test/api/v1/filters?origin=${encodeURIComponent(
            target.origin,
          )}&adapter=${encodeURIComponent(target.adapter)}`,
          { headers: { authorization: `Bearer ${authSessionId}` } },
        ),
      ),
      "filters.read",
    );
    await expectUnsupportedGraphQL(fetch, {
      query:
        "query($origin: String!, $adapter: AdapterKind, $sessionId: ID!) { filters(origin: $origin, adapter: $adapter, sessionId: $sessionId) { nodes { ref { id } } } }",
      variables: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
      },
      capability: "filters.read",
    });
  }
  if (!isSupported(capabilities, "scheduledPosts.create")) {
    const scheduledAt = futureIsoDate(30);
    await expectUnsupportedHttp(
      await fetch(
        new Request("http://activityplug.test/api/v1/scheduled-posts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${authSessionId}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: target.origin,
            adapter: target.adapter,
            content: "ActivityPlug unsupported schedule check",
            scheduledAt,
          }),
        }),
      ),
      "scheduledPosts.create",
    );
    await expectUnsupportedGraphQL(fetch, {
      query: "mutation($input: SchedulePostInput!) { schedulePost(input: $input) { ref { id } } }",
      variables: {
        input: {
          origin: target.origin,
          adapter: adapterKind(target.adapter),
          sessionId: authSessionId,
          content: "ActivityPlug unsupported schedule check",
          scheduledAt,
        },
      },
      capability: "scheduledPosts.create",
    });
  }
}

async function expectUnsupportedHttp(
  response: Response,
  capability: CapabilityName,
): Promise<void> {
  expect(response.status).toBe(400);
  const json = (await response.json()) as unknown;
  expect(json).toMatchObject({ error: { code: "UNSUPPORTED_OPERATION", capability } });
}

async function expectUnsupportedGraphQL(
  fetch: E2EFetch,
  input: {
    readonly query: string;
    readonly variables: Record<string, unknown>;
    readonly capability: CapabilityName;
  },
): Promise<void> {
  const response = await fetch(
    new Request("http://activityplug.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
    }),
  );
  expect(response.status).toBe(200);
  const json = (await response.json()) as unknown;
  expect(json).toMatchObject({
    errors: [{ extensions: { activityplug: { code: "UNSUPPORTED_OPERATION" } } }],
  });
  const errors = isRecord(json) ? json["errors"] : undefined;
  if (!Array.isArray(errors) || !isRecord(errors[0]) || !isRecord(errors[0]["extensions"])) {
    throw new TypeError("GraphQL unsupported response must include errors.");
  }
  const extensions = errors[0]["extensions"];
  if (!isRecord(extensions["activityplug"])) {
    throw new TypeError("GraphQL unsupported response must include ActivityPlug metadata.");
  }
  expect(extensions["activityplug"]).toMatchObject({ capability: input.capability });
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

async function updatePostOverHttp(
  fetch: E2EFetch,
  id: string,
  authSessionId: string,
): Promise<void> {
  const content = `ActivityPlug server HTTP update E2E ${Date.now()}`;
  const response = await fetch(
    new Request(`http://activityplug.test/api/v1/posts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${authSessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content }),
    }),
  );
  await expectStatus(response, 200);
  const post = await readJsonData(response);
  expect(refId(post)).toBe(id);
  expect(readContent(post)).toContain("update");
}

async function expectPostHistoryOverHttp(
  fetch: E2EFetch,
  id: string,
  authSessionId: string,
): Promise<void> {
  const response = await fetch(
    new Request(`http://activityplug.test/api/v1/posts/${encodeURIComponent(id)}/history`, {
      headers: { authorization: `Bearer ${authSessionId}` },
    }),
  );
  await expectStatus(response, 200);
  const data = await readJsonData(response);
  if (!isRecord(data) || !Array.isArray(data["revisions"])) {
    throw new TypeError("HTTP post history must include revisions.");
  }
  expect(data["revisions"].length).toBeGreaterThan(0);
}

async function createQuotePostOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  quoteOfId: string,
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
        content: `ActivityPlug server HTTP quote E2E ${Date.now()}`,
        visibility: "public",
        quoteOfId,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const post = await readJsonData(response);
  expect(entityRawId(post, "quoteOf")).toBe(entityRawIdFromId(quoteOfId));
  return refId(post);
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

async function updatePostOverGraphQL(
  fetch: E2EFetch,
  id: string,
  authSessionId: string,
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query:
      "mutation($input: UpdatePostInput!) { updatePost(input: $input) { ref { id } contentText contentHtml } }",
    variables: {
      input: {
        id,
        sessionId: authSessionId,
        content: `ActivityPlug server GraphQL update E2E ${Date.now()}`,
      },
    },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL updatePost response must include data.");
  const post = data["updatePost"];
  expect(refId(post)).toBe(id);
  expect(readContent(post)).toContain("update");
}

async function expectPostHistoryOverGraphQL(
  fetch: E2EFetch,
  id: string,
  authSessionId: string,
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query:
      "query($id: ID!, $sessionId: ID!) { postHistory(id: $id, sessionId: $sessionId) { ref { id } } }",
    variables: { id, sessionId: authSessionId },
  });
  const data = result["data"];
  if (!isRecord(data) || !Array.isArray(data["postHistory"])) {
    throw new TypeError("GraphQL postHistory response must include revisions.");
  }
  expect(data["postHistory"].length).toBeGreaterThan(0);
}

async function createQuotePostOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  quoteOfId: string,
): Promise<string> {
  const result = await postGraphQL(fetch, {
    query:
      "mutation($input: CreatePostInput!) { createPost(input: $input) { ref { id } quoteOf { rawId } } }",
    variables: {
      input: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
        content: `ActivityPlug server GraphQL quote E2E ${Date.now()}`,
        visibility: "PUBLIC",
        quoteOfId,
      },
    },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL createPost response must include data.");
  const created = data["createPost"];
  expect(entityRawId(created, "quoteOf")).toBe(entityRawIdFromId(quoteOfId));
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

async function expectNotificationsOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  if (target.notificationRawId === undefined || target.notificationType === undefined) {
    throw new TypeError("Fediverse server E2E target must provide a notification fixture.");
  }
  if (target.notificationAccountRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide a notification account fixture.");
  }
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/notifications?origin=${encodeURIComponent(
        target.origin,
      )}&adapter=${encodeURIComponent(target.adapter)}&limit=20`,
      {
        headers: { authorization: `Bearer ${authSessionId}` },
      },
    ),
  );
  expect(response.status).toBe(200);
  const notifications = await readJsonData(response);
  expect(notifications).toEqual(expect.any(Array));
  if (!Array.isArray(notifications)) throw new TypeError("HTTP notifications must be an array.");
  const notification = notifications.find(
    (item) =>
      isRecord(item) && isRecord(item["ref"]) && item["ref"]["rawId"] === target.notificationRawId,
  );
  expect(notification, notificationFixtureMessage(target, notifications)).toMatchObject({
    type: target.notificationType,
    account: { rawId: target.notificationAccountRawId },
  });
  if (target.notificationPostRawId !== undefined) {
    expect(notification).toMatchObject({ post: { rawId: target.notificationPostRawId } });
  }
}

async function expectFollowRequestsOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/follow-requests?origin=${encodeURIComponent(
        target.origin,
      )}&adapter=${encodeURIComponent(target.adapter)}&limit=5`,
      { headers: { authorization: `Bearer ${authSessionId}` } },
    ),
  );
  await expectStatus(response, 200);
  expect(await readJsonData(response)).toEqual(expect.any(Array));
}

async function expectFollowRequestsOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query:
      "query($origin: String!, $adapter: AdapterKind, $sessionId: ID!) { followRequests(origin: $origin, adapter: $adapter, sessionId: $sessionId, page: { limit: 5 }) { nodes { ref { id } } pageInfo { hasNextPage hasPreviousPage } } }",
    variables: {
      origin: target.origin,
      adapter: adapterKind(target.adapter),
      sessionId: authSessionId,
    },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL followRequests response must include data.");
  expect(data["followRequests"]).toMatchObject({
    nodes: expect.any(Array),
    pageInfo: { hasNextPage: expect.any(Boolean), hasPreviousPage: expect.any(Boolean) },
  });
}

async function expectFollowRequestAcceptOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  if (target.followRequestHttpAcceptRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide an HTTP accept request.");
  }
  const accountId = publicAccountId(target, target.followRequestHttpAcceptRawId);
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/follow-requests/${encodeURIComponent(accountId)}/accept`,
      { method: "POST", headers: { authorization: `Bearer ${authSessionId}` } },
    ),
  );
  await expectStatus(response, 200);
  expect(await readJsonData(response)).toMatchObject({ followedBy: true });
}

async function expectFollowRequestAcceptOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  if (target.followRequestGraphqlAcceptRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide a GraphQL accept request.");
  }
  const result = await postGraphQL(fetch, {
    query:
      "mutation($id: ID!, $sessionId: ID!) { acceptFollowRequest(id: $id, sessionId: $sessionId) { followedBy } }",
    variables: {
      id: publicAccountId(target, target.followRequestGraphqlAcceptRawId),
      sessionId: authSessionId,
    },
  });
  expect(result["data"]).toMatchObject({ acceptFollowRequest: { followedBy: true } });
}

async function expectFollowRequestRejectOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  if (target.followRequestHttpRejectRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide an HTTP reject request.");
  }
  const accountId = publicAccountId(target, target.followRequestHttpRejectRawId);
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/follow-requests/${encodeURIComponent(accountId)}/reject`,
      { method: "POST", headers: { authorization: `Bearer ${authSessionId}` } },
    ),
  );
  await expectStatus(response, 200);
  expect(await readJsonData(response)).toMatchObject({ followedBy: false });
}

async function expectFollowRequestRejectOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  if (target.followRequestGraphqlRejectRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide a GraphQL reject request.");
  }
  const result = await postGraphQL(fetch, {
    query:
      "mutation($id: ID!, $sessionId: ID!) { rejectFollowRequest(id: $id, sessionId: $sessionId) { followedBy } }",
    variables: {
      id: publicAccountId(target, target.followRequestGraphqlRejectRawId),
      sessionId: authSessionId,
    },
  });
  expect(result["data"]).toMatchObject({ rejectFollowRequest: { followedBy: false } });
}

async function expectNotificationsOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  if (target.notificationRawId === undefined || target.notificationType === undefined) {
    throw new TypeError("Fediverse server E2E target must provide a notification fixture.");
  }
  if (target.notificationAccountRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide a notification account fixture.");
  }
  const result = await postGraphQL(fetch, {
    query:
      "query($origin: String!, $adapter: AdapterKind, $sessionId: ID!) { notifications(origin: $origin, adapter: $adapter, sessionId: $sessionId, page: { limit: 20 }) { nodes { ref { rawId } type post { rawId } account { rawId } } pageInfo { hasNextPage hasPreviousPage } } }",
    variables: {
      origin: target.origin,
      adapter: adapterKind(target.adapter),
      sessionId: authSessionId,
    },
  });
  const data = result["data"];
  if (!isRecord(data) || !isRecord(data["notifications"])) {
    throw new TypeError("GraphQL notifications response must include data.");
  }
  const nodes = data["notifications"]["nodes"];
  if (!Array.isArray(nodes)) throw new TypeError("GraphQL notifications must include nodes.");
  const notification = nodes.find(
    (item) =>
      isRecord(item) && isRecord(item["ref"]) && item["ref"]["rawId"] === target.notificationRawId,
  );
  expect(notification, notificationFixtureMessage(target, nodes)).toMatchObject({
    type: target.notificationType,
    account: { rawId: target.notificationAccountRawId },
  });
  if (target.notificationPostRawId !== undefined) {
    expect(notification).toMatchObject({ post: { rawId: target.notificationPostRawId } });
  }
  expect(data["notifications"]).toMatchObject({
    pageInfo: { hasNextPage: expect.any(Boolean), hasPreviousPage: expect.any(Boolean) },
  });
}

async function expectNotificationUnreadCountOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/notifications/unread-count?origin=${encodeURIComponent(
        target.origin,
      )}&adapter=${encodeURIComponent(target.adapter)}`,
      { headers: { authorization: `Bearer ${authSessionId}` } },
    ),
  );
  await expectStatus(response, 200);
  const data = await readJsonData(response);
  expect(data).toMatchObject({ count: expect.any(Number) });
  if (!isRecord(data) || typeof data["count"] !== "number") {
    throw new TypeError("HTTP unread count response must include a number.");
  }
  expect(data["count"]).toBeGreaterThan(0);
}

async function expectNotificationUnreadCountOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query:
      "query($origin: String!, $adapter: AdapterKind, $sessionId: ID!) { notificationUnreadCount(origin: $origin, adapter: $adapter, sessionId: $sessionId) }",
    variables: {
      origin: target.origin,
      adapter: adapterKind(target.adapter),
      sessionId: authSessionId,
    },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL unread count response must include data.");
  expect(data["notificationUnreadCount"]).toEqual(expect.any(Number));
  expect(data["notificationUnreadCount"]).toBeGreaterThan(0);
}

async function expectNotificationDismissOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  if (target.notificationRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide a notification fixture.");
  }
  const notificationId = publicNotificationId(target, target.notificationRawId);
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/notifications/${encodeURIComponent(notificationId)}/dismiss`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${authSessionId}` },
      },
    ),
  );
  await expectStatus(response, 200);
  const deleted = await readJsonData(response);
  expect(deleted).toMatchObject({ deleted: true });
  expect(refId(deleted)).toBe(notificationId);
}

async function expectNotificationDismissOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  if (target.notificationGraphqlDismissRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide a GraphQL dismiss fixture.");
  }
  const notificationId = publicNotificationId(target, target.notificationGraphqlDismissRawId);
  const result = await postGraphQL(fetch, {
    query:
      "mutation($id: ID!, $sessionId: ID!) { dismissNotification(id: $id, sessionId: $sessionId) { deleted ref { id } } }",
    variables: { id: notificationId, sessionId: authSessionId },
  });
  expect(result["data"]).toMatchObject({
    dismissNotification: { deleted: true, ref: { id: notificationId } },
  });
}

async function expectNotificationClearOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  const clearRawId = target.notificationClearRawId ?? target.notificationRawId;
  if (clearRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide a clear notification fixture.");
  }
  if (target.adapter === "misskey") {
    await expectMisskeyUnreadFlag(target, true);
  }
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/notifications/clear?origin=${encodeURIComponent(
        target.origin,
      )}&adapter=${encodeURIComponent(target.adapter)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${authSessionId}` },
      },
    ),
  );
  await expectStatus(response, 200);
  expect(await readJsonData(response)).toMatchObject({ ok: true });
  if (target.adapter === "misskey") {
    await expectMisskeyUnreadFlag(target, false);
  } else {
    await expectNotificationRawIdAbsentOverHttp(fetch, target, authSessionId, clearRawId);
  }
}

async function expectNotificationClearOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  const clearRawId =
    target.notificationGraphqlClearRawId ??
    target.notificationClearRawId ??
    target.notificationRawId;
  if (clearRawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide a clear notification fixture.");
  }
  if (target.adapter === "misskey") {
    await expectMisskeyUnreadFlag(target, true);
  }
  const result = await postGraphQL(fetch, {
    query:
      "mutation($origin: String!, $adapter: AdapterKind, $sessionId: ID!) { clearNotifications(origin: $origin, adapter: $adapter, sessionId: $sessionId) }",
    variables: {
      origin: target.origin,
      adapter: adapterKind(target.adapter),
      sessionId: authSessionId,
    },
  });
  const data = result["data"];
  if (!isRecord(data))
    throw new TypeError("GraphQL clearNotifications response must include data.");
  expect(data["clearNotifications"]).toBe(true);
  if (target.adapter === "misskey") {
    await expectMisskeyUnreadFlag(target, false);
  } else {
    await expectNotificationRawIdAbsentOverHttp(fetch, target, authSessionId, clearRawId);
  }
}

async function expectNotificationRawIdAbsentOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  rawId: string,
): Promise<void> {
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/notifications?origin=${encodeURIComponent(
        target.origin,
      )}&adapter=${encodeURIComponent(target.adapter)}&limit=20`,
      {
        headers: { authorization: `Bearer ${authSessionId}` },
      },
    ),
  );
  await expectStatus(response, 200);
  const notifications = await readJsonData(response);
  if (!Array.isArray(notifications)) throw new TypeError("HTTP notifications must be an array.");
  expect(
    notifications.some(
      (item) => isRecord(item) && isRecord(item["ref"]) && item["ref"]["rawId"] === rawId,
    ),
  ).toBe(false);
}

async function expectMisskeyUnreadFlag(
  target: AdapterE2ETarget,
  hasUnreadNotification: boolean,
): Promise<void> {
  if (target.token === undefined) {
    throw new TypeError("Misskey E2E target must provide a token.");
  }
  const response = await fetch(`${target.origin}/api/i`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ i: target.token }),
  });
  await expectStatus(response, 200);
  const account = await response.json();
  if (!isRecord(account)) throw new TypeError("Misskey i response must be an object.");
  expect(account["hasUnreadNotification"]).toBe(hasUnreadNotification);
}

function notificationFixtureMessage(
  target: AdapterE2ETarget,
  notifications: readonly unknown[],
): string {
  const rawIds = notifications
    .map((item) => {
      if (!isRecord(item) || !isRecord(item["ref"])) return undefined;
      const rawId = item["ref"]["rawId"];
      return typeof rawId === "string" ? rawId : undefined;
    })
    .filter((rawId): rawId is string => rawId !== undefined);
  return `Expected ${target.adapter} notification ${target.notificationRawId}; got ${rawIds.join(
    ", ",
  )}`;
}

async function expectListLifecycleOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  accountId: string,
): Promise<void> {
  const title = `ActivityPlug server HTTP list E2E ${Date.now()}`;
  const createResponse = await fetch(
    new Request("http://activityplug.test/api/v1/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${authSessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ origin: target.origin, adapter: target.adapter, title }),
    }),
  );
  expect(createResponse.status).toBe(200);
  const created = await readJsonData(createResponse);
  expect(created).toMatchObject({ title });
  const listId = refId(created);
  const listResponse = await fetch(
    new Request(
      `http://activityplug.test/api/v1/lists?origin=${encodeURIComponent(
        target.origin,
      )}&adapter=${encodeURIComponent(target.adapter)}&limit=20`,
      { headers: { authorization: `Bearer ${authSessionId}` } },
    ),
  );
  expect(listResponse.status).toBe(200);
  const lists = await readJsonData(listResponse);
  if (!Array.isArray(lists)) throw new TypeError("HTTP lists must be an array.");
  expect(lists.some((list) => refId(list) === listId)).toBe(true);
  const getResponse = await fetch(
    new Request(`http://activityplug.test/api/v1/lists/${encodeURIComponent(listId)}`, {
      headers: { authorization: `Bearer ${authSessionId}` },
    }),
  );
  await expectStatus(getResponse, 200);
  expect(await readJsonData(getResponse)).toMatchObject({ title });
  const updatedTitle = `${title} updated`;
  const updateResponse = await fetch(
    new Request(`http://activityplug.test/api/v1/lists/${encodeURIComponent(listId)}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${authSessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: updatedTitle }),
    }),
  );
  expect(updateResponse.status).toBe(200);
  expect(await readJsonData(updateResponse)).toMatchObject({ title: updatedTitle });
  await expectListMembershipOverHttp(fetch, listId, authSessionId, accountId);
  const timelineResponse = await fetch(
    new Request(
      `http://activityplug.test/api/v1/timelines/lists/${encodeURIComponent(listId)}?limit=5`,
      { headers: { authorization: `Bearer ${authSessionId}` } },
    ),
  );
  await expectStatus(timelineResponse, 200);
  expect(await readJsonData(timelineResponse)).toEqual(expect.any(Array));
  const deleteResponse = await fetch(
    new Request(`http://activityplug.test/api/v1/lists/${encodeURIComponent(listId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${authSessionId}` },
    }),
  );
  expect(deleteResponse.status).toBe(200);
  expect(await readJsonData(deleteResponse)).toMatchObject({ deleted: true });
}

async function expectListMembershipOverHttp(
  fetch: E2EFetch,
  listId: string,
  authSessionId: string,
  accountId: string,
): Promise<void> {
  const addResponse = await fetch(
    new Request(`http://activityplug.test/api/v1/lists/${encodeURIComponent(listId)}/accounts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authSessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ accountId }),
    }),
  );
  await expectStatus(addResponse, 200);
  const accountsResponse = await fetch(
    new Request(`http://activityplug.test/api/v1/lists/${encodeURIComponent(listId)}/accounts`, {
      headers: { authorization: `Bearer ${authSessionId}` },
    }),
  );
  await expectStatus(accountsResponse, 200);
  const accounts = await readJsonData(accountsResponse);
  if (!Array.isArray(accounts)) throw new TypeError("HTTP list accounts must be an array.");
  expect(accounts.some((account) => refId(account) === accountId)).toBe(true);
  const removeResponse = await fetch(
    new Request(`http://activityplug.test/api/v1/lists/${encodeURIComponent(listId)}/accounts`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${authSessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ accountId }),
    }),
  );
  await expectStatus(removeResponse, 200);
}

async function expectListLifecycleOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  accountId: string,
): Promise<void> {
  const title = `ActivityPlug server GraphQL list E2E ${Date.now()}`;
  const createResult = await postGraphQL(fetch, {
    query: "mutation($input: CreateListInput!) { createList(input: $input) { ref { id } title } }",
    variables: {
      input: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
        title,
      },
    },
  });
  const createData = createResult["data"];
  if (!isRecord(createData)) throw new TypeError("GraphQL createList response must include data.");
  expect(createData["createList"]).toMatchObject({ title });
  const listId = refId(createData["createList"]);
  const listResult = await postGraphQL(fetch, {
    query:
      "query($origin: String!, $adapter: AdapterKind, $sessionId: ID!) { lists(origin: $origin, adapter: $adapter, sessionId: $sessionId, page: { limit: 20 }) { nodes { ref { id } } } }",
    variables: {
      origin: target.origin,
      adapter: adapterKind(target.adapter),
      sessionId: authSessionId,
    },
  });
  const listData = listResult["data"];
  if (!isRecord(listData) || !isRecord(listData["lists"])) {
    throw new TypeError("GraphQL lists response must include data.");
  }
  const lists = listData["lists"]["nodes"];
  if (!Array.isArray(lists)) throw new TypeError("GraphQL lists must include nodes.");
  expect(lists.some((list) => refId(list) === listId)).toBe(true);
  const getResult = await postGraphQL(fetch, {
    query:
      "query($id: ID!, $sessionId: ID!) { list(id: $id, sessionId: $sessionId) { ref { id } title } }",
    variables: { id: listId, sessionId: authSessionId },
  });
  expect(getResult["data"]).toMatchObject({ list: { ref: { id: listId }, title } });
  const updatedTitle = `${title} updated`;
  const updateResult = await postGraphQL(fetch, {
    query: "mutation($input: UpdateListInput!) { updateList(input: $input) { ref { id } title } }",
    variables: { input: { id: listId, sessionId: authSessionId, title: updatedTitle } },
  });
  expect(updateResult["data"]).toMatchObject({
    updateList: { ref: { id: listId }, title: updatedTitle },
  });
  await postGraphQL(fetch, {
    query: "mutation($input: ListAccountInput!) { addListAccount(input: $input) { ref { id } } }",
    variables: { input: { id: listId, sessionId: authSessionId, accountId } },
  });
  const timelineResult = await postGraphQL(fetch, {
    query:
      "query($listId: ID!, $sessionId: ID!) { listTimeline(listId: $listId, sessionId: $sessionId, page: { limit: 5 }) { nodes { ref { id } } } }",
    variables: { listId, sessionId: authSessionId },
  });
  expect(timelineResult["data"]).toMatchObject({
    listTimeline: { nodes: expect.any(Array) },
  });
  const accountsResult = await postGraphQL(fetch, {
    query:
      "query($id: ID!, $sessionId: ID!) { listAccounts(id: $id, sessionId: $sessionId, page: { limit: 20 }) { nodes { ref { id } } } }",
    variables: { id: listId, sessionId: authSessionId },
  });
  const accountsData = accountsResult["data"];
  if (!isRecord(accountsData) || !isRecord(accountsData["listAccounts"])) {
    throw new TypeError("GraphQL listAccounts response must include data.");
  }
  const accounts = accountsData["listAccounts"]["nodes"];
  if (!Array.isArray(accounts)) throw new TypeError("GraphQL listAccounts must include nodes.");
  expect(accounts.some((account) => refId(account) === accountId)).toBe(true);
  await postGraphQL(fetch, {
    query:
      "mutation($input: ListAccountInput!) { removeListAccount(input: $input) { ref { id } } }",
    variables: { input: { id: listId, sessionId: authSessionId, accountId } },
  });
  const deleteResult = await postGraphQL(fetch, {
    query:
      "mutation($id: ID!, $sessionId: ID!) { deleteList(id: $id, sessionId: $sessionId) { ref { id } deleted } }",
    variables: { id: listId, sessionId: authSessionId },
  });
  const deleteData = deleteResult["data"];
  if (!isRecord(deleteData)) throw new TypeError("GraphQL deleteList response must include data.");
  expect(deleteData["deleteList"]).toMatchObject({ deleted: true });
}

async function expectFilterLifecycleOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  updateSupported: boolean,
): Promise<void> {
  const keyword = `activityplug-server-http-${Date.now()}`;
  const createdResponse = await fetch(
    new Request("http://activityplug.test/api/v1/filters", {
      method: "POST",
      headers: {
        authorization: `Bearer ${authSessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: target.origin,
        adapter: target.adapter,
        title: keyword,
        context: ["home"],
        action: "warn",
        keywords: [{ keyword }],
      }),
    }),
  );
  expect(createdResponse.status).toBe(200);
  const created = await readJsonData(createdResponse);
  const createdId = refId(created);
  expect(created).toMatchObject({ title: keyword });

  const listResponse = await fetch(
    new Request(
      `http://activityplug.test/api/v1/filters?origin=${encodeURIComponent(
        target.origin,
      )}&adapter=${encodeURIComponent(target.adapter)}&limit=5`,
      { headers: { authorization: `Bearer ${authSessionId}` } },
    ),
  );
  expect(listResponse.status).toBe(200);
  const listed = await readJsonData(listResponse);
  expect(listed).toEqual(expect.any(Array));
  if (!Array.isArray(listed)) throw new TypeError("HTTP filter list must be an array.");
  expect(listed.some((filter) => isRecord(filter) && refId(filter) === createdId)).toBe(true);

  const getResponse = await fetch(
    new Request(`http://activityplug.test/api/v1/filters/${encodeURIComponent(createdId)}`, {
      headers: { authorization: `Bearer ${authSessionId}` },
    }),
  );
  expect(getResponse.status).toBe(200);
  expect(await readJsonData(getResponse)).toMatchObject({ title: keyword });

  if (updateSupported) {
    const updatedKeyword = `${keyword}-updated`;
    const updateResponse = await fetch(
      new Request(`http://activityplug.test/api/v1/filters/${encodeURIComponent(createdId)}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${authSessionId}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: updatedKeyword,
          context: ["home"],
          action: "hide",
          keywords: [{ keyword: updatedKeyword }],
        }),
      }),
    );
    expect(updateResponse.status).toBe(200);
    expect(refId(await readJsonData(updateResponse))).toBe(createdId);
  }

  const deleteResponse = await fetch(
    new Request(`http://activityplug.test/api/v1/filters/${encodeURIComponent(createdId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${authSessionId}` },
    }),
  );
  expect(deleteResponse.status).toBe(200);
  expect(await readJsonData(deleteResponse)).toMatchObject({ deleted: true });
}

async function expectFilterLifecycleOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  updateSupported: boolean,
): Promise<void> {
  const keyword = `activityplug-server-graphql-${Date.now()}`;
  const createdResult = await postGraphQL(fetch, {
    query:
      "mutation($input: CreateFilterInput!) { createFilter(input: $input) { ref { id } title } }",
    variables: {
      input: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
        title: keyword,
        context: ["HOME"],
        action: "WARN",
        keywords: [{ keyword }],
      },
    },
  });
  const createdData = createdResult["data"];
  if (!isRecord(createdData))
    throw new TypeError("GraphQL createFilter response must include data.");
  const createdId = refId(createdData["createFilter"]);
  expect(createdData["createFilter"]).toMatchObject({ title: keyword });

  const listResult = await postGraphQL(fetch, {
    query:
      "query($origin: String!, $adapter: AdapterKind, $sessionId: ID!) { filters(origin: $origin, adapter: $adapter, sessionId: $sessionId, page: { limit: 5 }) { nodes { ref { id } title } pageInfo { hasNextPage hasPreviousPage } } }",
    variables: {
      origin: target.origin,
      adapter: adapterKind(target.adapter),
      sessionId: authSessionId,
    },
  });
  expect(listResult["data"]).toMatchObject({
    filters: {
      nodes: expect.any(Array),
      pageInfo: { hasNextPage: expect.any(Boolean), hasPreviousPage: expect.any(Boolean) },
    },
  });
  const listData = listResult["data"];
  if (!isRecord(listData) || !isRecord(listData["filters"])) {
    throw new TypeError("GraphQL filter list response must include data.");
  }
  const listNodes = listData["filters"]["nodes"];
  if (!Array.isArray(listNodes)) throw new TypeError("GraphQL filter list must include nodes.");
  expect(listNodes.some((filter) => isRecord(filter) && refId(filter) === createdId)).toBe(true);

  const getResult = await postGraphQL(fetch, {
    query:
      "query($id: ID!, $sessionId: ID!) { filter(id: $id, sessionId: $sessionId) { ref { id } title } }",
    variables: { id: createdId, sessionId: authSessionId },
  });
  expect(getResult["data"]).toMatchObject({ filter: { title: keyword } });

  if (updateSupported) {
    const updatedKeyword = `${keyword}-updated`;
    const updateResult = await postGraphQL(fetch, {
      query:
        "mutation($input: UpdateFilterInput!) { updateFilter(input: $input) { ref { id } title } }",
      variables: {
        input: {
          id: createdId,
          sessionId: authSessionId,
          title: updatedKeyword,
          context: ["HOME"],
          action: "HIDE",
          keywords: [{ keyword: updatedKeyword }],
        },
      },
    });
    const updatedData = updateResult["data"];
    if (!isRecord(updatedData))
      throw new TypeError("GraphQL updateFilter response must include data.");
    expect(refId(updatedData["updateFilter"])).toBe(createdId);
  }

  const deleteResult = await postGraphQL(fetch, {
    query:
      "mutation($id: ID!, $sessionId: ID!) { deleteFilter(id: $id, sessionId: $sessionId) { ref { id } deleted } }",
    variables: { id: createdId, sessionId: authSessionId },
  });
  expect(deleteResult["data"]).toMatchObject({ deleteFilter: { deleted: true } });
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

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`Expected HTTP ${status}, got ${response.status}: ${await response.text()}`);
  }
}

function entityRawId(value: unknown, field: string): string {
  if (!isRecord(value) || !isRecord(value[field]) || typeof value[field]["rawId"] !== "string") {
    throw new TypeError(`Expected ${field} to expose a raw id.`);
  }
  return value[field]["rawId"];
}

function entityRawIdFromId(id: string): string {
  return decodeOpaqueId(id).id;
}

function mediaRefIds(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value["media"])) {
    throw new TypeError("Expected post media.");
  }
  return value["media"].map((attachment) => refId(attachment));
}

function readContent(value: unknown): string {
  if (!isRecord(value)) throw new TypeError("Expected a serialized post.");
  const contentText = value["contentText"];
  if (typeof contentText === "string") return contentText;
  const contentHtml = value["contentHtml"];
  if (typeof contentHtml === "string") return contentHtml;
  throw new TypeError("Expected a serialized post with content.");
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

function publicNotificationId(target: AdapterE2ETarget, rawId: string): string {
  return createEntityRef({
    adapter: target.adapter,
    origin: target.origin,
    type: "notification",
    id: rawId,
  }).id;
}

function publicAccountId(target: AdapterE2ETarget, rawId: string): string {
  return createEntityRef({
    adapter: target.adapter,
    origin: target.origin,
    type: "account",
    id: rawId,
  }).id;
}

function publicUpdatePostId(target: AdapterE2ETarget, fallback: string): string {
  return target.updatePostId === undefined ? fallback : publicPostId(target, target.updatePostId);
}

function futureIsoDate(minutesFromNow: number): string {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  date.setMilliseconds(0);
  return date.toISOString();
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
