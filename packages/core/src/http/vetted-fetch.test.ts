import { describe, expect, it, vi } from "vitest";

import { ActivityPlugError } from "../errors/error.js";
import {
  createVettedFetch,
  resolveVettedRemoteTarget,
  type LookupAddresses,
  type OriginPolicy,
  type PinnedDispatchInput,
  type PinnedDispatcher,
} from "./vetted-fetch.js";

const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 as const };
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const REPLAY_LIMIT = 4;

describe("createVettedFetch", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "::192.0.2.1",
    "64:ff9b::c000:201",
    "64:ff9b:1::1",
    "100::1",
    "100:0:0:1::1",
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "4000::1",
    "5f00::1",
    "8000::1",
    "0101::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff00::1",
  ])("rejects the reserved destination %s by default", async (address) => {
    const vettedFetch = createTestFetch({
      lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
    });

    await expect(vettedFetch("https://social.example/nodeinfo/2.1")).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
  });

  it.each(["::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:a00:1"])(
    "rejects the IPv4-mapped destination %s even with private access enabled",
    async (address) => {
      const vettedFetch = createTestFetch({
        allowPrivateNetworks: true,
        lookup: async () => [{ address, family: 6 }],
      });

      await expect(vettedFetch("https://social.example/nodeinfo/2.1")).rejects.toMatchObject({
        code: "ORIGIN_NOT_ALLOWED",
      });
    },
  );

  it("rejects a hostname when any DNS answer is prohibited", async () => {
    const dispatch = vi.fn(async () => new Response("ok"));
    const vettedFetch = createTestFetch({
      lookup: async () => [PUBLIC_ADDRESS, { address: "127.0.0.1", family: 4 }],
      dispatchPinned: { dispatch },
    });

    await expect(vettedFetch("https://social.example/path")).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { address: "192.0.1.1", family: 4 as const },
    { address: "198.51.200.1", family: 4 as const },
    { address: "203.0.114.1", family: 4 as const },
    { address: "2001:4860:4860::8888", family: 6 as const },
    { address: "2606:4700:4700::1111", family: 6 as const },
  ])("does not overblock the public address $address", async (answer) => {
    const dispatch = vi.fn(async () => new Response("ok"));
    const vettedFetch = createTestFetch({
      lookup: async () => [answer],
      dispatchPinned: { dispatch },
    });

    await expect(vettedFetch("https://social.example/path")).resolves.toMatchObject({
      status: 200,
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects an invalid address family from a custom lookup", async () => {
    const vettedFetch = createTestFetch({
      lookup: async () => [{ address: "2606:4700:4700::1111", family: 5 as unknown as 4 }],
    });

    await expect(vettedFetch("https://social.example/path")).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
  });

  it("allows an explicitly allowlisted private destination only with private access enabled", async () => {
    const assertAllowed = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => new Response("ok"));
    const vettedFetch = createTestFetch({
      allowPrivateNetworks: true,
      originPolicy: { assertAllowed },
      lookup: async () => [{ address: "10.0.0.2", family: 4 }],
      dispatchPinned: { dispatch },
    });

    await expect(vettedFetch("https://social.example/path")).resolves.toMatchObject({
      status: 200,
    });
    expect(assertAllowed).toHaveBeenCalledWith(
      "https://social.example",
      "GET /path",
      expect.any(AbortSignal),
    );
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("pins one validated address while preserving hostname, SNI, and Host", async () => {
    const dispatch = vi.fn(async () => new Response("ok"));
    const vettedFetch = createTestFetch({ dispatchPinned: { dispatch } });

    await vettedFetch("https://social.example:8443/path");

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        address: PUBLIC_ADDRESS.address,
        family: 4,
        hostname: "social.example",
        servername: "social.example",
        hostHeader: "social.example:8443",
      }),
    );
  });

  it("normalizes IPv6 URL brackets only for DNS and connection metadata", async () => {
    const lookup = vi.fn<LookupAddresses>(async () => [
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const dispatch = vi.fn(async () => new Response("ok"));
    const vettedFetch = createTestFetch({ lookup, dispatchPinned: { dispatch } });

    await vettedFetch("https://[2606:4700:4700::1111]:8443/path");

    expect(lookup).toHaveBeenCalledWith("2606:4700:4700::1111", expect.any(AbortSignal));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "2606:4700:4700::1111",
        servername: "2606:4700:4700::1111",
        hostHeader: "[2606:4700:4700::1111]:8443",
      }),
    );
  });

  it("revalidates origin policy, DNS, and address pinning for every redirect", async () => {
    const assertAllowed = vi.fn(async (origin: string) => {
      if (origin === "http://private.example") {
        throw new ActivityPlugError("ORIGIN_NOT_ALLOWED", "denied");
      }
    });
    const lookup = vi.fn<LookupAddresses>(async (hostname) => {
      if (hostname === "private.example") return [{ address: "127.0.0.1", family: 4 }];
      return [PUBLIC_ADDRESS];
    });
    const dispatch = vi.fn(async () => Response.redirect("http://private.example/admin", 302));
    const vettedFetch = createTestFetch({
      originPolicy: { assertAllowed },
      lookup,
      dispatchPinned: { dispatch },
    });

    await expect(vettedFetch("https://social.example/start")).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
    expect(assertAllowed).toHaveBeenNthCalledWith(
      1,
      "https://social.example",
      "GET /start",
      expect.any(AbortSignal),
    );
    expect(assertAllowed).toHaveBeenNthCalledWith(
      2,
      "http://private.example",
      "GET /admin",
      expect.any(AbortSignal),
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("detects redirect loops before dispatching the same URL twice", async () => {
    const dispatch = vi.fn(async () => Response.redirect("https://social.example/start", 302));
    const vettedFetch = createTestFetch({ dispatchPinned: { dispatch } });

    await expect(vettedFetch("https://social.example/start")).rejects.toMatchObject({
      code: "REMOTE_ERROR",
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("normalizes arbitrary policy failures to the typed origin error", async () => {
    const vettedFetch = createTestFetch({
      originPolicy: {
        assertAllowed: async () => {
          throw new Error("policy implementation failed");
        },
      },
    });

    await expect(vettedFetch("https://social.example/start")).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
  });

  it("rejects redirect URLs containing credentials with a typed error", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const dispatch = vi.fn(
      async () =>
        new Response(body, {
          status: 302,
          headers: { location: "https://user:secret@other.example/private" },
        }),
    );
    const vettedFetch = createTestFetch({ dispatchPinned: { dispatch } });

    await expect(vettedFetch("https://social.example/start")).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
    expect(cancelled).toBe(true);
  });

  it("cancels an invalid redirect response before rejecting it", async () => {
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const vettedFetch = createTestFetch({
      dispatchPinned: {
        dispatch: async () =>
          new Response(responseBody, {
            status: 302,
            headers: { location: "file:///etc/passwd" },
          }),
      },
    });

    await expect(vettedFetch("https://social.example/start")).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
    expect(cancelled).toBe(true);
  });

  it("does not await a hostile redirect body cancellation", async () => {
    const pending = Symbol("pending");
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const vettedFetch = createTestFetch({
      timeoutMs: 10,
      dispatchPinned: {
        dispatch: async () =>
          new Response(responseBody, {
            status: 302,
            headers: { location: "file:///etc/passwd" },
          }),
      },
    });

    const result = await Promise.race([
      vettedFetch("https://social.example/start").catch((cause: unknown) => cause),
      new Promise<typeof pending>((resolve) => {
        setTimeout(() => resolve(pending), 50);
      }),
    ]);

    expect(result).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(cancelled).toBe(true);
  });

  it("caps redirect hops", async () => {
    const dispatch = vi.fn(async ({ request }: PinnedDispatchInput) => {
      const current = new URL(request.url);
      const hop = Number(current.searchParams.get("hop") ?? "0");
      return Response.redirect(`https://social.example/path?hop=${hop + 1}`, 302);
    });
    const vettedFetch = createTestFetch({ dispatchPinned: { dispatch }, maxRedirects: 2 });

    await expect(vettedFetch("https://social.example/path?hop=0")).rejects.toMatchObject({
      code: "REMOTE_ERROR",
    });
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("strips credentials when a redirect crosses origins", async () => {
    const requests: Request[] = [];
    const dispatch = vi.fn(async ({ request }: PinnedDispatchInput) => {
      requests.push(request);
      return requests.length === 1
        ? Response.redirect("https://other.example/next", 307)
        : new Response("ok");
    });
    const vettedFetch = createTestFetch({ dispatchPinned: { dispatch } });

    await vettedFetch("https://social.example/start", {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        "Proxy-Authorization": "Basic secret",
        "X-Preserved": "yes",
      },
    });

    expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret");
    expect(requests[1]?.headers.get("authorization")).toBeNull();
    expect(requests[1]?.headers.get("cookie")).toBeNull();
    expect(requests[1]?.headers.get("proxy-authorization")).toBeNull();
    expect(requests[1]?.headers.get("x-preserved")).toBe("yes");
  });

  it.each([
    { status: 301, expectedMethod: "GET", expectedBody: "" },
    { status: 302, expectedMethod: "GET", expectedBody: "" },
    { status: 303, expectedMethod: "GET", expectedBody: "" },
    { status: 307, expectedMethod: "POST", expectedBody: "payload" },
    { status: 308, expectedMethod: "POST", expectedBody: "payload" },
  ])(
    "applies HTTP redirect method semantics for $status",
    async ({ status, expectedMethod, expectedBody }) => {
      const requests: Array<{ readonly method: string; readonly body: string }> = [];
      const dispatch = vi.fn(async ({ request }: PinnedDispatchInput) => {
        requests.push({ method: request.method, body: await request.text() });
        return requests.length === 1
          ? Response.redirect("https://social.example/next", status)
          : new Response("ok");
      });
      const vettedFetch = createTestFetch({ dispatchPinned: { dispatch } });

      await vettedFetch("https://social.example/start", { method: "POST", body: "payload" });

      expect(requests[1]).toEqual({ method: expectedMethod, body: expectedBody });
    },
  );

  it("replays only a request body that fits the explicit replay budget", async () => {
    const bodies: string[] = [];
    const dispatch = vi.fn(async ({ request }: PinnedDispatchInput) => {
      bodies.push(await request.text());
      return bodies.length === 1
        ? Response.redirect("https://social.example/next", 307)
        : new Response("ok");
    });
    const vettedFetch = createTestFetch({
      replayBodyBytes: REPLAY_LIMIT,
      dispatchPinned: { dispatch },
    });

    await expect(
      vettedFetch("https://social.example/start", { method: "POST", body: "1234" }),
    ).resolves.toMatchObject({ status: 200 });
    expect(bodies).toEqual(["1234", "1234"]);
  });

  it("streams a body above the replay budget without cloning it", async () => {
    const clone = vi.spyOn(Request.prototype, "clone").mockImplementation(() => {
      throw new Error("request body was cloned");
    });
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const dispatch = vi.fn(async ({ request }: PinnedDispatchInput) => {
      expect(await request.text()).toBe("12345678");
      return new Response("ok");
    });
    const vettedFetch = createTestFetch({
      replayBodyBytes: REPLAY_LIMIT,
      dispatchPinned: { dispatch },
    });

    try {
      await expect(
        vettedFetch("https://social.example/upload", {
          method: "POST",
          body: source,
          duplex: "half",
        } as RequestInit),
      ).resolves.toMatchObject({ status: 200 });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(cancelled).toBe(false);
    } finally {
      clone.mockRestore();
    }
  });

  it("cancels an unread large upload when the peer responds early", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("12345678"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const vettedFetch = createTestFetch({
      replayBodyBytes: REPLAY_LIMIT,
      dispatchPinned: { dispatch: async () => new Response("done") },
    });

    await vettedFetch("https://social.example/upload", {
      method: "POST",
      body: source,
      duplex: "half",
    } as RequestInit);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(cancelled).toBe(true);
  });

  it("rejects a body-preserving redirect for an upload above the replay budget", async () => {
    const dispatch = vi.fn(async ({ request }: PinnedDispatchInput) => {
      await request.text();
      return Response.redirect("https://social.example/next", 307);
    });
    const vettedFetch = createTestFetch({
      replayBodyBytes: REPLAY_LIMIT,
      dispatchPinned: { dispatch },
    });

    await expect(
      vettedFetch("https://social.example/upload", { method: "POST", body: "12345" }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: expect.objectContaining({ operation: "remote.redirect" }),
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects structured responses larger than the configured byte limit", async () => {
    const vettedFetch = createTestFetch({
      remoteStructuredBytes: 4,
      dispatchPinned: { dispatch: async () => new Response("12345secret") },
    });

    const response = await vettedFetch("https://social.example/data");

    await expect(response.text()).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
      context: expect.objectContaining({ raw: { limit: 4 } }),
    });
  });

  it("accepts the exact remote response read budget and cancels the next chunk", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a"));
        controller.enqueue(new TextEncoder().encode("b"));
        controller.enqueue(new TextEncoder().encode("c"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const vettedFetch = createTestFetch({
      maxBodyReads: 2,
      dispatchPinned: { dispatch: async () => new Response(source) },
    });

    const response = await vettedFetch("https://social.example/data");

    await expect(response.text()).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
      context: expect.objectContaining({ operation: "remote.response" }),
    });
    expect(cancelled).toBe(true);
  });

  it("preserves a coalesced response within the remote response read budget", async () => {
    const vettedFetch = createTestFetch({
      maxBodyReads: 1,
      dispatchPinned: { dispatch: async () => new Response("abc") },
    });

    const response = await vettedFetch("https://social.example/data");

    await expect(response.text()).resolves.toBe("abc");
  });

  it("shares the request read budget across replay prefix and forwarding", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12"));
        controller.enqueue(new TextEncoder().encode("345"));
        controller.enqueue(new TextEncoder().encode("6"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const dispatch = vi.fn(async ({ request }: PinnedDispatchInput) => {
      await request.text();
      return new Response("unexpected");
    });
    const vettedFetch = createTestFetch({
      maxBodyReads: 2,
      replayBodyBytes: 4,
      dispatchPinned: { dispatch },
    });

    await expect(
      vettedFetch("https://social.example/upload", {
        method: "POST",
        body: source,
        duplex: "half",
      } as RequestInit),
    ).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
      context: expect.objectContaining({ operation: "remote.request" }),
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(cancelled).toBe(true);
  });

  it("accepts a request at the exact read and replay boundaries", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12"));
        controller.enqueue(new TextEncoder().encode("34"));
        controller.close();
      },
    });
    const dispatch = vi.fn(async ({ request }: PinnedDispatchInput) => {
      await expect(request.text()).resolves.toBe("1234");
      return new Response("ok");
    });
    const vettedFetch = createTestFetch({
      maxBodyReads: 2,
      replayBodyBytes: 4,
      dispatchPinned: { dispatch },
    });

    await expect(
      vettedFetch("https://social.example/upload", {
        method: "POST",
        body: source,
        duplex: "half",
      } as RequestInit),
    ).resolves.toMatchObject({ status: 200 });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("preserves the typed response-limit error when stream cancellation fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });
    const vettedFetch = createTestFetch({
      remoteStructuredBytes: 4,
      dispatchPinned: { dispatch: async () => new Response(body) },
    });

    const response = await vettedFetch("https://social.example/data");

    await expect(response.text()).rejects.toMatchObject({ code: "REQUEST_LIMIT_EXCEEDED" });
  });

  it("keeps the deadline active until the final response body completes", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const vettedFetch = createTestFetch({
      timeoutMs: 25,
      dispatchPinned: { dispatch: async () => new Response(source) },
    });

    try {
      const response = await vettedFetch("https://social.example/slow");
      const body = expect(response.text()).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(25);
      await body;
      expect(cancelled).toBe(true);
      expect(source.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the final response reader before hostile cancellation settles", async () => {
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        return new Promise<void>(() => undefined);
      },
    });
    const vettedFetch = createTestFetch({
      dispatchPinned: { dispatch: async () => new Response(source) },
    });

    const response = await vettedFetch("https://social.example/stream");
    void response.body?.cancel();
    await Promise.resolve();

    expect(source.locked).toBe(false);
  });

  it("stops waiting for DNS when the caller aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const dispatch = vi.fn(async () => new Response("unexpected"));
    let lookupSignal: AbortSignal | undefined;
    let notifyLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      notifyLookupStarted = resolve;
    });
    const vettedFetch = createTestFetch({
      lookup: async (_hostname, signal) => {
        lookupSignal = signal;
        notifyLookupStarted?.();
        return new Promise<readonly (typeof PUBLIC_ADDRESS)[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      dispatchPinned: { dispatch },
    });
    const request = vettedFetch("https://social.example/path", { signal: controller.signal });
    await lookupStarted;
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(lookupSignal?.aborted).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("validates every required boundary option at construction", () => {
    const base = {
      remoteStructuredBytes: RESPONSE_LIMIT,
      replayBodyBytes: REPLAY_LIMIT,
      timeoutMs: 100,
      lookup: async () => [PUBLIC_ADDRESS],
      dispatchPinned: { dispatch: async () => new Response("ok") },
      originPolicy: { assertAllowed: async () => undefined },
    };

    expect(() => createVettedFetch({ ...base, maxRedirects: Number.MAX_VALUE })).toThrow(
      RangeError,
    );

    for (const invalid of [
      { ...base, replayBodyBytes: -1 },
      { ...base, maxBodyReads: 0 },
      { ...base, timeoutMs: 0 },
      { ...base, timeoutMs: 2_147_483_648 },
      { ...base, lookup: undefined },
      { ...base, dispatchPinned: {} },
      { ...base, originPolicy: {} },
    ]) {
      expect(() => createVettedFetch(invalid as never)).toThrow(TypeError);
    }
  });

  it("rejects invalid schemes before DNS or dispatch", async () => {
    const lookup = vi.fn<LookupAddresses>(async () => [PUBLIC_ADDRESS]);
    const dispatch = vi.fn(async () => new Response("ok"));
    const vettedFetch = createTestFetch({ lookup, dispatchPinned: { dispatch } });

    await expect(vettedFetch("file:///etc/passwd")).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("resolveVettedRemoteTarget", () => {
  it("reports the caller operation when target resolution times out", async () => {
    await expect(
      resolveVettedRemoteTarget("wss://social.example/streaming", {
        lookup: async () => new Promise(() => undefined),
        operation: "stream.connect",
        originPolicy: { assertAllowed: async () => undefined },
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      context: { operation: "stream.connect", origin: "wss://social.example" },
    });
  });
});

function createTestFetch(
  overrides: Partial<{
    readonly allowPrivateNetworks: boolean;
    readonly remoteStructuredBytes: number;
    readonly maxRedirects: number;
    readonly replayBodyBytes: number;
    readonly maxBodyReads: number;
    readonly timeoutMs: number;
    readonly lookup: LookupAddresses;
    readonly dispatchPinned: PinnedDispatcher;
    readonly originPolicy: OriginPolicy;
  }> = {},
): typeof fetch {
  return createVettedFetch({
    remoteStructuredBytes: RESPONSE_LIMIT,
    replayBodyBytes: 1024,
    timeoutMs: 10_000,
    lookup: async () => [PUBLIC_ADDRESS],
    dispatchPinned: { dispatch: async () => new Response("ok") },
    originPolicy: { assertAllowed: async () => undefined },
    ...overrides,
  });
}
