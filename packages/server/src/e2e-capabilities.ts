import {
  capabilityNames,
  type CapabilityName,
  type CapabilitySet,
  type CapabilityStatus,
  type CapabilitySourceKind,
} from "@activityplug/core";
import { type AdapterE2ETarget } from "@activityplug/e2e-fixtures";
import { expect } from "vitest";

export async function expectCapabilitySurfaces(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  expected: CapabilitySet,
): Promise<CapabilitySet> {
  const httpCapabilities = await capabilitiesOverHttp(fetch, target);
  const graphqlCapabilities = await capabilitiesOverGraphQL(fetch, target);

  for (const name of capabilityNames) {
    expect(httpCapabilities[name]).toMatchObject({
      name,
      status: expected[name].status,
    });
    expect(graphqlCapabilities[name]).toMatchObject({
      name,
      status: httpCapabilities[name].status,
    });
  }

  return httpCapabilities;
}

async function capabilitiesOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
): Promise<CapabilitySet> {
  const response = await fetch(
    new Request(
      `http://activityplug.test/api/v1/instances/${encodeURIComponent(
        target.origin,
      )}/capabilities?adapter=${encodeURIComponent(target.adapter)}`,
    ),
  );
  expect(response.status).toBe(200);
  return capabilitySetFromPayload(await readJsonData(response));
}

async function capabilitiesOverGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
): Promise<CapabilitySet> {
  const result = await postGraphQL(fetch, {
    query:
      "query($origin: String!, $adapter: AdapterKind) { capabilities(origin: $origin, adapter: $adapter) { auth { name status source reason } instance { name status source reason } accounts { name status source reason } posts { name status source reason } timelines { name status source reason } media { name status source reason } social { name status source reason } search { name status source reason } notifications { name status source reason } polls { name status source reason } lists { name status source reason } followRequests { name status source reason } filters { name status source reason } scheduledPosts { name status source reason } streaming { name status source reason } admin { name status source reason } } }",
    variables: { origin: target.origin, adapter: target.adapter.toUpperCase() },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL capabilities response must include data.");
  return capabilitySetFromPayload(data["capabilities"]);
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

async function readJsonData(response: Response): Promise<unknown> {
  const json = (await response.json()) as unknown;
  if (!isRecord(json)) throw new TypeError("ActivityPlug server E2E response must be an object.");
  return json["data"];
}

function capabilitySetFromPayload(payload: unknown): CapabilitySet {
  if (!isRecord(payload)) throw new TypeError("Capability payload must be an object.");
  const entries = new Map<CapabilityName, CapabilitySet[CapabilityName]>();
  for (const list of Object.values(payload)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isCapabilityItem(item)) continue;
      entries.set(item.name, {
        name: item.name,
        status: item.status,
        source: item.source,
        ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      });
    }
  }
  const missing = capabilityNames.find((name) => !entries.has(name));
  if (missing !== undefined) throw new TypeError(`Capability payload is missing ${missing}.`);
  return Object.fromEntries(entries) as CapabilitySet;
}

function isCapabilityItem(value: unknown): value is {
  readonly name: CapabilityName;
  readonly status: CapabilityStatus;
  readonly source: CapabilitySourceKind;
  readonly reason?: string | null;
} {
  return (
    isRecord(value) &&
    capabilityNames.includes(value["name"] as CapabilityName) &&
    isCapabilityStatus(value["status"]) &&
    isCapabilitySource(value["source"]) &&
    (value["reason"] === null ||
      value["reason"] === undefined ||
      typeof value["reason"] === "string")
  );
}

function isCapabilityStatus(value: unknown): value is CapabilityStatus {
  return value === "supported" || value === "unsupported" || value === "unknown";
}

function isCapabilitySource(value: unknown): value is CapabilitySourceKind {
  return (
    value === "static" ||
    value === "nodeinfo" ||
    value === "oauth" ||
    value === "instance" ||
    value === "probe"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
