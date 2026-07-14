import { ActivityPlugError } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { createTestService } from "./app-test-utils.js";
import { createActivityPlugApp } from "./app.js";

const errorCases = [
  ["ORIGIN_NOT_ALLOWED", 403],
  ["REQUEST_LIMIT_EXCEEDED", 413],
] as const;

describe("public egress errors", () => {
  it.each(errorCases)("maps %s through the HTTP error envelope", async (code, status) => {
    const app = errorApp(code);

    const response = await app.request("/health");

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  it.each(errorCases)("preserves %s through the GraphQL error envelope", async (code) => {
    const app = errorApp(code);

    const response = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { health { ok } }" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      errors: [{ extensions: { activityplug: { code } } }],
    });
  });
});

function errorApp(code: (typeof errorCases)[number][0]) {
  return createActivityPlugApp({
    service: createTestService({
      health: () => {
        throw new ActivityPlugError(code, "Request rejected.");
      },
    }),
  });
}
