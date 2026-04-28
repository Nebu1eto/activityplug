import { type AdapterE2ETarget } from "@activityplug/e2e-fixtures";
import { expect } from "vitest";

import { onePixelPngBuffer } from "./e2e-assets.js";

export async function expectMediaSurfaces(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  sessionId: string,
  graphqlSessionId: string | undefined,
): Promise<{ readonly httpMediaId: string; readonly graphqlMediaId?: string }> {
  const httpMediaId = await uploadMediaOverHttp(fetch, target, sessionId);
  let graphqlMediaId: string | undefined;
  if (graphqlSessionId !== undefined) {
    graphqlMediaId = await uploadMediaOverGraphQL(fetch, target, graphqlSessionId);
  }
  return { httpMediaId, ...(graphqlMediaId === undefined ? {} : { graphqlMediaId }) };
}

async function uploadMediaOverHttp(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<string> {
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
  const media = await readJsonData(response);
  expect(media).toMatchObject({ ref: { origin: target.origin } });
  return refId(media);
}

async function uploadMediaOverGraphQL(
  fetch: (request: Request) => Response | Promise<Response>,
  target: AdapterE2ETarget,
  authSessionId: string,
): Promise<string> {
  const result = await postGraphQL(fetch, {
    query:
      "mutation($input: UploadMediaInput!) { uploadMedia(input: $input) { ref { id origin rawId } } }",
    variables: {
      input: {
        origin: target.origin,
        adapter: target.adapter.toUpperCase(),
        sessionId: authSessionId,
        fileBase64: Buffer.from(onePixelPngBuffer()).toString("base64"),
        filename: "activityplug-server-e2e.png",
        contentType: "image/png",
        description: "ActivityPlug server GraphQL E2E media upload",
      },
    },
  });
  expect(result["data"]).toMatchObject({ uploadMedia: { ref: { origin: target.origin } } });
  const data = result["data"];
  if (!isRecord(data)) throw new TypeError("GraphQL uploadMedia response must include data.");
  return refId(data["uploadMedia"]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value["ref"]) || typeof value["ref"]["id"] !== "string") {
    throw new TypeError("Expected a media ref id.");
  }
  return value["ref"]["id"];
}
