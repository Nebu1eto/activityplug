import { createEntityRef } from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  clearPendingHackersPubLogin,
  clearStoredAuthState,
  createHackersPubVerifyUrl,
  resolveHackersPubCallback,
  storePendingHackersPubLogin,
} from "./callback-state.js";
import {
  canUseHackersPubPasskey,
  completeHackersPubEmailLogin,
  detectInstance,
  exchangeAuth,
  importToken,
  startAuth,
  startHackersPubEmailLogin,
} from "./index.js";
import { removeStorageKeyPrefix } from "./storage.js";
import { createClientUuid } from "./uuid.js";

describe("sample web client auth flow", () => {
  const mastodonFixture = accountMappingFixtures.mastodon;
  const misskeyFixture = accountMappingFixtures.misskey;
  const hackersPubFixture = accountMappingFixtures.hackerspub;

  it("keeps the OAuth client alive so the exchanged session can verify the viewer", async () => {
    const requests: Request[] = [];
    const fetch = mockFetch(async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/v1/apps") {
        return jsonResponse({
          id: "app-1",
          client_id: "client-1",
          client_secret: "secret-1",
          redirect_uri: "https://client.example/callback",
        });
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        expect(await request.text()).toBe(
          "grant_type=authorization_code&client_id=client-1&client_secret=secret-1&code=code-1&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&code_verifier=verifier-1",
        );
        return jsonResponse({
          access_token: "access-token-1",
          token_type: "Bearer",
          scope: "read",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/accounts/verify_credentials") {
        expect(request.headers.get("Authorization")).toBe("Bearer access-token-1");
        return jsonResponse(mastodonFixture.account);
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    });

    const startedAuth = await startAuth({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      clientName: "ActivityPlug Test",
      redirectUri: "https://client.example/callback",
      scopes: ["read"],
      state: "state-1",
      codeVerifier: "verifier-1",
      codeChallenge: "challenge-1",
      fetch,
    });
    expect(startedAuth.redirectUri).toBe("https://client.example/callback");
    const exchangedAuth = await exchangeAuth({
      startedAuth,
      callback: "https://client.example/callback?code=code-1&state=state-1",
      redirectUri: "https://client.example/callback",
    });
    const viewer = await exchangedAuth.verifyViewer();

    expect(exchangedAuth.session).toMatchObject({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      scopes: ["read"],
    });
    expect("tokenSet" in exchangedAuth.session).toBe(false);
    expect(viewer).toMatchObject({
      username: "alice",
      displayName: "Alice",
    });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /api/v1/apps", "POST /oauth/token", "GET /api/v1/accounts/verify_credentials"],
    );
  });

  it("can verify a Misskey viewer and look up an account profile", async () => {
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        return jsonResponse({
          access_token: "misskey-token-1",
          token_type: "Bearer",
          scope: "read:account",
        });
      }
      if (request.method === "POST" && url.pathname === "/api/i") {
        expect(request.headers.get("Authorization")).toBe("Bearer misskey-token-1");
        return jsonResponse({ ...misskeyFixture.account, username: "viewer", name: "Viewer" });
      }
      if (request.method === "POST" && url.pathname === "/api/users/show") {
        expect(await request.json()).toEqual({ username: "alice" });
        return jsonResponse(misskeyFixture.account);
      }
      if (request.method === "POST" && url.pathname === "/api/users/search-by-username-and-host") {
        expect(request.headers.get("Authorization")).toBe(null);
        return jsonResponse([misskeyFixture.account]);
      }
      if (request.method === "POST" && url.pathname === "/api/notes/search") {
        expect(request.headers.get("Authorization")).toBe("Bearer misskey-token-1");
        return jsonResponse([misskeyFixture.post]);
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    });

    const startedAuth = await startAuth({
      adapter: "misskey",
      origin: "https://misskey.example",
      clientName: "ActivityPlug Test",
      redirectUri: "https://client.example/callback",
      scopes: ["read:account"],
      state: "state-1",
      website: "https://client.example",
      codeVerifier: "verifier-1",
      codeChallenge: "challenge-1",
      fetch,
    });
    const exchangedAuth = await exchangeAuth({
      startedAuth,
      callback: "https://client.example/callback?code=code-1&state=state-1",
      redirectUri: "https://client.example/callback",
    });

    await expect(exchangedAuth.verifyViewer()).resolves.toMatchObject({
      username: "viewer",
      displayName: "Viewer",
    });
    await expect(exchangedAuth.lookupAccountProfile("alice")).resolves.toMatchObject({
      username: "alice",
      displayName: "Alice",
    });
    await expect(exchangedAuth.search("ActivityPlug", "posts")).resolves.toMatchObject({
      posts: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "note9" }) })],
    });
  });

  it("can verify a HackersPub viewer from an injected token", async () => {
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/graphql") {
        expect(request.headers.get("Authorization")).toBe("Bearer hackerspub-token-1");
        const body = (await request.json()) as {
          readonly query?: string;
          readonly variables?: Record<string, unknown>;
        };
        if (body.query?.includes("viewer") === true) {
          return jsonResponse({
            data: {
              viewer: {
                uuid: hackersPubFixture.account.uuid,
                username: hackersPubFixture.account.username,
                name: hackersPubFixture.account.rawName,
                handle: hackersPubFixture.account.handle,
                bio: hackersPubFixture.account.bio,
                avatarUrl: hackersPubFixture.account.avatarUrl,
                created: hackersPubFixture.account.created,
                actor: {
                  id: hackersPubFixture.account.id,
                  uuid: hackersPubFixture.account.uuid,
                  iri: hackersPubFixture.account.iri,
                  url: hackersPubFixture.account.url,
                },
              },
            },
          });
        }
        if (body.query?.includes("actorByUuid") === true) {
          expect(body.variables).toMatchObject({ id: hackersPubFixture.account.uuid });
          return jsonResponse({
            data: {
              actorByUuid: {
                posts: {
                  edges: [{ node: hackersPubFixture.post }],
                  pageInfo: {
                    hasNextPage: false,
                    hasPreviousPage: false,
                  },
                },
              },
            },
          });
        }
      }
      return jsonResponse({ errors: [{ message: "unexpected request" }] }, 404);
    });

    const web = await importToken({
      adapter: "hackerspub",
      origin: "https://hackers.pub",
      accessToken: "hackerspub-token-1",
      fetch,
    });

    const viewer = await web.verifyViewer();

    expect(viewer).toMatchObject({
      username: "alice",
      displayName: "Alice",
      acct: "alice@hackers.pub",
    });
    await expect(web.listAccountPosts(viewer.ref.id)).resolves.toMatchObject({
      nodes: [
        expect.objectContaining({
          ref: expect.objectContaining({ rawId: hackersPubFixture.post.uuid }),
        }),
      ],
    });
  });

  it("starts and completes a HackersPub email challenge login", async () => {
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/graphql") {
        const body = (await request.json()) as {
          readonly query?: string;
          readonly variables?: Record<string, unknown>;
        };
        if (body.query?.includes("loginByEmail") === true) {
          expect(body.variables).toMatchObject({
            email: "alice@hackers.pub",
            locale: "en",
            verifyUrl:
              "https://client.example/callback?hackerspubToken={token}&hackerspubCode={code}",
          });
          return jsonResponse({
            data: {
              loginByEmail: {
                __typename: "LoginChallenge",
                token: "00000000-0000-4000-8000-000000000010",
                created: "2026-05-01T00:00:00.000Z",
              },
            },
          });
        }
        if (body.query?.includes("completeLoginChallenge") === true) {
          expect(body.variables).toEqual({
            token: "00000000-0000-4000-8000-000000000010",
            code: "ABC123",
          });
          return jsonResponse({
            data: {
              completeLoginChallenge: {
                id: "00000000-0000-4000-8000-000000000011",
              },
            },
          });
        }
        if (body.query?.includes("viewer") === true) {
          expect(request.headers.get("Authorization")).toBe(
            "Bearer 00000000-0000-4000-8000-000000000011",
          );
          return jsonResponse({
            data: {
              viewer: {
                uuid: hackersPubFixture.account.uuid,
                username: hackersPubFixture.account.username,
                name: hackersPubFixture.account.rawName,
                handle: hackersPubFixture.account.handle,
                bio: hackersPubFixture.account.bio,
                avatarUrl: hackersPubFixture.account.avatarUrl,
                created: hackersPubFixture.account.created,
                actor: {
                  id: hackersPubFixture.account.id,
                  uuid: hackersPubFixture.account.uuid,
                  iri: hackersPubFixture.account.iri,
                  url: hackersPubFixture.account.url,
                },
              },
            },
          });
        }
      }
      return jsonResponse({ errors: [{ message: "unexpected request" }] }, 404);
    });

    await expect(
      startHackersPubEmailLogin({
        origin: "https://hackers.pub",
        identifier: "alice@hackers.pub",
        verifyUrl: "https://client.example/callback?hackerspubToken={token}&hackerspubCode={code}",
        fetch,
      }),
    ).resolves.toEqual({
      token: "00000000-0000-4000-8000-000000000010",
      created: "2026-05-01T00:00:00.000Z",
    });
    const web = await completeHackersPubEmailLogin({
      origin: "https://hackers.pub",
      token: "00000000-0000-4000-8000-000000000010",
      code: "ABC123",
      fetch,
    });

    await expect(web.verifyViewer()).resolves.toMatchObject({
      username: "alice",
      displayName: "Alice",
    });
  });

  it("normalizes HackersPub login GraphQL requests to the instance root", async () => {
    const requestUrls: string[] = [];
    const fetch = mockFetch(async (request) => {
      requestUrls.push(request.url);
      return jsonResponse({
        data: {
          loginByUsername: {
            __typename: "LoginChallenge",
            token: "00000000-0000-4000-8000-000000000012",
            created: "2026-05-01T00:00:00.000Z",
          },
        },
      });
    });

    await startHackersPubEmailLogin({
      origin: "https://hackers.pub/path/",
      identifier: "alice",
      verifyUrl: "https://client.example/callback?hackerspubToken={token}&hackerspubCode={code}",
      fetch,
    });

    expect(requestUrls).toEqual(["https://hackers.pub/graphql"]);
  });

  it("gates HackersPub passkey login to exact browser origins", () => {
    expect(canUseHackersPubPasskey("https://hackers.pub", "https://hackers.pub")).toBe(true);
    expect(canUseHackersPubPasskey("https://hackers.pub", "https://login.hackers.pub")).toBe(false);
    expect(canUseHackersPubPasskey("https://hackers.pub", "http://hackers.pub")).toBe(false);
    expect(canUseHackersPubPasskey("https://hackers.pub", "https://hackers.pub:8443")).toBe(false);
    expect(canUseHackersPubPasskey("https://hackers.pub", "http://127.0.0.1:5177")).toBe(false);
  });

  it("creates UUIDs without crypto.randomUUID", () => {
    let next = 0;
    const crypto = {
      getRandomValues: <T extends ArrayBufferView>(array: T): T => {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = next;
          next = (next + 1) % 256;
        }
        return array;
      },
    } as Crypto;

    expect(createClientUuid(crypto)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("clears state-specific browser storage keys by prefix", () => {
    const storage = new MemoryStorage();
    storage.setItem("activityplug.web-client.startedAuth", "latest");
    storage.setItem("activityplug.web-client.startedAuth.state-1", "old");
    storage.setItem("activityplug.web-client.hackerspubLogin.state-1", "challenge");
    storage.setItem("other", "kept");

    removeStorageKeyPrefix(storage, "activityplug.web-client.startedAuth.");

    expect(storage.getItem("activityplug.web-client.startedAuth")).toBe("latest");
    expect(storage.getItem("activityplug.web-client.startedAuth.state-1")).toBe(null);
    expect(storage.getItem("activityplug.web-client.hackerspubLogin.state-1")).toBe("challenge");
    expect(storage.getItem("other")).toBe("kept");
  });

  it("clears OAuth and HackersPub callback state prefixes", () => {
    const storage = new MemoryStorage();
    storage.setItem("activityplug.web-client.startedAuth", "latest");
    storage.setItem("activityplug.web-client.startedAuth.state-1", "old");
    storage.setItem("activityplug.web-client.hackerspubLogin.state-1", "challenge");
    storage.setItem("other", "kept");

    clearStoredAuthState(storage);
    clearPendingHackersPubLogin(storage);

    expect(storage.getItem("activityplug.web-client.startedAuth")).toBe(null);
    expect(storage.getItem("activityplug.web-client.startedAuth.state-1")).toBe(null);
    expect(storage.getItem("activityplug.web-client.hackerspubLogin.state-1")).toBe(null);
    expect(storage.getItem("other")).toBe("kept");
  });

  it("binds HackersPub email callbacks to locally stored state and token", () => {
    const storage = new MemoryStorage();
    storePendingHackersPubLogin(storage, {
      origin: "https://hackers.pub",
      token: "token-1",
      state: "state-1",
    });

    expect(
      createHackersPubVerifyUrl({
        callbackUrl: "https://client.example/callback",
        origin: "https://hackers.pub",
        state: "state-1",
      }),
    ).toBe(
      "https://client.example/callback?hackerspubOrigin=https%3A%2F%2Fhackers.pub&hackerspubState=state-1&hackerspubToken={token}&hackerspubCode={code}",
    );
    expect(
      resolveHackersPubCallback(
        storage,
        new URL(
          "https://client.example/callback?hackerspubState=state-1&hackerspubToken=token-1&hackerspubCode=ABC123",
        ),
      ),
    ).toEqual({
      kind: "matched",
      code: "ABC123",
      pendingLogin: {
        origin: "https://hackers.pub",
        token: "token-1",
        state: "state-1",
      },
    });
    expect(
      resolveHackersPubCallback(
        storage,
        new URL(
          "https://client.example/callback?hackerspubState=state-1&hackerspubToken=wrong&hackerspubCode=ABC123",
        ),
      ),
    ).toEqual({
      kind: "invalid",
      message: "No matching HackersPub login challenge was found for this callback.",
      pendingLogin: {
        origin: "https://hackers.pub",
        token: "token-1",
        state: "state-1",
      },
    });
    expect(
      resolveHackersPubCallback(
        storage,
        new URL("https://client.example/callback?hackerspubToken=token-1&hackerspubCode=ABC123"),
      ),
    ).toEqual({
      kind: "invalid",
      message: "No matching HackersPub login challenge was found for this callback.",
    });
  });

  it("renders timelines, composes posts, and runs social actions without internal APIs", async () => {
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/v1/apps") {
        return jsonResponse({
          id: "app-1",
          client_id: "client-1",
          client_secret: "secret-1",
          redirect_uri: "https://client.example/callback",
        });
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        return jsonResponse({
          access_token: "access-token-1",
          token_type: "Bearer",
          scope: "read write follow",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/accounts/verify_credentials") {
        return jsonResponse(mastodonFixture.account);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/timelines/home") {
        expect(request.headers.get("Authorization")).toBe("Bearer access-token-1");
        return jsonResponse([mastodonFixture.post]);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/v1/timelines/public" &&
        url.searchParams.get("local") === "true"
      ) {
        return jsonResponse([{ ...mastodonFixture.post, id: "local-900" }]);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/timelines/public") {
        return jsonResponse([mastodonFixture.post]);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/timelines/tag/activityplug") {
        return jsonResponse([mastodonFixture.post]);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/accounts/109/statuses") {
        return jsonResponse([mastodonFixture.post]);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/statuses") {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body["status"]).toEqual(expect.any(String));
        expect(body["visibility"]).toEqual(expect.any(String));
        return jsonResponse({ ...mastodonFixture.post, id: "created-1" });
      }
      if (request.method === "DELETE" && url.pathname === "/api/v1/statuses/created-1") {
        return jsonResponse({ id: "created-1" });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/statuses/900/favourite") {
        return jsonResponse(mastodonFixture.post);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/statuses/900/bookmark") {
        return jsonResponse(mastodonFixture.post);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/statuses/900/reblog") {
        return jsonResponse(mastodonFixture.post);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/accounts/109/follow") {
        return jsonResponse({
          id: "109",
          following: true,
          followed_by: false,
          requested: false,
          blocking: false,
          muting: false,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/accounts/109/unfollow") {
        return jsonResponse({
          id: "109",
          following: false,
          followed_by: false,
          requested: false,
          blocking: false,
          muting: false,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/accounts/109/block") {
        return jsonResponse({
          id: "109",
          following: false,
          followed_by: false,
          requested: false,
          blocking: true,
          muting: false,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/accounts/109/mute") {
        return jsonResponse({
          id: "109",
          following: false,
          followed_by: false,
          requested: false,
          blocking: false,
          muting: true,
        });
      }
      return jsonResponse({ error: "unexpected request", path: url.pathname }, 404);
    });
    const startedAuth = await startAuth({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      clientName: "ActivityPlug Test",
      redirectUri: "https://client.example/callback",
      scopes: ["read", "write", "follow"],
      state: "state-1",
      codeVerifier: "verifier-1",
      codeChallenge: "challenge-1",
      fetch,
    });
    const web = await exchangeAuth({
      startedAuth,
      callback: "https://client.example/callback?code=code-1&state=state-1",
      redirectUri: "https://client.example/callback",
    });
    const accountId = createEntityRef({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      type: "account",
      id: "109",
    }).id;
    const postId = createEntityRef({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      type: "post",
      id: "900",
    }).id;

    await expect(web.renderHomeTimeline()).resolves.toMatchObject({
      nodes: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "900" }) })],
    });
    await expect(web.renderPublicTimeline()).resolves.toMatchObject({
      nodes: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "900" }) })],
    });
    await expect(web.renderLocalTimeline()).resolves.toMatchObject({
      nodes: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "local-900" }) })],
    });
    await expect(web.renderHashtagTimeline("activityplug")).resolves.toMatchObject({
      nodes: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "900" }) })],
    });
    await expect(web.listAccountPosts(accountId)).resolves.toMatchObject({
      nodes: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "900" }) })],
    });
    await expect(web.compose("Hello from ActivityPlug", "unlisted")).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "created-1" }),
    });
    await expect(web.reply(postId, "Reply")).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "created-1" }),
    });
    await expect(web.favourite(postId)).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "900" }),
    });
    await expect(web.bookmark(postId)).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "900" }),
    });
    await expect(web.boost(postId)).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "900" }),
    });
    await expect(
      Promise.resolve().then(() => web.react(postId, "\u{1f44d}")),
    ).rejects.toHaveProperty("code", "UNSUPPORTED_OPERATION");
    await expect(web.follow(accountId)).resolves.toMatchObject({ following: true });
    await expect(web.unfollow(accountId)).resolves.toMatchObject({ following: false });
    await expect(web.block(accountId)).resolves.toMatchObject({ blocking: true });
    await expect(web.mute(accountId)).resolves.toMatchObject({ muting: true });
    await expect(
      web.deletePost(
        createEntityRef({
          adapter: "mastodon",
          origin: "https://mastodon.example",
          type: "post",
          id: "created-1",
        }).id,
      ),
    ).resolves.toBeUndefined();
  });

  it("detects an instance through the public library client", async () => {
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/nodeinfo") {
        return jsonResponse({
          links: [
            {
              rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
              href: "https://mastodon.example/nodeinfo/2.1",
            },
          ],
        });
      }
      if (url.pathname === "/nodeinfo/2.1") {
        return jsonResponse({ software: { name: "mastodon", version: "4.3.0" } });
      }
      if (url.pathname === "/api/v2/instance") {
        return jsonResponse({
          domain: "mastodon.example",
          title: "Mastodon Example",
          description: "Example",
          languages: ["en"],
          registrations: { enabled: false },
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    });

    await expect(
      detectInstance({ adapter: "mastodon", origin: "https://mastodon.example", fetch }),
    ).resolves.toMatchObject({
      software: { name: "mastodon", version: "4.3.0" },
      title: "Mastodon Example",
    });
  });
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  public get length(): number {
    return this.#items.size;
  }

  public clear(): void {
    this.#items.clear();
  }

  public getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  public key(index: number): string | null {
    return Array.from(this.#items.keys())[index] ?? null;
  }

  public removeItem(key: string): void {
    this.#items.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}
