import {
  createActivityPlugClient as createActivityPlugClientWithAuthority,
  createRemoteAuthority,
  MAX_STREAMING_QUEUED_BYTES,
  MAX_STREAMING_QUEUED_EVENTS,
  type ActivityPlugClientOptions,
} from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMastodonBaseAdapter } from "./index.js";

function createActivityPlugClient(options: ActivityPlugClientOptions) {
  const { fetch = globalThis.fetch, remoteAuthority, ...clientOptions } = options;
  const transport: typeof globalThis.fetch = (input, init) => fetch(input, init);
  return createActivityPlugClientWithAuthority({
    ...clientOptions,
    remoteAuthority: remoteAuthority ?? createRemoteAuthority({ transport }),
  });
}

describe("Mastodon-compatible streaming", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", instanceDiscoveryFetch({}));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed when no WebSocket factory is injected", async () => {
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
      }),
      origin: "https://mastodon.example",
    });
    await expect(client.streams.timeline({ type: "public" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "streaming.timeline", operation: "stream.timeline" },
    });
  });

  it("treats a non-function WebSocket factory as unsupported", async () => {
    const adapter = createMastodonBaseAdapter({
      id: "mastodon",
      displayName: "Mastodon",
      supportedSoftware: ["mastodon"],
      webSocket: null as unknown as undefined,
    });
    const client = createActivityPlugClient({
      adapter,
      origin: "https://mastodon.example",
    });

    expect(adapter.metadata.staticCapabilities["streaming.timeline"]).toMatchObject({
      status: "unsupported",
    });
    await expect(client.streams.timeline({ type: "public" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "streaming.timeline", operation: "stream.timeline" },
    });
  });

  it("defers instance discovery until stream consumption", async () => {
    const sockets: FakeWebSocket[] = [];
    const fetch = instanceDiscoveryFetch({});
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
      fetch,
    });

    const stream = await client.streams.timeline({ type: "public" });
    expect(fetch).not.toHaveBeenCalled();

    const pending = stream[Symbol.asyncIterator]().next();
    await waitForSocket(sockets);
    expect(fetch).toHaveBeenCalledTimes(3);
    sockets[0]?.remoteClose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it("settles an aborted consumer while shared discovery is still pending", async () => {
    const sockets: FakeWebSocket[] = [];
    let rejectDiscovery!: (error: Error) => void;
    let resolveFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      resolveFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        rejectDiscovery = reject;
      });
    });
    const controller = new AbortController();
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
      fetch,
    });

    const stream = await client.streams.timeline({ type: "public", signal: controller.signal });
    const next = stream[Symbol.asyncIterator]().next();
    await fetchStarted;
    controller.abort();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(sockets).toEqual([]);

    rejectDiscovery(new Error("late shared discovery failure"));
    await Promise.resolve();
  });

  it("does not start discovery for an already-aborted consumer", async () => {
    const fetch = instanceDiscoveryFetch({});
    const webSocket = vi.fn(() => new FakeWebSocket("unused") as unknown as WebSocket);
    const controller = new AbortController();
    controller.abort();
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket,
      }),
      origin: "https://mastodon.example",
      fetch,
    });

    const stream = await client.streams.timeline({ type: "public", signal: controller.signal });

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(webSocket).not.toHaveBeenCalled();
  });

  it("isolates lazy discovery cache entries by canonical origin", async () => {
    const sockets: FakeWebSocket[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/.well-known/nodeinfo") {
        return Response.json({
          links: [
            {
              rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
              href: `${url.origin}/nodeinfo/2.1`,
            },
          ],
        });
      }
      if (url.pathname === "/nodeinfo/2.1") {
        return Response.json({ software: { name: "mastodon", version: "4.1.0+glitch" } });
      }
      if (url.pathname === "/api/v2/instance") {
        return Response.json({
          domain: url.host,
          version: "4.1.0+glitch",
          configuration: {
            urls: { streaming: `https://stream.${url.hostname}/api/v1/streaming` },
          },
        });
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });
    const adapter = createMastodonBaseAdapter({
      id: "mastodon",
      displayName: "Mastodon",
      supportedSoftware: ["mastodon"],
      webSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const alpha = createActivityPlugClient({
      adapter,
      origin: "https://alpha.example",
      fetch,
    });
    const beta = createActivityPlugClient({ adapter, origin: "https://beta.example", fetch });

    const alphaStream = await alpha.streams.timeline({ type: "public" });
    const alphaPending = alphaStream[Symbol.asyncIterator]().next();
    await waitForSocket(sockets);
    expect(sockets[0]?.url).toBe("wss://stream.alpha.example/api/v1/streaming/?stream=public");
    sockets[0]?.remoteClose();
    await alphaPending;

    const betaStream = await beta.streams.timeline({ type: "public" });
    const betaPending = betaStream[Symbol.asyncIterator]().next();
    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toBe("wss://stream.beta.example/api/v1/streaming/?stream=public");
    sockets[1]?.remoteClose();
    await betaPending;

    const alphaAgain = await alpha.streams.timeline({ type: "public" });
    const alphaAgainPending = alphaAgain[Symbol.asyncIterator]().next();
    await waitForSocketCount(sockets, 3);
    sockets[2]?.remoteClose();
    await alphaAgainPending;

    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("enforces Mastodon runtime streaming versions and session requirements", async () => {
    const legacySockets: FakeWebSocket[] = [];
    const legacy = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          legacySockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
      fetch: instanceDiscoveryFetch({}, { version: "3.2.9" }),
    });
    const legacyStream = await legacy.streams.timeline({ type: "public" });
    await expect(legacyStream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "stream.timeline", capability: "streaming.timeline" },
    });
    expect(legacySockets).toHaveLength(0);

    const currentSockets: FakeWebSocket[] = [];
    const current = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          currentSockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
      fetch: instanceDiscoveryFetch({}, { version: "4.2.0+glitch" }),
    });
    const anonymous = await current.streams.timeline({ type: "public" });
    await expect(anonymous[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      context: { operation: "stream.timeline", capability: "streaming.timeline" },
    });
    const session = await current.auth.token.importToken({ accessToken: "viewer-token" });
    const authenticated = await current.streams.timeline({ type: "public", session });
    const pending = authenticated[Symbol.asyncIterator]().next();
    await waitForSocket(currentSockets);
    currentSockets[0]?.remoteClose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it("uses the modern advertised streaming host, base path, query, and operation", async () => {
    const sockets: FakeWebSocket[] = [];
    const factoryCalls: unknown[][] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (...args) => {
          factoryCalls.push(args);
          const socket = new FakeWebSocket(args[0]);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
      fetch: instanceDiscoveryFetch({
        configuration: {
          urls: {
            streaming: "https://mastodon.example/edge/base?route=blue",
          },
        },
      }),
    });
    const session = await client.auth.token.importToken({ accessToken: "viewer-token" });
    const stream = await client.streams.notifications({ session });
    const pending = stream[Symbol.asyncIterator]().next();
    await waitForSocket(sockets);

    expect(sockets[0]?.url).toBe(
      "wss://mastodon.example/edge/base/api/v1/streaming/?route=blue&stream=user%3Anotification",
    );
    expect(factoryCalls[0]?.[3]).toEqual({
      operation: "stream.notifications",
      authorization: "Bearer viewer-token",
    });
    sockets[0]?.remoteClose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it.each([
    [
      "URL user information",
      "https://viewer:secret@mastodon.example/socket",
      "UNSUPPORTED_OPERATION",
    ],
    ["access_token", "https://mastodon.example/socket?access_token=secret", "ORIGIN_NOT_ALLOWED"],
    ["token", "https://mastodon.example/socket?token=secret", "ORIGIN_NOT_ALLOWED"],
    ["api_key", "https://mastodon.example/socket?api_key=secret", "ORIGIN_NOT_ALLOWED"],
    ["ticket", "https://mastodon.example/socket?ticket=secret", "ORIGIN_NOT_ALLOWED"],
    ["i", "https://mastodon.example/socket?i=secret", "ORIGIN_NOT_ALLOWED"],
    ["code", "https://mastodon.example/socket?code=secret", "ORIGIN_NOT_ALLOWED"],
    ["state", "https://mastodon.example/socket?state=secret", "ORIGIN_NOT_ALLOWED"],
  ])("rejects advertised streaming credentials in %s", async (_label, endpoint, code) => {
    const webSocket = vi.fn(() => new FakeWebSocket("unused") as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket,
      }),
      origin: "https://mastodon.example",
      fetch: instanceDiscoveryFetch({ configuration: { urls: { streaming: endpoint } } }),
    });

    const stream = await client.streams.timeline({ type: "public" });
    const error = await stream[Symbol.asyncIterator]()
      .next()
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code,
      context: { operation: "stream.timeline", origin: "https://mastodon.example" },
    });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(webSocket).not.toHaveBeenCalled();
  });

  it("applies same-origin WebSocket credential representation policy", async () => {
    const fetch = instanceDiscoveryFetch({});
    const transport: typeof globalThis.fetch = (input, init) => fetch(input, init);
    const webSocket = vi.fn(() => new FakeWebSocket("unused") as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket,
      }),
      origin: "https://mastodon.example",
      remoteAuthority: createRemoteAuthority({
        transport,
        sameOriginRepresentations: [],
      }),
    });
    const session = await client.auth.token.importToken({ accessToken: "viewer-secret" });
    const stream = await client.streams.notifications({ session });

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "stream.notifications" },
    });
    expect(webSocket).not.toHaveBeenCalled();
  });

  it("applies same-origin WebSocket subprotocol policy", async () => {
    const fetch = instanceDiscoveryFetch(
      {},
      { origin: "https://pleroma.example", softwareName: "pleroma", version: "2.7.1" },
    );
    const transport: typeof globalThis.fetch = (input, init) => fetch(input, init);
    const webSocket = vi.fn(() => new FakeWebSocket("unused") as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "pleroma",
        displayName: "Pleroma",
        supportedSoftware: ["pleroma"],
        streamingAuthentication: "websocket-subprotocol",
        webSocket,
      }),
      origin: "https://pleroma.example",
      remoteAuthority: createRemoteAuthority({
        transport,
        sameOriginRepresentations: ["authorization-header"],
      }),
    });
    const session = await client.auth.token.importToken({ accessToken: "viewer-secret" });
    const stream = await client.streams.notifications({ session });

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "stream.notifications" },
    });
    expect(webSocket).not.toHaveBeenCalled();
  });

  it("rejects authenticated cross-origin discovery before socket creation", async () => {
    const webSocket = vi.fn(() => new FakeWebSocket("unused") as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket,
      }),
      origin: "https://mastodon.example",
      fetch: instanceDiscoveryFetch({
        configuration: {
          urls: { streaming: "https://stream.example/socket?access_token=advertised-secret" },
        },
      }),
    });
    const session = await client.auth.token.importToken({ accessToken: "viewer-secret" });
    const stream = await client.streams.notifications({ session });

    const error = await stream[Symbol.asyncIterator]()
      .next()
      .catch((cause: unknown) => cause);

    expect(webSocket).not.toHaveBeenCalled();
    expect(error).toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "stream.notifications", origin: "https://stream.example" },
    });
    expect(String(error)).not.toContain("viewer-secret");
    expect(JSON.stringify(error)).not.toContain("viewer-secret");
    expect(JSON.stringify(error)).not.toContain("advertised-secret");
  });

  it("allows an authenticated cross-origin stream only with an exact directional grant", async () => {
    const sockets: FakeWebSocket[] = [];
    const fetch = instanceDiscoveryFetch({
      configuration: { urls: { streaming: "https://stream.example/socket" } },
    });
    const transport: typeof globalThis.fetch = (input, init) => fetch(input, init);
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
      remoteAuthority: createRemoteAuthority({
        transport,
        credentialGrants: [
          {
            issuer: "https://mastodon.example",
            recipient: "https://stream.example",
            operation: "stream.notifications",
            credentialClass: "oauth-access-token",
            representations: ["authorization-header"],
          },
        ],
      }),
    });
    const session = await client.auth.token.importToken({ accessToken: "viewer-secret" });
    const stream = await client.streams.notifications({ session });
    const pending = stream[Symbol.asyncIterator]().next();
    await waitForSocket(sockets);

    expect(sockets[0]?.url).toBe(
      "wss://stream.example/socket/api/v1/streaming/?stream=user%3Anotification",
    );
    sockets[0]?.remoteClose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects a cross-origin stream when the grant operation is a near miss", async () => {
    const fetch = instanceDiscoveryFetch({
      configuration: { urls: { streaming: "https://stream.example/socket" } },
    });
    const transport: typeof globalThis.fetch = (input, init) => fetch(input, init);
    const webSocket = vi.fn(() => new FakeWebSocket("unused") as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket,
      }),
      origin: "https://mastodon.example",
      remoteAuthority: createRemoteAuthority({
        transport,
        credentialGrants: [
          {
            issuer: "https://mastodon.example",
            recipient: "https://stream.example",
            operation: "stream.timeline",
            credentialClass: "oauth-access-token",
            representations: ["authorization-header"],
          },
        ],
      }),
    });
    const session = await client.auth.token.importToken({ accessToken: "viewer-secret" });
    const stream = await client.streams.notifications({ session });

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "stream.notifications" },
    });
    expect(webSocket).not.toHaveBeenCalled();
  });

  it("uses a legacy advertised streaming base after the v2 fallback", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
      fetch: instanceDiscoveryFetch(
        { urls: { streaming_api: "wss://legacy-stream.example/socket-root" } },
        { legacy: true },
      ),
    });
    await client.instances.detect();
    const stream = await client.streams.timeline({ type: "public" });
    const pending = stream[Symbol.asyncIterator]().next();
    await waitForSocket(sockets);

    expect(sockets[0]?.url).toBe(
      "wss://legacy-stream.example/socket-root/api/v1/streaming/?stream=public",
    );
    sockets[0]?.remoteClose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it("forwards optional public timeline authentication and leaves anonymous URLs tokenless", async () => {
    const sockets: FakeWebSocket[] = [];
    const callOptions: unknown[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url, _protocols, _signal, options) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          callOptions.push(options);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const session = await client.auth.token.importToken({ accessToken: "public-viewer" });
    const authenticated = await client.streams.timeline({ type: "public", session });
    const authenticatedPending = authenticated[Symbol.asyncIterator]().next();
    await waitForSocket(sockets);
    expect(sockets[0]?.url).toBe("wss://mastodon.example/api/v1/streaming/?stream=public");
    expect(callOptions[0]).toEqual({
      operation: "stream.timeline",
      authorization: "Bearer public-viewer",
    });
    sockets[0]?.remoteClose();
    await authenticatedPending;

    const anonymous = await client.streams.timeline({ type: "public" });
    const anonymousPending = anonymous[Symbol.asyncIterator]().next();
    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toBe("wss://mastodon.example/api/v1/streaming/?stream=public");
    expect(callOptions[1]).toEqual({ operation: "stream.timeline" });
    sockets[1]?.remoteClose();
    await anonymousPending;
  });

  it("rejects authenticated streams over a plaintext remote origin", async () => {
    const webSocket = vi.fn(() => new FakeWebSocket("unused") as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket,
      }),
      origin: "http://mastodon.example",
      fetch: instanceDiscoveryFetch({}, { origin: "http://mastodon.example" }),
    });
    const session = await client.auth.token.importToken({ accessToken: "viewer-token" });

    const stream = await client.streams.notifications({ session });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "stream.notifications", origin: "http://mastodon.example" },
    });
    expect(webSocket).not.toHaveBeenCalled();
  });

  it("rejects an authenticated timeline on a plaintext advertised target", async () => {
    const webSocket = vi.fn(() => new FakeWebSocket("unused") as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket,
      }),
      origin: "https://mastodon.example",
      fetch: instanceDiscoveryFetch({
        configuration: { urls: { streaming: "http://stream.example/socket" } },
      }),
    });
    await client.instances.detect();
    const session = await client.auth.token.importToken({ accessToken: "viewer-token" });

    const stream = await client.streams.timeline({ type: "public", session });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "stream.timeline", origin: "http://stream.example" },
    });
    expect(webSocket).not.toHaveBeenCalled();
  });

  it("redacts credential-bearing errors from an injected WebSocket factory", async () => {
    let requestedUrl = "";
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: async (url, _protocols, _signal, options) => {
          requestedUrl = url;
          throw new Error(`Unable to connect with ${String(options?.authorization)}`);
        },
      }),
      origin: "https://mastodon.example",
    });
    const session = await client.auth.token.importToken({ accessToken: "viewer-secret" });
    const stream = await client.streams.notifications({ session });

    const error = await stream[Symbol.asyncIterator]()
      .next()
      .catch((cause: unknown) => cause);

    expect(requestedUrl).not.toContain("viewer-secret");
    expect(error).toMatchObject({
      code: "NETWORK_ERROR",
      context: { operation: "stream.notifications", origin: "https://mastodon.example" },
    });
    expect(String(error)).not.toContain("viewer-secret");
    expect(JSON.stringify(error)).not.toContain("viewer-secret");
    expect((error as Error).cause).toBeUndefined();
  });

  it("maps timeline WebSocket updates into stream events", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSocket(sockets);

    sockets[0]?.emit({
      event: "update",
      payload: JSON.stringify(accountMappingFixtures.mastodon.post),
    });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        type: "timeline.update",
        stream: "timeline",
        post: { ref: { rawId: "900" } },
      },
    });
    await iterator.return?.();
    expect(sockets[0]?.url).toBe("wss://mastodon.example/api/v1/streaming/?stream=public");
  });

  it("reports malformed upstream frames as remote errors", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSocket(sockets);

    sockets[0]?.emitRaw("{");

    await expect(next).rejects.toMatchObject({ code: "REMOTE_PROTOCOL_ERROR" });
    await iterator.return?.();
  });

  it.each([
    ["missing", { event: "update" }],
    ["non-string", { event: "notification", payload: 42 }],
    ["non-string delete", { event: "delete", payload: 42 }],
    ["invalid JSON", { event: "status.update", payload: "{" }],
    ["non-object JSON", { event: "update", payload: JSON.stringify("not-an-object") }],
  ])("reports %s known-event payloads as contextual remote errors", async (_label, frame) => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSocket(sockets);

    sockets[0]?.emit(frame);

    await expect(next).rejects.toMatchObject({
      code: "REMOTE_PROTOCOL_ERROR",
      context: {
        adapter: "mastodon",
        operation: "stream.timeline",
        origin: "https://mastodon.example",
      },
    });
    await iterator.return?.();
  });

  it("ignores unknown events even when their payload is malformed", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSocket(sockets);

    sockets[0]?.emit({ event: "future.event", payload: "{" });
    sockets[0]?.emit(mastodonUpdate());

    await expect(next).resolves.toMatchObject({
      done: false,
      value: { type: "timeline.update" },
    });
    await iterator.return?.();
  });

  it("maps delete events with raw string identifiers", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSocket(sockets);

    sockets[0]?.emit({ event: "delete", payload: "remote-status-id" });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        type: "delete",
        deleted: { ref: { rawId: "remote-status-id" } },
      },
    });
    await iterator.return?.();
  });

  it("reports upstream socket errors as network errors", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSocket(sockets);

    sockets[0]?.fail();

    await expect(next).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(sockets[0]?.closeCount).toBe(1);
    await iterator.return?.();
  });

  it("drains parsed frames received before a clean remote close", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    await waitForSocket(sockets);
    const socket = sockets[0];
    socket.emit(mastodonUpdate());
    await expect(first).resolves.toMatchObject({ done: false });

    socket.emit(mastodonUpdate());
    socket.remoteClose();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "timeline.update" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("accepts the exact queued event boundary and rejects a stalled overflow", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    await waitForSocket(sockets);
    const socket = sockets[0];

    socket.emit(mastodonUpdate());
    await expect(first).resolves.toMatchObject({ done: false, value: { type: "timeline.update" } });

    for (let index = 0; index < MAX_STREAMING_QUEUED_EVENTS; index += 1) {
      socket.emit({ event: "noop" });
    }
    const afterBoundary = iterator.next();
    socket.emit(mastodonUpdate());
    await expect(afterBoundary).resolves.toMatchObject({
      done: false,
      value: { type: "timeline.update" },
    });

    for (let index = 0; index <= MAX_STREAMING_QUEUED_EVENTS; index += 1) {
      socket.emit({ event: "noop" });
    }

    await expect(iterator.next()).rejects.toMatchObject({ code: "REQUEST_LIMIT_EXCEEDED" });
    expect(socket.closeCount).toBe(1);
    await iterator.return?.();
    expect(socket.closeCount).toBe(1);
  });

  it("accepts the exact queued byte boundary and rejects a stalled overflow", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    await waitForSocket(sockets);
    const socket = sockets[0];

    socket.emit(mastodonUpdate());
    await expect(first).resolves.toMatchObject({ done: false, value: { type: "timeline.update" } });

    socket.emitRaw(JSON.stringify("x".repeat(MAX_STREAMING_QUEUED_BYTES - 2)));
    const afterBoundary = iterator.next();
    socket.emit(mastodonUpdate());
    await expect(afterBoundary).resolves.toMatchObject({
      done: false,
      value: { type: "timeline.update" },
    });

    socket.emitRaw(JSON.stringify("x".repeat(MAX_STREAMING_QUEUED_BYTES - 1)));

    await expect(iterator.next()).rejects.toMatchObject({ code: "REQUEST_LIMIT_EXCEEDED" });
    expect(socket.closeCount).toBe(1);
    await iterator.return?.();
    expect(socket.closeCount).toBe(1);
  });
});

function mastodonUpdate(): Record<string, unknown> {
  return {
    event: "update",
    payload: JSON.stringify(accountMappingFixtures.mastodon.post),
  };
}

class FakeWebSocket extends EventTarget {
  public closeCount = 0;

  public constructor(public readonly url: string) {
    super();
  }

  public send(_data: string): void {}

  public close(): void {
    this.closeCount += 1;
    this.dispatchEvent(new Event("close"));
  }

  public remoteClose(): void {
    this.dispatchEvent(new Event("close"));
  }

  public emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  public emitRaw(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  public fail(): void {
    this.dispatchEvent(new Event("error"));
  }
}

async function waitForSocket(sockets: readonly FakeWebSocket[]): Promise<void> {
  return waitForSocketCount(sockets, 1);
}

async function waitForSocketCount(
  sockets: readonly FakeWebSocket[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (sockets.length >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Expected streaming test to create a WebSocket.");
}

function instanceDiscoveryFetch(
  instance: Record<string, unknown>,
  options: {
    readonly legacy?: boolean;
    readonly origin?: string;
    readonly softwareName?: string;
    readonly version?: string;
  } = {},
): typeof globalThis.fetch {
  const origin = options.origin ?? "https://mastodon.example";
  const domain = new URL(origin).host;
  const version = options.version ?? "4.1.0";
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/.well-known/nodeinfo") {
      return Response.json({
        links: [
          {
            rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
            href: `${origin}/nodeinfo/2.1`,
          },
        ],
      });
    }
    if (url.pathname === "/nodeinfo/2.1") {
      return Response.json({ software: { name: options.softwareName ?? "mastodon", version } });
    }
    if (url.pathname === "/api/v2/instance") {
      if (options.legacy === true) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ domain, version, ...instance });
    }
    if (url.pathname === "/api/v1/instance" && options.legacy === true) {
      return Response.json({ domain, version: "3.5.0", ...instance });
    }
    return Response.json({ error: "unexpected request" }, { status: 404 });
  });
}
