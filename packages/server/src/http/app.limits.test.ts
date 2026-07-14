import { capability, createCapabilitySet } from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { createTestService, testInstance, testMedia } from "./app-test-utils.js";
import { createActivityPlugApp } from "./app.js";

describe("ActivityPlug transport limits", () => {
  it("rejects an oversized JSON body before service work", async () => {
    const detect = vi.fn(createTestService().instances.detect);
    const app = createActivityPlugApp({
      service: createTestService({
        instances: { ...createTestService().instances, detect },
      }),
      requestLimits: { jsonBytes: 32 },
    });

    const response = await app.request("/api/v1/instances/detect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: `https://${"x".repeat(64)}.example` }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "REQUEST_LIMIT_EXCEEDED" },
    });
    expect(detect).not.toHaveBeenCalled();
  });

  it("rejects an oversized GraphQL envelope before parsing or resolving", async () => {
    const health = vi.fn(createTestService().health);
    const app = createActivityPlugApp({
      service: createTestService({ health }),
      requestLimits: { graphqlBytes: 32 },
    });

    const response = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { health { ok version } }" }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      errors: [{ extensions: { activityplug: { code: "REQUEST_LIMIT_EXCEEDED" } } }],
    });
    expect(health).not.toHaveBeenCalled();
  });

  it("rejects a legacy GraphQL session credential before resolving", async () => {
    const health = vi.fn(createTestService().health);
    const app = createActivityPlugApp({ service: createTestService({ health }) });

    const response = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "body-secret",
        query: "query { health { ok version } }",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errors: [{ message: expect.stringContaining("Authorization: Bearer") }],
    });
    expect(health).not.toHaveBeenCalled();
  });

  it("rejects a GraphQL query-string credential before reading the body", async () => {
    const health = vi.fn(createTestService().health);
    const app = createActivityPlugApp({
      service: createTestService({ health }),
      requestLimits: { graphqlBytes: 1 },
    });

    const response = await app.request("/graphql?sessionId=query-secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { health { ok } }" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errors: [{ extensions: { activityplug: { code: "VALIDATION_FAILED" } } }],
    });
    expect(health).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "aliases",
      limits: { aliases: 1 },
      query: "query { first: health { ok } second: health { ok } }",
    },
    {
      label: "depth",
      limits: { depth: 2 },
      query: "query { __schema { queryType { fields { name } } } }",
    },
    {
      label: "complexity",
      limits: { aliases: 2, depth: 2, complexity: 2 },
      query: "query { first: health { ok } second: health { ok } }",
    },
  ])("rejects GraphQL work above the $label limit", async ({ limits, query }) => {
    const health = vi.fn(createTestService().health);
    const app = createActivityPlugApp({
      service: createTestService({ health }),
      graphqlLimits: limits,
    });

    const response = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      errors: [{ extensions: { activityplug: { code: "REQUEST_LIMIT_EXCEEDED" } } }],
    });
    expect(health).not.toHaveBeenCalled();
  });

  it("bounds concurrent GraphQL resolver service calls per request", async () => {
    let active = 0;
    let peak = 0;
    const get = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return testInstance;
    });
    const service = createTestService({
      instances: Object.freeze({ ...createTestService().instances, get }),
    });
    const app = createActivityPlugApp({
      service: Object.freeze(service),
      graphqlLimits: { outboundConcurrency: 2 },
    });

    const response = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query:
          'query { first: instance(origin: "https://example.test") { ref { id } } second: instance(origin: "https://example.test") { ref { id } } third: instance(origin: "https://example.test") { ref { id } } fourth: instance(origin: "https://example.test") { ref { id } } }',
      }),
    });

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(4);
    expect(peak).toBe(2);
  });

  it("rejects the configured multipart total before decoding or service work", async () => {
    const capabilities = vi.fn(createTestService().capabilities);
    const upload = vi.fn(async () => testMedia);
    const app = createActivityPlugApp({
      service: createTestService({
        capabilities,
        media: { ...createTestService().media, upload },
      }),
      requestLimits: { multipartBytes: 128, multipartFileBytes: 128 },
    });
    const response = await app.request("/api/v1/media", {
      method: "POST",
      headers: {
        authorization: "Bearer session-1",
        "content-type": "multipart/form-data; boundary=limit",
      },
      body: "x".repeat(129),
    });

    expect(response.status).toBe(413);
    expect(capabilities).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a configured multipart file count before capability work", async () => {
    const upload = vi.fn(async () => testMedia);
    const capabilities = vi.fn(createTestService().capabilities);
    const app = createActivityPlugApp({
      service: createTestService({
        capabilities,
        media: { ...createTestService().media, upload },
      }),
      requestLimits: {
        multipartBytes: 2_048,
        multipartFiles: 1,
        multipartFileBytes: 1_024,
      },
    });
    const form = new FormData();
    form.set("origin", "https://example.test");
    form.append("file", new Blob(["1"], { type: "image/png" }), "first.png");
    form.append("extra", new Blob(["1"], { type: "image/png" }), "second.png");

    const response = await app.request("/api/v1/media", {
      method: "POST",
      headers: { authorization: "Bearer session-1" },
      body: form,
    });

    expect(response.status).toBe(413);
    expect(capabilities).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a configured per-file byte limit before capability work", async () => {
    const upload = vi.fn(async () => testMedia);
    const capabilities = vi.fn(createTestService().capabilities);
    const app = createActivityPlugApp({
      service: createTestService({
        capabilities,
        media: { ...createTestService().media, upload },
      }),
      requestLimits: {
        multipartBytes: 2_048,
        multipartFileBytes: 3,
      },
    });
    const form = new FormData();
    form.set("origin", "https://example.test");
    form.set("file", new Blob(["1234"], { type: "image/png" }), "media.png");

    const response = await app.request("/api/v1/media", {
      method: "POST",
      headers: { authorization: "Bearer session-1" },
      body: form,
    });

    expect(response.status).toBe(413);
    expect(capabilities).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    { content: "1234", type: "image/png", extraFile: false, expectedConstraint: "size" },
    { content: "12", type: "text/plain", extraFile: false, expectedConstraint: "MIME" },
    { content: "1", type: "image/png", extraFile: true, expectedConstraint: "count" },
  ])(
    "intersects executable media capability $expectedConstraint constraints",
    async ({ content, type, extraFile }) => {
      const upload = vi.fn(async () => testMedia);
      const capabilities = vi.fn(() =>
        createCapabilitySet({
          "media.upload": capability("supported", undefined, undefined, {
            media: { maxBytes: 3, maxItems: 1, mimeTypes: ["image/png"] },
          }),
        }),
      );
      const app = createActivityPlugApp({
        service: createTestService({
          capabilities,
          media: { ...createTestService().media, upload },
        }),
        requestLimits: {
          multipartBytes: 2_048,
          multipartFiles: 4,
          multipartFileBytes: 1_024,
        },
      });
      const form = new FormData();
      form.set("origin", "https://example.test");
      form.set("file", new Blob([content], { type }), "media.bin");
      if (extraFile) {
        form.set("extra", new Blob(["1"], { type: "image/png" }), "extra.png");
      }

      const response = await app.request("/api/v1/media", {
        method: "POST",
        headers: { authorization: "Bearer session-1" },
        body: form,
      });

      expect(response.status).toBe(413);
      expect(capabilities).toHaveBeenCalledOnce();
      expect(upload).not.toHaveBeenCalled();
    },
  );
});

describe("ActivityPlug credentialed CORS configuration", () => {
  it.each([
    { credentials: true },
    { credentials: true, origin: "*" },
    { credentials: true, origin: [] },
    { credentials: true, origin: ["https://app.example", "*"] },
    { credentials: true, origin: () => "https://app.example" },
  ])("rejects non-explicit credentialed origins: %j", (cors) => {
    expect(() => createActivityPlugApp({ service: createTestService(), cors })).toThrow(TypeError);
  });

  it("allows credentials with an explicit origin allowlist", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
      cors: { credentials: true, origin: ["https://app.example"] },
    });

    const response = await app.request("/health", {
      headers: { origin: "https://app.example" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
