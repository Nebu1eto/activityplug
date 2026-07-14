import { createCapabilitySet } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { createDefaultApiService, serializeOAuthClientRegistration } from "./service.js";

describe("default API service parity", () => {
  it("redacts OAuth client secrets from public registration metadata", () => {
    expect(
      serializeOAuthClientRegistration({
        clientId: "client-1",
        clientSecret: "secret-1",
        redirectUris: ["https://client.example/callback"],
        scopes: ["read"],
        raw: { client_secret: "secret-1" },
      }),
    ).toEqual({
      clientId: "client-1",
      redirectUris: ["https://client.example/callback"],
      scopes: ["read"],
    });
  });

  it("returns a typed unsupported result for reserved operations", async () => {
    const service = createDefaultApiService(createCapabilitySet());

    await expect(service.posts.context({ id: "post-1" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "post.context" },
    });
  });
});
