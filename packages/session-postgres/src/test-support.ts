import { type StoredAuthSession } from "@activityplug/core";

export function createSession(
  id: string,
  overrides: Partial<StoredAuthSession> = {},
): StoredAuthSession {
  return {
    id,
    adapter: "fake",
    origin: "https://social.example",
    scopes: [],
    capabilities: {},
    tokenSet: {
      accessToken: `token-${id}`,
      tokenType: "Bearer",
    },
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
    ...overrides,
  };
}
