import { type AdapterE2ETarget } from "@activityplug/e2e-fixtures";
import { expect } from "vitest";

import { type E2EFetch, fetchWithRateLimitRetry, isRecord, readJsonData } from "./e2e-utils.js";

export function hasSupportedPostSocialAction(isSupported: (name: string) => boolean): boolean {
  return (
    isSupported("social.favourite") ||
    isSupported("social.bookmark") ||
    isSupported("social.boost") ||
    isSupported("social.reaction")
  );
}

export function hasSupportedAccountSocialAction(isSupported: (name: string) => boolean): boolean {
  return isSupported("social.follow") || isSupported("social.block") || isSupported("social.mute");
}

export async function expectSupportedAccountSocialActions(
  fetch: E2EFetch,
  isSupported: (name: string) => boolean,
  accountId: string,
  sessionId: string,
  graphqlSessionId: string,
  postGraphQL: (
    fetch: E2EFetch,
    body: { readonly query: string; readonly variables?: Record<string, unknown> },
  ) => Promise<Record<string, unknown>>,
): Promise<void> {
  if (isSupported("accounts.relationships")) {
    await accountRelationshipOverHttp(fetch, accountId, sessionId);
    await accountRelationshipOverGraphQL(fetch, accountId, graphqlSessionId, postGraphQL);
  }
  if (isSupported("social.follow")) {
    await accountActionOverHttp(fetch, accountId, "unfollow", sessionId, true);
    await accountActionOverHttp(fetch, accountId, "follow", sessionId);
    await accountActionOverHttp(fetch, accountId, "unfollow", sessionId);
    await accountActionOverGraphQL(
      fetch,
      "unfollowAccount",
      accountId,
      graphqlSessionId,
      postGraphQL,
      true,
    );
    await accountActionOverGraphQL(
      fetch,
      "followAccount",
      accountId,
      graphqlSessionId,
      postGraphQL,
    );
    await accountActionOverGraphQL(
      fetch,
      "unfollowAccount",
      accountId,
      graphqlSessionId,
      postGraphQL,
    );
  }
  if (isSupported("social.block")) {
    await accountActionOverHttp(fetch, accountId, "unblock", sessionId, true);
    await accountActionOverHttp(fetch, accountId, "block", sessionId);
    await accountActionOverHttp(fetch, accountId, "unblock", sessionId);
    await accountActionOverGraphQL(
      fetch,
      "unblockAccount",
      accountId,
      graphqlSessionId,
      postGraphQL,
      true,
    );
    await accountActionOverGraphQL(fetch, "blockAccount", accountId, graphqlSessionId, postGraphQL);
    await accountActionOverGraphQL(
      fetch,
      "unblockAccount",
      accountId,
      graphqlSessionId,
      postGraphQL,
    );
  }
  if (isSupported("social.mute")) {
    await accountActionOverHttp(fetch, accountId, "unmute", sessionId, true);
    await accountActionOverHttp(fetch, accountId, "mute", sessionId);
    await accountActionOverHttp(fetch, accountId, "unmute", sessionId);
    await accountActionOverGraphQL(
      fetch,
      "unmuteAccount",
      accountId,
      graphqlSessionId,
      postGraphQL,
      true,
    );
    await accountActionOverGraphQL(fetch, "muteAccount", accountId, graphqlSessionId, postGraphQL);
    await accountActionOverGraphQL(
      fetch,
      "unmuteAccount",
      accountId,
      graphqlSessionId,
      postGraphQL,
    );
  }
}

export async function expectSupportedPostSocialActions(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  isSupported: (name: string) => boolean,
  postId: string,
  sessionId: string,
  waitForPostOverHttp: (fetch: E2EFetch, postId: string) => Promise<void>,
): Promise<void> {
  if (isSupported("social.favourite")) {
    await postActionOverHttp(fetch, target, postId, "favourite", sessionId);
    await postActionOverHttp(fetch, target, postId, "unfavourite", sessionId);
  }
  if (isSupported("social.bookmark")) {
    await postActionOverHttp(fetch, target, postId, "bookmark", sessionId);
    await postActionOverHttp(fetch, target, postId, "unbookmark", sessionId);
  }
  if (isSupported("social.boost")) {
    await postActionOverHttp(
      fetch,
      target,
      postId,
      "boost",
      sessionId,
      target.adapter === "hackerspub" ? undefined : { visibility: "public" },
    );
    if (target.adapter === "misskey") await waitForPostOverHttp(fetch, postId);
    await postActionOverHttp(fetch, target, postId, "unboost", sessionId);
  }
  if (isSupported("social.reaction")) {
    const emoji = target.adapter === "hackerspub" ? "❤️" : "👍";
    await postActionOverHttp(fetch, target, postId, "reactions", sessionId, { emoji });
    await deleteReactionOverHttp(fetch, target, postId, sessionId, emoji);
  }
}

export async function expectSupportedPostSocialActionsGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  isSupported: (name: string) => boolean,
  postId: string,
  sessionId: string,
  postGraphQL: (
    fetch: E2EFetch,
    body: { readonly query: string; readonly variables?: Record<string, unknown> },
  ) => Promise<Record<string, unknown>>,
  waitForPostOverHttp: (fetch: E2EFetch, postId: string) => Promise<void>,
): Promise<void> {
  if (isSupported("social.favourite")) {
    await postActionOverGraphQL(fetch, target, "favouritePost", postId, sessionId, postGraphQL);
    await postActionOverGraphQL(fetch, target, "unfavouritePost", postId, sessionId, postGraphQL);
  }
  if (isSupported("social.bookmark")) {
    await postActionOverGraphQL(fetch, target, "bookmarkPost", postId, sessionId, postGraphQL);
    await postActionOverGraphQL(fetch, target, "unbookmarkPost", postId, sessionId, postGraphQL);
  }
  if (isSupported("social.boost")) {
    await postActionOverGraphQL(
      fetch,
      target,
      "boostPost",
      postId,
      sessionId,
      postGraphQL,
      target.adapter === "hackerspub" ? undefined : { visibility: "PUBLIC" },
    );
    if (target.adapter === "misskey") await waitForPostOverHttp(fetch, postId);
    await postActionOverGraphQL(fetch, target, "unboostPost", postId, sessionId, postGraphQL);
  }
  if (isSupported("social.reaction")) {
    const emoji = target.adapter === "hackerspub" ? "❤️" : "👍";
    await postActionOverGraphQL(fetch, target, "reactToPost", postId, sessionId, postGraphQL, {
      emoji,
    });
    await postActionOverGraphQL(fetch, target, "unreactToPost", postId, sessionId, postGraphQL, {
      emoji,
    });
  }
}

async function accountRelationshipOverHttp(
  fetch: E2EFetch,
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
  fetch: E2EFetch,
  accountId: string,
  sessionId: string,
  postGraphQL: (
    fetch: E2EFetch,
    body: { readonly query: string; readonly variables?: Record<string, unknown> },
  ) => Promise<Record<string, unknown>>,
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
  fetch: E2EFetch,
  accountId: string,
  action: "follow" | "unfollow" | "block" | "unblock" | "mute" | "unmute",
  sessionId: string,
  allowFailure = false,
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
  if (allowFailure && response.status !== 200) return;
  await expectStatus(response, 200);
  expect(await readJsonData(response)).toMatchObject({ account: { id: accountId } });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`Expected HTTP ${status}, got ${response.status}: ${await response.text()}`);
  }
}

async function accountActionOverGraphQL(
  fetch: E2EFetch,
  mutation:
    | "followAccount"
    | "unfollowAccount"
    | "blockAccount"
    | "unblockAccount"
    | "muteAccount"
    | "unmuteAccount",
  accountId: string,
  sessionId: string,
  postGraphQL: (
    fetch: E2EFetch,
    body: { readonly query: string; readonly variables?: Record<string, unknown> },
  ) => Promise<Record<string, unknown>>,
  allowFailure = false,
): Promise<void> {
  const body =
    mutation === "muteAccount"
      ? {
          query: `mutation($input: MuteAccountInput!) { ${mutation}(input: $input) { account { id } } }`,
          variables: { input: { accountId, sessionId } },
        }
      : {
          query: `mutation($id: ID!, $sessionId: ID!) { ${mutation}(id: $id, sessionId: $sessionId) { account { id } } }`,
          variables: { id: accountId, sessionId },
        };
  const result = allowFailure ? await tryPostGraphQL(fetch, body) : await postGraphQL(fetch, body);
  if (result === undefined) return;
  expect(result["data"]).toMatchObject({ [mutation]: { account: { id: accountId } } });
}

async function tryPostGraphQL(
  fetch: E2EFetch,
  body: { readonly query: string; readonly variables?: Record<string, unknown> },
): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(
    new Request("http://activityplug.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json = (await response.json()) as unknown;
  if (!isRecord(json) || json["errors"] !== undefined) return undefined;
  return json;
}

async function postActionOverHttp(
  fetch: E2EFetch,
  _target: AdapterE2ETarget,
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
  const response = await fetchWithRateLimitRetry(
    fetch,
    () =>
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
  const post = await readJsonData(response);
  expect(postActionMatchesTarget(post, postId, action === "boost")).toBe(true);
}

async function deleteReactionOverHttp(
  fetch: E2EFetch,
  _target: AdapterE2ETarget,
  postId: string,
  sessionId: string,
  emoji: string,
): Promise<void> {
  const response = await fetchWithRateLimitRetry(
    fetch,
    () =>
      new Request(
        `http://activityplug.test/api/v1/posts/${encodeURIComponent(postId)}/reactions/${encodeURIComponent(emoji)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${sessionId}` } },
      ),
  );
  expect(response.status).toBe(200);
  const post = await readJsonData(response);
  expect(postActionMatchesTarget(post, postId, false)).toBe(true);
}

async function postActionOverGraphQL(
  fetch: E2EFetch,
  _target: AdapterE2ETarget,
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
  postGraphQL: (
    fetch: E2EFetch,
    body: { readonly query: string; readonly variables?: Record<string, unknown> },
  ) => Promise<Record<string, unknown>>,
  extraInput: Record<string, unknown> = {},
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query: postActionMutation(mutation),
    variables: postActionVariables(mutation, postId, sessionId, extraInput),
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL post action response must include data.");
  expect(postActionMatchesTarget(data[mutation], postId, mutation === "boostPost")).toBe(true);
}

function postActionMutation(mutation: string): string {
  if (mutation === "boostPost") {
    return `mutation($input: BoostPostInput!) { ${mutation}(input: $input) { ref { id origin } boostOf { id } } }`;
  }
  if (mutation === "reactToPost" || mutation === "unreactToPost") {
    return `mutation($input: ReactPostInput!) { ${mutation}(input: $input) { ref { id origin } } }`;
  }
  return `mutation($id: ID!, $sessionId: ID!) { ${mutation}(id: $id, sessionId: $sessionId) { ref { id origin } } }`;
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

function postActionMatchesTarget(
  value: unknown,
  postId: string,
  allowBoostWrapper: boolean,
): boolean {
  if (!isRecord(value) || !isRecord(value["ref"]) || typeof value["ref"]["id"] !== "string") {
    throw new TypeError("Expected a post action response with a public ref id.");
  }
  if (value["ref"]["id"] === postId) return true;
  if (!allowBoostWrapper || !isRecord(value["boostOf"])) return false;
  return value["boostOf"]["id"] === postId;
}
