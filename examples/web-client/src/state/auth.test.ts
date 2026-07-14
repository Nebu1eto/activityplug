import { QueryClient } from "@tanstack/react-query";
import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { authTransitionAtom, sessionOptions, webSessionKey, type BrowserSession } from "./auth.js";

const authenticatedSession: BrowserSession = {
  authenticated: true,
  csrfToken: "csrf-safe",
  adapter: "pleroma",
  origin: "https://social.example",
  strategy: "oauth",
  account: {
    ref: { id: "account-1", type: "account", adapter: "pleroma", origin: "https://social.example" },
    username: "alice",
    handle: "alice",
    displayName: "Alice",
    bot: false,
    locked: false,
    fields: [],
  },
  capabilities: { capabilities: [] },
};

describe("authentication state", () => {
  it("keeps the browser session in Query cache and only transitions in Jotai", async () => {
    const session = vi.fn(async () => authenticatedSession);
    const queryClient = new QueryClient();
    const store = createStore();

    const result = await queryClient.fetchQuery(sessionOptions({ session }));

    expect(result).toBe(authenticatedSession);
    expect(queryClient.getQueryData(webSessionKey)).toBe(authenticatedSession);
    expect(store.get(authTransitionAtom)).toEqual({ status: "idle" });
    expect(JSON.stringify(store.get(authTransitionAtom))).not.toMatch(
      /csrf|authenticated|account|capabilities|origin|adapter/u,
    );
  });

  it("treats the reload session as permanently fresh until explicitly replaced", () => {
    const options = sessionOptions({ session: vi.fn() });

    expect(options.queryKey).toEqual(webSessionKey);
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
  });
});
