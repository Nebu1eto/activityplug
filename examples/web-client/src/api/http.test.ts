import { describe, expect, it, vi } from "vitest";

import { createBrowserApi, type WebApiError } from "./http.js";

describe("browser-boundary transport", () => {
  it("checks status and content type before JSON decoding", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("<h1>gateway failure</h1>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );
    const api = createBrowserApi(fetch);

    await expect(api.get("/v1/browser/session", undefined, "plain")).rejects.toMatchObject({
      code: "HTTP_STATUS",
      status: 502,
    } satisfies Partial<WebApiError>);
  });

  it("preserves a typed non-2xx ActivityPlug error", async () => {
    const api = createBrowserApi(async () =>
      Response.json(
        {
          error: {
            code: "UNSUPPORTED",
            message: "Quotes are unavailable.",
            requestId: "request-1",
          },
        },
        { status: 422 },
      ),
    );
    api.setCsrfToken("csrf-1");

    await expect(api.post("/v1/browser/api/posts/p1/favourite", {})).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: "Quotes are unavailable.",
      status: 422,
    });
  });

  it("uses credentials, sends CSRF only for unsafe methods, and never sends Authorization", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request);
      return Response.json({ data: { ok: true } });
    }) as typeof globalThis.fetch;
    const api = createBrowserApi(fetch);

    await api.get("/v1/browser/api/capabilities");
    api.setCsrfToken("csrf-1");
    await api.post("/v1/browser/logout", {});

    expect(requests[0]?.credentials).toBe("same-origin");
    expect(requests[0]?.headers.get("X-ActivityPlug-CSRF")).toBeNull();
    expect(requests[1]?.headers.get("X-ActivityPlug-CSRF")).toBe("csrf-1");
    expect(requests.every((request) => !request.headers.has("Authorization"))).toBe(true);
  });

  it("does not attach a JSON content type to multipart bodies", async () => {
    let request: Request | undefined;
    const api = createBrowserApi(async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input);
      return Response.json({ data: { ok: true } });
    });
    api.setCsrfToken("csrf-1");
    const form = new FormData();
    form.set("file", new Blob(["image"], { type: "image/png" }), "cat.png");

    await api.postForm("/v1/browser/api/media", form);

    expect(request?.headers.get("content-type")).not.toBe("application/json");
  });

  it("rejects cross-origin and non-relative paths before fetch", async () => {
    const fetch = vi.fn();
    const api = createBrowserApi(fetch);

    await expect(api.get("https://attacker.test/v1/browser/session")).rejects.toMatchObject({
      code: "INVALID_PATH",
    } satisfies Partial<WebApiError>);
    await expect(api.get("//attacker.test/v1/browser/session")).rejects.toMatchObject({
      code: "INVALID_PATH",
    } satisfies Partial<WebApiError>);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts only the BFF application/json media type", async () => {
    const api = createBrowserApi(
      async () =>
        new Response('{"data":{"ok":true}}', {
          headers: { "content-type": "application/problem+json" },
        }),
    );

    await expect(api.get("/v1/browser/api/capabilities")).rejects.toMatchObject({
      code: "INVALID_CONTENT_TYPE",
    } satisfies Partial<WebApiError>);
  });

  it("normalizes malformed JSON without swallowing AbortError", async () => {
    const success = createBrowserApi(
      async () => new Response("{", { headers: { "content-type": "application/json" } }),
    );
    const error = createBrowserApi(
      async () =>
        new Response("{", {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    error.setCsrfToken("csrf-1");

    await expect(success.get("/v1/browser/api/capabilities")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    } satisfies Partial<WebApiError>);
    await expect(error.post("/v1/browser/logout", {})).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
      status: 400,
    } satisfies Partial<WebApiError>);

    const aborted = new DOMException("The operation was aborted.", "AbortError");
    const abortedRequest = createBrowserApi(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => Promise.reject(aborted),
        }) as unknown as Response,
    );
    await expect(abortedRequest.get("/v1/browser/api/capabilities")).rejects.toBe(aborted);
  });

  it("aborts only in-flight unsafe requests and leaves GETs unaffected", async () => {
    let unsafeSignal: AbortSignal | undefined;
    let resolveGet: (() => void) | undefined;
    const api = createBrowserApi((input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.method === "POST") {
        unsafeSignal = request.signal;
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        });
      }
      return new Promise((resolve) => {
        resolveGet = () => resolve(Response.json({ data: { ok: true } }));
      });
    });
    api.setCsrfToken("csrf-1");

    const unsafe = api.post("/v1/browser/api/posts", {});
    const get = api.get("/v1/browser/session");
    const expectUnsafeAbort = expect(unsafe).rejects.toMatchObject({ name: "AbortError" });

    api.abortUnsafeRequests();
    api.abortUnsafeRequests();

    expect(unsafeSignal?.aborted).toBe(true);
    resolveGet?.();
    await expectUnsafeAbort;
    await expect(get).resolves.toEqual({ ok: true });
  });

  it("combines caller cancellation with each unsafe request controller", async () => {
    let unsafeSignal: AbortSignal | undefined;
    const api = createBrowserApi((input) => {
      const request = input instanceof Request ? input : new Request(input);
      unsafeSignal = request.signal;
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });
    });
    const caller = new AbortController();
    api.setCsrfToken("csrf-1");
    const request = api.post("/v1/browser/api/posts", {}, caller.signal);
    const expectAbort = expect(request).rejects.toMatchObject({ name: "AbortError" });

    caller.abort();

    expect(unsafeSignal?.aborted).toBe(true);
    await expectAbort;
  });

  it("unregisters settled unsafe requests", async () => {
    let unsafeSignal: AbortSignal | undefined;
    const api = createBrowserApi(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      unsafeSignal = request.signal;
      return Response.json({ data: { ok: true } });
    });
    api.setCsrfToken("csrf-1");

    await api.post("/v1/browser/api/posts", {});
    api.abortUnsafeRequests();

    expect(unsafeSignal?.aborted).toBe(false);
  });
});
