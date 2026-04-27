import {
  type ActivityPlugAdapter,
  type CapabilityName,
  createActivityPlug,
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
  const capabilities = client.capabilities;
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

  if (session !== undefined && isSupported(capabilities, "media.upload")) {
    await uploadMediaOverHttp(server.app.fetch, target, session.id);

    if (graphqlSession !== undefined) {
      await uploadMediaOverGraphQL(server.app.fetch, target, graphqlSession.id);
    }
  }

  const checksPostSocialActions =
    session !== undefined &&
    graphqlSession !== undefined &&
    hasSupportedPostSocialAction(capabilities);
  let checkedPostSocialActions = false;

  if (
    session !== undefined &&
    isSupported(capabilities, "posts.create") &&
    isSupported(capabilities, "posts.delete")
  ) {
    const httpCreated = await createPostOverHttp(server.app.fetch, target, session.id);
    if (target.adapter === "misskey") await delay(10_000);
    await expectSupportedPostSocialActions(
      server.app.fetch,
      target,
      capabilities,
      httpCreated,
      session.id,
    );
    await deletePostOverHttp(server.app.fetch, httpCreated, session.id);

    if (graphqlSession !== undefined) {
      if (target.adapter === "misskey") await delay(10_000);
      const graphqlCreated = await createPostOverGraphQL(
        server.app.fetch,
        target,
        graphqlSession.id,
      );
      if (target.adapter === "misskey") await delay(10_000);
      await expectSupportedPostSocialActionsGraphQL(
        server.app.fetch,
        target,
        capabilities,
        graphqlCreated,
        graphqlSession.id,
      );
      await deletePostOverGraphQL(server.app.fetch, graphqlCreated, graphqlSession.id);
    }
    checkedPostSocialActions = true;
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
      capabilities,
      seededPostId,
      session.id,
    );
    await expectSupportedPostSocialActionsGraphQL(
      server.app.fetch,
      target,
      capabilities,
      seededPostId,
      graphqlSession.id,
    );
  }

  if (target.accountHandle !== undefined && isSupported(capabilities, "search.accounts")) {
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
    expect(await readJsonData(searchResponse)).toMatchObject({
      accounts: expect.any(Array),
    });

    const graphqlSearch = await postGraphQL(server.app.fetch, {
      query:
        "query($input: SearchInput!) { search(input: $input) { accounts { ref { origin rawId } } } }",
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
    expect(graphqlSearch["data"]).toMatchObject({
      search: { accounts: expect.any(Array) },
    });
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
    expect(
      (hashtagSearch as { readonly hashtags?: readonly unknown[] }).hashtags?.length,
    ).toBeGreaterThan(0);

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
    expect(hashtags?.length).toBeGreaterThan(0);
  }

  if (
    session !== undefined &&
    graphqlSession !== undefined &&
    isSupported(capabilities, "accounts.lookupByHandle")
  ) {
    if (target.socialActionHandle === undefined && hasSupportedAccountSocialAction(capabilities)) {
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
        capabilities,
        accountId,
        session.id,
        graphqlSession.id,
      );
    }
  }

  if (!isSupported(capabilities, "search.posts")) return;
  if (target.postSearchQuery === undefined) {
    throw new TypeError("Fediverse server E2E target must provide postSearchQuery.");
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
  expect((postSearch as { readonly posts?: readonly unknown[] }).posts?.length).toBeGreaterThan(0);

  const graphqlPostSearch = await postGraphQL(server.app.fetch, {
    query: "query($input: SearchInput!) { search(input: $input) { posts { ref { rawId } } } }",
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
  expect(posts?.length).toBeGreaterThan(0);
}

function isSupported(capabilities: CapabilitySet, name: CapabilityName): boolean {
  return capabilities[name]?.status === "supported";
}

function hasSupportedPostSocialAction(capabilities: CapabilitySet): boolean {
  return (
    isSupported(capabilities, "social.favourite") ||
    isSupported(capabilities, "social.bookmark") ||
    isSupported(capabilities, "social.boost") ||
    isSupported(capabilities, "social.reaction")
  );
}

function hasSupportedAccountSocialAction(capabilities: CapabilitySet): boolean {
  return (
    isSupported(capabilities, "social.follow") ||
    isSupported(capabilities, "social.block") ||
    isSupported(capabilities, "social.mute")
  );
}

async function readJsonData(response: Response): Promise<unknown> {
  const json = (await response.json()) as unknown;
  if (!isRecord(json)) throw new TypeError("ActivityPlug server E2E response must be an object.");
  return json["data"];
}

async function postGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  body: { readonly query: string; readonly variables?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const response = await fetch(
    new Request("http://activityplug.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  const json = (await response.json()) as unknown;
  if (!isRecord(json)) throw new TypeError("GraphQL response must be an object.");
  expect(json["errors"]).toBeUndefined();
  return json;
}

async function importTokenOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
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
  fetch: (request: Request) => Response | Promise<Response>,
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

async function uploadMediaOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  const form = new FormData();
  form.set("origin", target.origin);
  form.set("adapter", target.adapter);
  form.set(
    "file",
    new File([onePixelPngBuffer()], "activityplug-server-e2e.png", { type: "image/png" }),
  );
  form.set("description", "ActivityPlug server E2E media upload");
  const response = await fetch(
    new Request("http://activityplug.test/api/v1/media", {
      method: "POST",
      headers: { authorization: `Bearer ${authSessionId}` },
      body: form,
    }),
  );
  expect(response.status).toBe(200);
  expect(await readJsonData(response)).toMatchObject({ ref: { origin: target.origin } });
}

async function uploadMediaOverGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query:
      "mutation($input: UploadMediaInput!) { uploadMedia(input: $input) { ref { origin rawId } } }",
    variables: {
      input: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
        fileBase64: Buffer.from(onePixelPngBuffer()).toString("base64"),
        filename: "activityplug-server-e2e.png",
        contentType: "image/png",
        description: "ActivityPlug server GraphQL E2E media upload",
      },
    },
  });
  expect(result["data"]).toMatchObject({ uploadMedia: { ref: { origin: target.origin } } });
}

async function createPostOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
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
        content: `ActivityPlug server HTTP E2E ${Date.now()}`,
        visibility: "public",
      }),
    }),
  );
  expect(response.status).toBe(200);
  const post = await readJsonData(response);
  return refId(post);
}

async function deletePostOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
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
  expect(await readJsonData(response)).toMatchObject({ deleted: true });
}

async function createPostOverGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<string> {
  const result = await postGraphQL(fetch, {
    query:
      "mutation($input: CreatePostInput!) { createPost(input: $input) { ref { id origin rawId } } }",
    variables: {
      input: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
        content: `ActivityPlug server GraphQL E2E ${Date.now()}`,
        visibility: "PUBLIC",
      },
    },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL createPost response must include data.");
  const created = data["createPost"];
  return refId(created);
}

async function deletePostOverGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  id: string,
  authSessionId: string,
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query:
      "mutation($id: ID!, $sessionId: ID!) { deletePost(id: $id, sessionId: $sessionId) { deleted } }",
    variables: { id, sessionId: authSessionId },
  });
  expect(result["data"]).toMatchObject({ deletePost: { deleted: true } });
}

async function ownedSeededPostId(
  fetch: (request: Request) => Response | Promise<Response>,
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
  fetch: (request: Request) => Response | Promise<Response>,
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

async function expectSupportedAccountSocialActions(
  fetch: (request: Request) => Response | Promise<Response>,
  capabilities: CapabilitySet,
  accountId: string,
  sessionId: string,
  graphqlSessionId: string,
): Promise<void> {
  if (isSupported(capabilities, "accounts.relationships")) {
    await accountRelationshipOverHttp(fetch, accountId, sessionId);
    await accountRelationshipOverGraphQL(fetch, accountId, graphqlSessionId);
  }
  if (isSupported(capabilities, "social.follow")) {
    await accountActionOverHttp(fetch, accountId, "follow", sessionId);
    await accountActionOverHttp(fetch, accountId, "unfollow", sessionId);
    await accountActionOverGraphQL(fetch, "followAccount", accountId, graphqlSessionId);
    await accountActionOverGraphQL(fetch, "unfollowAccount", accountId, graphqlSessionId);
  }
  if (isSupported(capabilities, "social.block")) {
    await accountActionOverHttp(fetch, accountId, "block", sessionId);
    await accountActionOverHttp(fetch, accountId, "unblock", sessionId);
    await accountActionOverGraphQL(fetch, "blockAccount", accountId, graphqlSessionId);
    await accountActionOverGraphQL(fetch, "unblockAccount", accountId, graphqlSessionId);
  }
  if (isSupported(capabilities, "social.mute")) {
    await accountActionOverHttp(fetch, accountId, "mute", sessionId);
    await accountActionOverHttp(fetch, accountId, "unmute", sessionId);
    await accountActionOverGraphQL(fetch, "muteAccount", accountId, graphqlSessionId);
    await accountActionOverGraphQL(fetch, "unmuteAccount", accountId, graphqlSessionId);
  }
}

async function accountRelationshipOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
  accountId: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/accounts/${encodeURIComponent(accountId)}/relationships`,
      { headers: { authorization: `Bearer ${sessionId}` } },
    ),
  );
  expect(response.status).toBe(200);
  expect(await readJsonData(response)).toMatchObject({ account: { id: accountId } });
}

async function accountRelationshipOverGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  accountId: string,
  sessionId: string,
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query:
      "query($id: ID!, $sessionId: ID!) { accountRelationship(id: $id, sessionId: $sessionId) { account { id } } }",
    variables: { id: accountId, sessionId },
  });
  expect(result["data"]).toMatchObject({
    accountRelationship: { account: { id: accountId } },
  });
}

async function accountActionOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
  accountId: string,
  action: "follow" | "unfollow" | "block" | "unblock" | "mute" | "unmute",
  sessionId: string,
): Promise<void> {
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/accounts/${encodeURIComponent(accountId)}/${action}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${sessionId}` },
      },
    ),
  );
  expect(response.status).toBe(200);
  expect(await readJsonData(response)).toMatchObject({ account: { id: accountId } });
}

async function accountActionOverGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  mutation:
    | "followAccount"
    | "unfollowAccount"
    | "blockAccount"
    | "unblockAccount"
    | "muteAccount"
    | "unmuteAccount",
  accountId: string,
  sessionId: string,
): Promise<void> {
  const result =
    mutation === "muteAccount"
      ? await postGraphQL(fetch, {
          query: `mutation($input: MuteAccountInput!) { ${mutation}(input: $input) { account { id } } }`,
          variables: { input: { accountId, sessionId } },
        })
      : await postGraphQL(fetch, {
          query: `mutation($id: ID!, $sessionId: ID!) { ${mutation}(id: $id, sessionId: $sessionId) { account { id } } }`,
          variables: { id: accountId, sessionId },
        });
  expect(result["data"]).toMatchObject({ [mutation]: { account: { id: accountId } } });
}

async function expectSupportedPostSocialActions(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  capabilities: CapabilitySet,
  postId: string,
  sessionId: string,
): Promise<void> {
  if (isSupported(capabilities, "social.favourite")) {
    await postActionOverHttp(fetch, target, postId, "favourite", sessionId);
    await postActionOverHttp(fetch, target, postId, "unfavourite", sessionId);
  }
  if (isSupported(capabilities, "social.bookmark")) {
    await postActionOverHttp(fetch, target, postId, "bookmark", sessionId);
    await postActionOverHttp(fetch, target, postId, "unbookmark", sessionId);
  }
  if (isSupported(capabilities, "social.boost")) {
    await postActionOverHttp(fetch, target, postId, "boost", sessionId, { visibility: "public" });
    if (target.adapter === "misskey") await delay(10_000);
    await postActionOverHttp(fetch, target, postId, "unboost", sessionId);
  }
  if (isSupported(capabilities, "social.reaction")) {
    await postActionOverHttp(fetch, target, postId, "reactions", sessionId, { emoji: "👍" });
    await deleteReactionOverHttp(fetch, target, postId, sessionId, "👍");
  }
}

async function expectSupportedPostSocialActionsGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  capabilities: CapabilitySet,
  postId: string,
  sessionId: string,
): Promise<void> {
  if (isSupported(capabilities, "social.favourite")) {
    await postActionOverGraphQL(fetch, target, "favouritePost", postId, sessionId);
    await postActionOverGraphQL(fetch, target, "unfavouritePost", postId, sessionId);
  }
  if (isSupported(capabilities, "social.bookmark")) {
    await postActionOverGraphQL(fetch, target, "bookmarkPost", postId, sessionId);
    await postActionOverGraphQL(fetch, target, "unbookmarkPost", postId, sessionId);
  }
  if (isSupported(capabilities, "social.boost")) {
    await postActionOverGraphQL(fetch, target, "boostPost", postId, sessionId, {
      visibility: "PUBLIC",
    });
    if (target.adapter === "misskey") await delay(10_000);
    await postActionOverGraphQL(fetch, target, "unboostPost", postId, sessionId);
  }
  if (isSupported(capabilities, "social.reaction")) {
    await postActionOverGraphQL(fetch, target, "reactToPost", postId, sessionId, { emoji: "👍" });
    await postActionOverGraphQL(fetch, target, "unreactToPost", postId, sessionId, { emoji: "👍" });
  }
}

async function postActionOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  postId: string,
  action:
    | "favourite"
    | "unfavourite"
    | "bookmark"
    | "unbookmark"
    | "boost"
    | "unboost"
    | "reactions",
  sessionId: string,
  body?: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    new Request(`http://activityplug.test/api/v1/posts/${encodeURIComponent(postId)}/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionId}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await readJsonData(response)).toMatchObject({ ref: { origin: target.origin } });
}

async function deleteReactionOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  postId: string,
  sessionId: string,
  emoji: string,
): Promise<void> {
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/posts/${encodeURIComponent(postId)}/reactions/${encodeURIComponent(emoji)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${sessionId}` } },
    ),
  );
  expect(response.status).toBe(200);
  expect(await readJsonData(response)).toMatchObject({ ref: { origin: target.origin } });
}

async function postActionOverGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  mutation:
    | "favouritePost"
    | "unfavouritePost"
    | "bookmarkPost"
    | "unbookmarkPost"
    | "boostPost"
    | "unboostPost"
    | "reactToPost"
    | "unreactToPost",
  postId: string,
  sessionId: string,
  extraInput: Record<string, unknown> = {},
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query: postActionMutation(mutation),
    variables: postActionVariables(mutation, postId, sessionId, extraInput),
  });
  expect(result["data"]).toMatchObject({ [mutation]: { ref: { origin: target.origin } } });
}

function postActionMutation(mutation: string): string {
  if (mutation === "boostPost") {
    return `mutation($input: BoostPostInput!) { ${mutation}(input: $input) { ref { origin } } }`;
  }
  if (mutation === "reactToPost" || mutation === "unreactToPost") {
    return `mutation($input: ReactPostInput!) { ${mutation}(input: $input) { ref { origin } } }`;
  }
  return `mutation($id: ID!, $sessionId: ID!) { ${mutation}(id: $id, sessionId: $sessionId) { ref { origin } } }`;
}

function postActionVariables(
  mutation: string,
  postId: string,
  sessionId: string,
  extraInput: Record<string, unknown>,
): Record<string, unknown> {
  if (mutation === "boostPost" || mutation === "reactToPost" || mutation === "unreactToPost") {
    return { input: { postId, sessionId, ...extraInput } };
  }
  return { id: postId, sessionId };
}

function refId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value["ref"]) || typeof value["ref"]["id"] !== "string") {
    throw new TypeError("Expected a serialized entity ref with a public id.");
  }
  return value["ref"]["id"];
}

function adapterKind(adapter: string): string {
  return adapter.toUpperCase();
}

function onePixelPngBuffer(): ArrayBuffer {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]).buffer;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
