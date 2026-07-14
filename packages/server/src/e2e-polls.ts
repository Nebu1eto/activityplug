import { createEntityRef, type CapabilitySet } from "@activityplug/core";
import { type AdapterE2ETarget } from "@activityplug/e2e-fixtures";
import { expect } from "vitest";

import { isRecord, postGraphQL, readJsonData } from "./e2e-utils.js";

export async function expectPollSurfaces(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  capabilities: CapabilitySet,
  sessionId: string | undefined,
  graphqlSessionId: string | undefined,
): Promise<void> {
  if (capabilities["polls.read"]?.status !== "supported") return;
  if (target.pollId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide pollId.");
  }
  if (sessionId === undefined || graphqlSessionId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide auth sessions for polls.");
  }
  const httpPollId = publicPollId(target, target.httpPollId ?? target.pollId);
  const graphqlPollId = publicPollId(target, target.graphqlPollId ?? target.pollId);
  await pollOverHttp(fetch, httpPollId, sessionId);
  await pollOverGraphQL(fetch, graphqlPollId, graphqlSessionId);
  if (capabilities["polls.vote"]?.status !== "supported") return;
  if (target.httpPollId === undefined || target.graphqlPollId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide separate poll vote targets.");
  }
  await votePollOverHttp(fetch, httpPollId, sessionId);
  await votePollOverGraphQL(fetch, graphqlPollId, graphqlSessionId);
}

function publicPollId(target: AdapterE2ETarget, rawId: string | undefined): string {
  if (rawId === undefined) {
    throw new TypeError("Fediverse server E2E target must provide pollId.");
  }
  return createEntityRef({
    adapter: target.adapter,
    origin: target.origin,
    type: "poll",
    id: rawId,
  }).id;
}

async function pollOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
  pollId: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(
    new Request(`http://activityplug.test/api/v1/polls/${encodeURIComponent(pollId)}`, {
      headers: { authorization: `Bearer ${sessionId}` },
    }),
  );
  expect(response.status).toBe(200);
  const poll = await readJsonData(response);
  expectExpectedPollPayload(poll);
  expect(refId(poll)).toBe(pollId);
}

async function pollOverGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  pollId: string,
  sessionId: string,
): Promise<void> {
  const result = await postGraphQL(
    fetch,
    {
      query: "query($id: ID!) { poll(id: $id) { ref { id } multiple options { title } } }",
      variables: { id: pollId },
    },
    sessionId,
  );
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL poll response must include data.");
  expect(refId(data["poll"])).toBe(pollId);
  expectExpectedPollPayload(data["poll"]);
}

async function votePollOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
  pollId: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(
    new Request(`http://activityplug.test/api/v1/polls/${encodeURIComponent(pollId)}/votes`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionId}`, "content-type": "application/json" },
      body: JSON.stringify({ choices: [0] }),
    }),
  );
  expect(response.status).toBe(200);
  const poll = await readJsonData(response);
  expectExpectedPollPayload(poll);
  expect(refId(poll)).toBe(pollId);
}

async function votePollOverGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  pollId: string,
  sessionId: string,
): Promise<void> {
  const result = await postGraphQL(
    fetch,
    {
      query:
        "mutation($input: VotePollInput!) { votePoll(input: $input) { ref { id } multiple options { title } } }",
      variables: { input: { id: pollId, choices: [0] } },
    },
    sessionId,
  );
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL votePoll response must include data.");
  expect(refId(data["votePoll"])).toBe(pollId);
  expectExpectedPollPayload(data["votePoll"]);
}

function refId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value["ref"]) || typeof value["ref"]["id"] !== "string") {
    throw new TypeError("Expected a serialized entity ref with a public id.");
  }
  return value["ref"]["id"];
}

function expectExpectedPollPayload(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value["options"])) {
    throw new TypeError("Expected poll options.");
  }
  expect(value["multiple"]).toBe(false);
  expect(
    value["options"].map((option) => {
      if (!isRecord(option) || typeof option["title"] !== "string") {
        throw new TypeError("Expected poll option title.");
      }
      return option["title"];
    }),
  ).toEqual(["TypeScript", "ActivityPub"]);
}
