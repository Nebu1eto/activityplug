import { once } from "node:events";
import { createServer } from "node:http";

import { Redis } from "ioredis";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createCaddyClientIpResolver,
  createProductServer,
  main,
  type ProductServerRuntime,
} from "./server.js";

const cookieSigningKey = Buffer.alloc(32, 7).toString("base64url");

function validTestEnvironment(): Record<string, string> {
  return {
    ACTIVITYPLUG_PUBLIC_ORIGIN: "https://product.example",
    ACTIVITYPLUG_COOKIE_SIGNING_KEY: cookieSigningKey,
    ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS: "https://mastodon.example,https://social.example",
    ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES: "172.30.0.2",
    DATABASE_URL: "postgresql://activityplug:activityplug@postgres:5432/activityplug",
    REDIS_URL: "redis://redis:6379/0",
  };
}

describe("createProductServer", () => {
  it("registers five adapters and requires durable store settings by default", async () => {
    const runtime = await createProductServer(validTestEnvironment());
    expect(runtime.adapterIds).toEqual(["mastodon", "pleroma", "hollo", "misskey", "hackerspub"]);
    expect(runtime.storageMode).toBe("durable");
    await runtime.close();

    await expect(createProductServer({ ACTIVITYPLUG_STORAGE: "durable" })).rejects.toThrow(
      "DATABASE_URL is required in durable storage mode.",
    );
  });

  it("permits dependency-free startup only when memory mode is explicit", async () => {
    const runtime = await createProductServer({
      ...validTestEnvironment(),
      ACTIVITYPLUG_STORAGE: "memory",
      DATABASE_URL: "",
      REDIS_URL: "",
    });

    expect(runtime.storageMode).toBe("memory");
    await expect(runtime.app.request("https://product.example/health")).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
    const listener = await runtime.start({ hostname: "127.0.0.1", port: 0 });
    expect(listener.server.listening).toBe(true);
    const address = listener.server.address();
    if (address === null || typeof address === "string")
      throw new Error("Server did not bind a TCP port.");
    await expect(fetch(`http://127.0.0.1:${address.port}/health`)).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("uses stored anonymous sessions by default and enables stateless issuance explicitly", async () => {
    const stored = await createProductServer({
      ...validTestEnvironment(),
      ACTIVITYPLUG_STORAGE: "memory",
    });
    const stateless = await createProductServer({
      ...validTestEnvironment(),
      ACTIVITYPLUG_STORAGE: "memory",
      ACTIVITYPLUG_ANONYMOUS_SESSION_MODE: "stateless",
    });

    try {
      expect(stored.anonymousSessionMode).toBe("stored");
      expect(stateless.anonymousSessionMode).toBe("stateless");
    } finally {
      await Promise.all([stored.close(), stateless.close()]);
    }
  });

  it("reports durable dependency failures as an unhealthy public readiness response", async () => {
    const runtime = await createProductServer({
      ...validTestEnvironment(),
      DATABASE_URL: "postgresql://activityplug:activityplug@127.0.0.1:1/activityplug",
      REDIS_URL: "redis://127.0.0.1:1/0",
    });
    try {
      const response = await runtime.app.request("https://product.example/health");

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ data: { ok: false, version: "v1" } });
    } finally {
      await runtime.close();
    }
  });

  it("handles idle PostgreSQL client errors without an unhandled error event", async () => {
    const on = vi.spyOn(Pool.prototype, "on");
    const runtime = await createProductServer(validTestEnvironment());
    try {
      void runtime.app;
      const errorListeners = on.mock.calls
        .filter(([eventName]) => eventName === "error")
        .map(([, listener]) => listener);

      expect(errorListeners).toHaveLength(3);
      for (const listener of errorListeners) {
        expect(() => listener?.(new Error("idle client disconnected"))).not.toThrow();
      }
    } finally {
      await runtime.close();
      on.mockRestore();
    }
  });

  it("configures finite timeouts for durable serving clients", async () => {
    const end = vi.spyOn(Pool.prototype, "end").mockResolvedValue();
    const quit = vi.spyOn(Redis.prototype, "quit").mockResolvedValue("OK");
    const runtime = await createProductServer(validTestEnvironment());

    try {
      void runtime.app;
      await runtime.close();

      expect(end.mock.contexts.map((pool) => pool.options)).toContainEqual(
        expect.objectContaining({
          connectionTimeoutMillis: 10_000,
          query_timeout: 15_000,
          statement_timeout: 15_000,
        }),
      );
      expect(end.mock.contexts.map((pool) => pool.options)).toContainEqual(
        expect.objectContaining({
          connectionTimeoutMillis: 10_000,
          query_timeout: 600_000,
          statement_timeout: 600_000,
        }),
      );
      expect(end.mock.contexts.map((pool) => pool.options)).toContainEqual(
        expect.objectContaining({
          connectionTimeoutMillis: 2_000,
          query_timeout: 2_000,
          statement_timeout: 2_000,
        }),
      );
      expect(end).toHaveBeenCalledTimes(3);
      await runtime.close();
      expect(end).toHaveBeenCalledTimes(3);
      expect(quit.mock.contexts.map((redis) => redis.options)).toContainEqual(
        expect.objectContaining({
          connectTimeout: 10_000,
          commandTimeout: 15_000,
          enableOfflineQueue: false,
          lazyConnect: true,
          maxRetriesPerRequest: 0,
        }),
      );
    } finally {
      end.mockRestore();
      quit.mockRestore();
    }
  });

  it("isolates lifecycle initialization from serving query limits", async () => {
    const query = vi.spyOn(Pool.prototype, "query").mockResolvedValue({ rows: [] } as never);
    const end = vi.spyOn(Pool.prototype, "end").mockResolvedValue();
    const connect = vi.spyOn(Redis.prototype, "connect").mockResolvedValue();
    const ping = vi.spyOn(Redis.prototype, "ping").mockResolvedValue("PONG");
    const quit = vi.spyOn(Redis.prototype, "quit").mockResolvedValue("OK");
    const runtime = await createProductServer(validTestEnvironment());

    try {
      await runtime.start({ hostname: "127.0.0.1", port: 0 });

      expect(query).toHaveBeenCalled();
      expect(
        query.mock.contexts.every(
          (pool) =>
            pool.options.query_timeout === 600_000 && pool.options.statement_timeout === 600_000,
        ),
      ).toBe(true);
      expect(end).toHaveBeenCalledOnce();
      expect(end.mock.contexts[0]?.options).toEqual(
        expect.objectContaining({
          connectionTimeoutMillis: 10_000,
          query_timeout: 600_000,
          statement_timeout: 600_000,
        }),
      );

      await runtime.close();
      await runtime.close();
      expect(end).toHaveBeenCalledTimes(3);
      expect(new Set(end.mock.contexts).size).toBe(3);
    } finally {
      await runtime.close();
      query.mockRestore();
      end.mockRestore();
      connect.mockRestore();
      ping.mockRestore();
      quit.mockRestore();
    }
  });

  it("cleans a failed listener and permits a subsequent start", async () => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port.");
    }

    const runtime = await createProductServer({
      ...validTestEnvironment(),
      ACTIVITYPLUG_STORAGE: "memory",
    });
    await expect(runtime.start({ hostname: "127.0.0.1", port: address.port })).rejects.toThrow();
    const retry = await runtime.start({ hostname: "127.0.0.1", port: 0 });

    expect(retry.server.listening).toBe(true);
    await runtime.close();
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("allows one start without letting later attempts damage the listener", async () => {
    const runtime = await createProductServer({
      ...validTestEnvironment(),
      ACTIVITYPLUG_STORAGE: "memory",
    });
    const starting = runtime.start({ hostname: "127.0.0.1", port: 0 });

    await expect(runtime.start({ hostname: "127.0.0.1", port: 0 })).rejects.toThrow(
      "Product server startup is already in progress.",
    );
    const listener = await starting;
    await expect(runtime.start({ hostname: "127.0.0.1", port: 0 })).rejects.toThrow(
      "Product server runtime has already started.",
    );
    const address = listener.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Product server did not bind a TCP port.");
    }
    await expect(fetch(`http://127.0.0.1:${address.port}/health`)).resolves.toMatchObject({
      ok: true,
      status: 200,
    });

    await runtime.close();
    expect(() => runtime.app).toThrow("Product server runtime has been closed.");
  });

  it("cleans failed durable initialization before a retry", async () => {
    const end = vi.spyOn(Pool.prototype, "end");
    const runtime = await createProductServer({
      ...validTestEnvironment(),
      DATABASE_URL: "postgresql://activityplug:activityplug@127.0.0.1:1/activityplug",
    });
    const appBeforeFailedStart = runtime.app;

    await expect(runtime.start({ hostname: "127.0.0.1", port: 0 })).rejects.toThrow();
    expect(end).toHaveBeenCalledTimes(3);
    await expect(appBeforeFailedStart.request("/health")).resolves.toMatchObject({ status: 503 });
    await expect(runtime.start({ hostname: "127.0.0.1", port: 0 })).rejects.toThrow();
    expect(end).toHaveBeenCalledTimes(6);
    await runtime.close();
  });

  it("uses only Caddy's single sanitized forwarding hop", () => {
    const resolveClientIp = createCaddyClientIpResolver(["172.30.0.2"]);

    expect(
      resolveClientIp(
        new Request("https://product.example/", {
          headers: { "x-forwarded-for": "198.51.100.9" },
        }),
        "172.30.0.2",
      ),
    ).toBe("198.51.100.9");
    expect(
      resolveClientIp(
        new Request("https://product.example/", {
          headers: { "x-forwarded-for": "198.51.100.9, 203.0.113.10" },
        }),
        "172.30.0.2",
      ),
    ).toBe("172.30.0.2");
    expect(
      resolveClientIp(
        new Request("https://product.example/", {
          headers: { "x-real-ip": "198.51.100.9" },
        }),
        "172.30.0.2",
      ),
    ).toBe("172.30.0.2");
    expect(
      resolveClientIp(
        new Request("https://product.example/", {
          headers: { "x-forwarded-for": "198.51.100.9" },
        }),
        "203.0.113.10",
      ),
    ).toBe("203.0.113.10");
  });

  it("closes the created runtime when CLI startup fails", async () => {
    const startError = new Error("server could not bind");
    const close = vi.fn(async () => undefined);
    const runtime = {
      close,
      start: vi.fn(async () => {
        throw startError;
      }),
    } as unknown as ProductServerRuntime;

    await expect(main({}, async () => runtime)).rejects.toBe(startError);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects wildcard, malformed, and insecure product configuration", async () => {
    await expect(
      createProductServer({
        ...validTestEnvironment(),
        ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS: "https://mastodon.example,*",
      }),
    ).rejects.toThrow("ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS must not contain wildcards.");
    await expect(
      createProductServer({
        ...validTestEnvironment(),
        ACTIVITYPLUG_PUBLIC_ORIGIN: "http://product.example",
      }),
    ).rejects.toThrow("ACTIVITYPLUG_PUBLIC_ORIGIN must use HTTPS.");
    await expect(
      createProductServer({
        ...validTestEnvironment(),
        ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS: "http://mastodon.example",
      }),
    ).rejects.toThrow("ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS must use HTTPS.");
    await expect(
      createProductServer({
        ...validTestEnvironment(),
        ACTIVITYPLUG_COOKIE_SIGNING_KEY: Buffer.alloc(31).toString("base64url"),
      }),
    ).rejects.toThrow("ACTIVITYPLUG_COOKIE_SIGNING_KEY must contain at least 32 bytes.");
    await expect(
      createProductServer({
        ...validTestEnvironment(),
        ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES: "not-an-ip",
      }),
    ).rejects.toThrow("ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES is invalid");
    await expect(
      createProductServer({
        ...validTestEnvironment(),
        ACTIVITYPLUG_ANONYMOUS_SESSION_MODE: "automatic",
      }),
    ).rejects.toThrow("ACTIVITYPLUG_ANONYMOUS_SESSION_MODE must be either stored or stateless.");
  });
});
