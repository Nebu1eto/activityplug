import {
  capabilityNames,
  type CapabilityName,
  type CapabilitySet,
  type CapabilityStatus,
  type CapabilitySourceKind,
} from "@activityplug/core";
import { type AdapterE2ETarget } from "@activityplug/e2e-fixtures";
import { expect } from "vitest";
import { z } from "zod";

import { postGraphQL } from "./e2e-utils.js";

export async function expectCapabilitySurfaces(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
): Promise<CapabilitySet> {
  const httpCapabilities = await capabilitiesOverHttp(fetch, target);
  const graphqlCapabilities = await capabilitiesOverGraphQL(fetch, target);

  for (const name of capabilityNames) {
    expect(httpCapabilities[name]).toMatchObject({
      name,
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
      "query($origin: String!, $adapter: AdapterId) { capabilities(origin: $origin, adapter: $adapter) { auth { name status source reason } instance { name status source reason } accounts { name status source reason } posts { name status source reason } timelines { name status source reason } media { name status source reason } social { name status source reason } search { name status source reason } notifications { name status source reason } polls { name status source reason } lists { name status source reason } followRequests { name status source reason } filters { name status source reason } scheduledPosts { name status source reason } streaming { name status source reason } admin { name status source reason } } }",
    variables: { origin: target.origin, adapter: target.adapter },
  });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL capabilities response must include data.");
  return capabilitySetFromPayload(data["capabilities"]);
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

const capabilityItemSchema = z.looseObject({
  name: z.enum(capabilityNames),
  status: z.enum(["supported", "unsupported", "unknown"]),
  source: z.enum(["static", "nodeinfo", "oauth", "instance", "probe"]),
  reason: z.string().nullish(),
});

function isCapabilityItem(value: unknown): value is {
  readonly name: CapabilityName;
  readonly status: CapabilityStatus;
  readonly source: CapabilitySourceKind;
  readonly reason?: string | null;
} {
  return capabilityItemSchema.safeParse(value).success;
}

const jsonRecordSchema = z.looseObject({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return jsonRecordSchema.safeParse(value).success;
}
