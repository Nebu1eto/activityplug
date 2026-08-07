// @vitest-environment jsdom

// oxlint-disable-next-line import/no-unassigned-import -- Installs shared DOM test helpers.
import "../test/setup.ts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { createProductApi } from "../api/client.js";
import { createBrowserApi, WebApiError } from "../api/http.js";
import { createSessionRecovery } from "./auth-recovery.js";
import { sessionOptions, webSessionKey, type AuthApi, type BrowserSession } from "./auth.js";
import { composerAtom } from "./composer.js";

const anonymousSession = { authenticated: false as const, csrfToken: "" };
const authenticatedSession: BrowserSession = {
  authenticated: true,
  csrfToken: "refreshed-csrf",
  adapter: "mastodon",
  origin: "https://social.example",
  strategy: "oauth",
  account: {
    ref: {
      id: "account-1",
      type: "account",
      adapter: "mastodon",
      origin: "https://social.example",
    },
    username: "alice",
    handle: "alice",
    displayName: "Alice",
    bot: false,
    locked: false,
    fields: [],
  },
  capabilities: { capabilities: [] },
};

describe("session recovery", () => {
  it("clears private data and drafts once before fetching an anonymous session", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore();
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const api = authApi();
    store.set(composerAtom, {
      content: "private draft",
      visibility: "followers",
      summary: "",
      sensitive: false,
      attachments: [
        {
          localId: "private-image",
          file: new File(["image"], "private.png", { type: "image/png" }),
          previewUrl: "blob:private-image",
          altText: "private image",
          status: "draft",
        },
      ],
    });
    queryClient.setQueryData(["browser", "posts", "timeline", "home"], { private: true });
    const recover = createSessionRecovery({ api, queryClient, store });

    await Promise.all([
      recover(new WebApiError("UNAUTHENTICATED", "Session expired.", 401)),
      recover(new WebApiError("HTTP_STATUS", "Session expired.", 401)),
    ]);

    expect(api.abortUnsafeRequests).toHaveBeenCalledTimes(1);
    expect(api.setCsrfToken).toHaveBeenCalledWith("");
    expect(api.session).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(["browser", "posts", "timeline", "home"])).toBeUndefined();
    expect(queryClient.getQueryData(webSessionKey)).toEqual(anonymousSession);
    expect(store.get(composerAtom)).toMatchObject({ content: "", attachments: [] });
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:private-image");
  });

  it("does not reset private state for a non-authentication transport error", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore();
    const api = authApi();
    queryClient.setQueryData(["browser", "posts", "timeline", "home"], { private: true });

    await createSessionRecovery({ api, queryClient, store })(
      new WebApiError("HTTP_STATUS", "Service unavailable.", 503),
    );

    expect(api.session).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["browser", "posts", "timeline", "home"])).toEqual({
      private: true,
    });
  });

  it("preserves private state when session refresh confirms authentication", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore();
    const api = authApi({ session: vi.fn(async () => authenticatedSession) });
    const privateTimeline = { private: true };
    queryClient.setQueryData(webSessionKey, {
      authenticated: true,
      csrfToken: "private-csrf",
    });
    queryClient.setQueryData(["browser", "posts", "timeline", "home"], privateTimeline);
    store.set(composerAtom, {
      content: "recoverable draft",
      visibility: "followers",
      summary: "",
      sensitive: false,
      attachments: [],
    });

    await createSessionRecovery({ api, queryClient, store })(
      new WebApiError("UNAUTHENTICATED", "Logout response was lost.", 401),
    );

    expect(api.abortUnsafeRequests).toHaveBeenCalledOnce();
    expect(api.setCsrfToken).toHaveBeenCalledWith("");
    expect(queryClient.getQueryData(webSessionKey)).toEqual(authenticatedSession);
    expect(queryClient.getQueryData(["browser", "posts", "timeline", "home"])).toEqual(
      privateTimeline,
    );
    expect(store.get(composerAtom)).toMatchObject({ content: "recoverable draft" });
  });

  it("aborts unsafe requests before waiting for query cancellation", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore();
    const api = authApi();
    const cancellation = Promise.withResolvers<void>();
    vi.spyOn(queryClient, "cancelQueries").mockReturnValue(cancellation.promise);

    const recovery = createSessionRecovery({ api, queryClient, store })(
      new WebApiError("UNAUTHENTICATED", "Session expired.", 401),
    );

    expect(api.abortUnsafeRequests).toHaveBeenCalledTimes(1);
    expect(api.setCsrfToken).toHaveBeenCalledWith("");
    expect(api.session).not.toHaveBeenCalled();

    cancellation.resolve();
    await recovery;

    expect(api.setCsrfToken).toHaveBeenCalledWith("");
    expect(api.session).toHaveBeenCalledTimes(1);
  });

  it("forces a post-logout refresh past an overlapping recovery generation", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore();
    const beforeLogout = Promise.withResolvers<BrowserSession>();
    const afterLogout = Promise.withResolvers<BrowserSession>();
    const session = vi
      .fn<AuthApi["session"]>()
      .mockImplementationOnce(() => beforeLogout.promise)
      .mockImplementationOnce(() => afterLogout.promise);
    const api = authApi({ session });
    const privateTimeline = { private: true };
    queryClient.setQueryData(webSessionKey, authenticatedSession);
    queryClient.setQueryData(["browser", "posts", "timeline", "home"], privateTimeline);
    const recover = createSessionRecovery({ api, queryClient, store });
    const error = new WebApiError("UNAUTHENTICATED", "Session expired.", 401);

    const overlapping = recover(error);
    await vi.waitFor(() => expect(session).toHaveBeenCalledOnce());

    const postLogout = recover(error, { forceRefresh: true });
    await vi.waitFor(() => expect(session).toHaveBeenCalledTimes(2));
    afterLogout.resolve(anonymousSession);
    await postLogout;
    beforeLogout.resolve(authenticatedSession);
    await overlapping;

    expect(queryClient.getQueryData(webSessionKey)).toEqual(anonymousSession);
    expect(queryClient.getQueryData(["browser", "posts", "timeline", "home"])).toBeUndefined();
  });

  it("aborts a pending unsafe request before resetting private state and still fetches session", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore();
    const events: string[] = [];
    let unsafeSignal: AbortSignal | undefined;
    let sessionSignal: AbortSignal | undefined;
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.method === "POST") {
        unsafeSignal = request.signal;
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              events.push("unsafe-aborted");
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        });
      }
      sessionSignal = request.signal;
      events.push("session-fetched");
      return Promise.resolve(Response.json(anonymousSession));
    }) as typeof globalThis.fetch;
    const api = createProductApi(createBrowserApi(fetch));
    const originalSetCsrfToken = api.setCsrfToken.bind(api);
    vi.spyOn(api, "setCsrfToken").mockImplementation((value) => {
      if (value === "") events.push("csrf-cleared");
      originalSetCsrfToken(value);
    });
    api.setCsrfToken("private-csrf");
    queryClient.setQueryData(["browser", "posts", "timeline", "home"], { private: true });
    store.set(composerAtom, {
      content: "private draft",
      visibility: "followers",
      summary: "",
      sensitive: false,
      attachments: [],
    });
    const create = api.createPost({
      content: "private",
      visibility: "public",
      sensitive: false,
      mediaIds: [],
    });
    const expectCreateAbort = expect(create).rejects.toMatchObject({ name: "AbortError" });

    await createSessionRecovery({ api, queryClient, store })(
      new WebApiError("UNAUTHENTICATED", "Session expired.", 401),
    );

    expect(events).toEqual(["unsafe-aborted", "csrf-cleared", "session-fetched"]);
    expect(unsafeSignal?.aborted).toBe(true);
    expect(sessionSignal?.aborted).toBe(false);
    await expectCreateAbort;
    expect(queryClient.getQueryData(["browser", "posts", "timeline", "home"])).toBeUndefined();
    expect(queryClient.getQueryData(webSessionKey)).toEqual(anonymousSession);
    expect(store.get(composerAtom)).toMatchObject({ content: "", attachments: [] });
  });

  it("does not cache a synthetic anonymous success when the replacement fetch fails", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore();
    const api = authApi({
      session: vi.fn(async () => {
        throw new Error("Session endpoint unavailable.");
      }),
    });
    queryClient.setQueryData(webSessionKey, {
      authenticated: true,
      csrfToken: "private-csrf",
    });
    store.set(composerAtom, {
      content: "private draft",
      visibility: "followers",
      summary: "",
      sensitive: false,
      attachments: [],
    });

    const recover = createSessionRecovery({ api, queryClient, store });
    const error = new WebApiError("UNAUTHENTICATED", "Session expired.", 401);
    await expect(recover(error)).rejects.toThrow("Session endpoint unavailable.");
    await expect(recover(error)).resolves.toBeUndefined();

    expect(queryClient.getQueryData(webSessionKey)).toBeUndefined();
    expect(api.abortUnsafeRequests).toHaveBeenCalledOnce();
    expect(api.session).toHaveBeenCalledOnce();
    expect(api.setCsrfToken).toHaveBeenCalledWith("");
    expect(store.get(composerAtom)).toMatchObject({ content: "", attachments: [] });
  });

  it("replaces an actively observed private session with the refresh error", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore();
    const session = vi
      .fn<AuthApi["session"]>()
      .mockRejectedValueOnce(new Error("Session endpoint unavailable."));
    const api = authApi({ session });
    queryClient.setQueryData(webSessionKey, {
      authenticated: true,
      csrfToken: "private-csrf",
    });
    const observer = new QueryObserver(queryClient, sessionOptions(api));
    const unsubscribe = observer.subscribe(() => undefined);

    await expect(
      createSessionRecovery({ api, queryClient, store })(
        new WebApiError("UNAUTHENTICATED", "Session expired.", 401),
      ),
    ).rejects.toThrow("Session endpoint unavailable.");

    expect(session).toHaveBeenCalledOnce();
    expect(observer.getCurrentResult()).toMatchObject({
      data: undefined,
      error: new Error("Session endpoint unavailable."),
      status: "error",
    });
    unsubscribe();
  });
});

function authApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    session: vi.fn(async () => anonymousSession),
    detectServer: vi.fn(),
    startAuth: vi.fn(),
    completeAuth: vi.fn(),
    logout: vi.fn(),
    setCsrfToken: vi.fn(),
    abortUnsafeRequests: vi.fn(),
    ...overrides,
  };
}
