import { createActivityPlugServer } from "@activityplug/server";
import { type Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createPostgresAuthSessionStore } from "./index.js";
import { createPostgresOAuthClientSecretStore } from "./oauth.js";

describe("PostgreSQL OAuth client-secret server contract", () => {
  it("passes the factory directly to a server with durable sessions", () => {
    const pool = {} as Pool;
    const server = createActivityPlugServer({
      adapters: [],
      sessions: createPostgresAuthSessionStore(pool),
      oauthClientSecrets: createPostgresOAuthClientSecretStore(pool),
      originPolicy: { assertAllowed: async () => undefined },
    });

    expect(server.service.health()).toEqual({ ok: true, version: "v1" });
  });
});
