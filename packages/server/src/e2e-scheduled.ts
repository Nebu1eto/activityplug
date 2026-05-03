import { type AdapterE2ETarget } from "@activityplug/e2e-fixtures";
import { expect } from "vitest";

import { type E2EFetch, isRecord, postGraphQL, readJsonData } from "./e2e-utils.js";

export async function createScheduledPostOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<string> {
  const scheduledAt = futureIsoDate(10);
  const content = `ActivityPlug server HTTP scheduled E2E ${Date.now()}`;
  const response = await fetch(
    new Request("http://activityplug.test/api/v1/scheduled-posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${authSessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: target.origin,
        adapter: target.adapter,
        content,
        visibility: "public",
        scheduledAt,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const scheduled = await readJsonData(response);
  expect(scheduledPostTime(scheduled)).toBe(scheduledAt);
  expect(scheduled).toMatchObject({ contentText: content, visibility: "public" });
  return refId(scheduled);
}

export async function createScheduledPostOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<string> {
  const scheduledAt = futureIsoDate(10);
  const content = `ActivityPlug server GraphQL scheduled E2E ${Date.now()}`;
  const result = await postGraphQL(fetch, {
    query:
      "mutation($input: SchedulePostInput!) { schedulePost(input: $input) { ref { id } scheduledAt contentText visibility } }",
    variables: {
      input: {
        origin: target.origin,
        adapter: adapterKind(target.adapter),
        sessionId: authSessionId,
        content,
        visibility: "PUBLIC",
        scheduledAt,
      },
    },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL schedulePost response must include data.");
  const scheduled = data["schedulePost"];
  expect(scheduledPostTime(scheduled)).toBe(scheduledAt);
  expect(scheduled).toMatchObject({ contentText: content, visibility: "PUBLIC" });
  return refId(scheduled);
}

export async function expectScheduledPostReadOverHttp(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  id: string,
): Promise<void> {
  const getResponse = await fetch(
    new Request(`http://activityplug.test/api/v1/scheduled-posts/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${authSessionId}` },
    }),
  );
  expect(getResponse.status).toBe(200);
  const found = await readJsonData(getResponse);
  expect(refId(found)).toBe(id);
  expect(found).toMatchObject({
    contentText: expect.stringContaining("ActivityPlug server HTTP scheduled E2E"),
    visibility: "public",
  });
  const listResponse = await fetch(
    new Request(
      `http://activityplug.test/api/v1/scheduled-posts?origin=${encodeURIComponent(
        target.origin,
      )}&adapter=${encodeURIComponent(target.adapter)}&limit=5`,
      { headers: { authorization: `Bearer ${authSessionId}` } },
    ),
  );
  expect(listResponse.status).toBe(200);
  const list = await readJsonData(listResponse);
  if (!Array.isArray(list)) throw new TypeError("Expected scheduled post list data.");
  expect(list.some((item) => refId(item) === id)).toBe(true);
}

export async function expectScheduledPostReadOverGraphQL(
  fetch: E2EFetch,
  target: AdapterE2ETarget,
  authSessionId: string,
  id: string,
): Promise<void> {
  const getResult = await postGraphQL(fetch, {
    query:
      "query($id: ID!, $sessionId: ID!) { scheduledPost(id: $id, sessionId: $sessionId) { ref { id } contentText visibility } }",
    variables: { id, sessionId: authSessionId },
  });
  const getData = getResult["data"];
  if (!isRecord(getData)) throw new TypeError("GraphQL scheduledPost response must include data.");
  expect(refId(getData["scheduledPost"])).toBe(id);
  expect(getData["scheduledPost"]).toMatchObject({
    contentText: expect.stringContaining("ActivityPlug server GraphQL scheduled E2E"),
    visibility: "PUBLIC",
  });
  const listResult = await postGraphQL(fetch, {
    query:
      "query($origin: String!, $adapter: AdapterKind, $sessionId: ID!) { scheduledPosts(origin: $origin, adapter: $adapter, sessionId: $sessionId, page: { limit: 5 }) { nodes { ref { id } } } }",
    variables: {
      origin: target.origin,
      adapter: adapterKind(target.adapter),
      sessionId: authSessionId,
    },
  });
  const listData = listResult["data"];
  if (!isRecord(listData) || !isRecord(listData["scheduledPosts"])) {
    throw new TypeError("GraphQL scheduledPosts response must include data.");
  }
  const nodes = listData["scheduledPosts"]["nodes"];
  if (!Array.isArray(nodes)) throw new TypeError("GraphQL scheduledPosts must include nodes.");
  expect(nodes.some((item) => refId(item) === id)).toBe(true);
}

export async function updateScheduledPostOverHttp(
  fetch: E2EFetch,
  authSessionId: string,
  id: string,
): Promise<void> {
  const scheduledAt = futureIsoDate(20);
  const response = await fetch(
    new Request(`http://activityplug.test/api/v1/scheduled-posts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${authSessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scheduledAt }),
    }),
  );
  expect(response.status).toBe(200);
  const scheduled = await readJsonData(response);
  expect(refId(scheduled)).toBe(id);
  expect(scheduledPostTime(scheduled)).toBe(scheduledAt);
}

export async function updateScheduledPostOverGraphQL(
  fetch: E2EFetch,
  authSessionId: string,
  id: string,
): Promise<void> {
  const scheduledAt = futureIsoDate(20);
  const result = await postGraphQL(fetch, {
    query:
      "mutation($input: UpdateScheduledPostInput!) { updateScheduledPost(input: $input) { ref { id } scheduledAt } }",
    variables: { input: { id, sessionId: authSessionId, scheduledAt } },
  });
  const data = result["data"];
  if (!isRecord(data)) {
    throw new TypeError("GraphQL updateScheduledPost response must include data.");
  }
  expect(refId(data["updateScheduledPost"])).toBe(id);
  expect(scheduledPostTime(data["updateScheduledPost"])).toBe(scheduledAt);
}

export async function deleteScheduledPostOverHttp(
  fetch: E2EFetch,
  authSessionId: string,
  id: string,
): Promise<void> {
  const response = await fetch(
    new Request(`http://activityplug.test/api/v1/scheduled-posts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${authSessionId}` },
    }),
  );
  expect(response.status).toBe(200);
  const deleted = await readJsonData(response);
  expect(deleted).toMatchObject({ deleted: true });
  expect(refId(deleted)).toBe(id);
}

export async function deleteScheduledPostOverGraphQL(
  fetch: E2EFetch,
  authSessionId: string,
  id: string,
): Promise<void> {
  const result = await postGraphQL(fetch, {
    query:
      "mutation($id: ID!, $sessionId: ID!) { deleteScheduledPost(id: $id, sessionId: $sessionId) { ref { id } deleted } }",
    variables: { id, sessionId: authSessionId },
  });
  const data = result["data"];
  if (!isRecord(data)) {
    throw new TypeError("GraphQL deleteScheduledPost response must include data.");
  }
  expect(data["deleteScheduledPost"]).toMatchObject({ deleted: true });
  expect(refId(data["deleteScheduledPost"])).toBe(id);
}

function refId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value["ref"]) || typeof value["ref"]["id"] !== "string") {
    throw new TypeError("Expected a serialized entity ref with a public id.");
  }
  return value["ref"]["id"];
}

function scheduledPostTime(value: unknown): string {
  if (!isRecord(value) || typeof value["scheduledAt"] !== "string") {
    throw new TypeError("Expected a scheduled post timestamp.");
  }
  return value["scheduledAt"];
}

function futureIsoDate(minutesFromNow: number): string {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  date.setMilliseconds(0);
  return date.toISOString();
}

function adapterKind(adapter: string): string {
  return adapter.toUpperCase();
}
