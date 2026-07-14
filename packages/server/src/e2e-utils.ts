import { expect } from "vitest";
import { z } from "zod";

export type E2EFetch = (request: Request) => Response | Promise<Response>;

export async function readJsonData(response: Response): Promise<unknown> {
  const json = (await response.json()) as unknown;
  if (!isRecord(json)) throw new TypeError("ActivityPlug server E2E response must be an object.");
  return json["data"];
}

export async function postGraphQL(
  fetch: E2EFetch,
  body: { readonly query: string; readonly variables?: Record<string, unknown> },
  authSessionId?: string,
): Promise<Record<string, unknown>> {
  const response = await fetchWithRateLimitRetry(
    fetch,
    () =>
      new Request("http://activityplug.test/graphql", {
        method: "POST",
        headers: {
          ...(authSessionId === undefined ? {} : { authorization: `Bearer ${authSessionId}` }),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
  );
  const responseText = await response.text();
  expect(response.status, responseText).toBe(200);
  const json = JSON.parse(responseText) as unknown;
  if (!isRecord(json)) throw new TypeError("GraphQL response must be an object.");
  expect(json["errors"]).toBeUndefined();
  return json;
}

export type PostGraphQL = typeof postGraphQL;

export async function fetchWithRateLimitRetry(
  fetch: E2EFetch,
  request: () => Request,
): Promise<Response> {
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    const response = await fetch(request());
    if (response.status !== 429) return response;
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  return new Response("Timed out while retrying a rate-limited E2E request.", { status: 429 });
}

const jsonRecordSchema = z.looseObject({});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return jsonRecordSchema.safeParse(value).success;
}
