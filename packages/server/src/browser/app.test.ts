import { createHash } from "node:crypto";

import {
  ActivityPlugError,
  BudgetScope,
  capability,
  createEntityRef,
  createCapabilitySet,
  type StoredAuthSession,
} from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { InMemoryAuthSessionStore } from "../auth/session-store.js";
import { createTestService, testViewerAccount } from "../http/app-test-utils.js";
import {
  InMemoryBrowserSessionStore,
  InMemoryOAuthStartLimiter,
  InMemoryOAuthStateStore,
  InMemoryShortCacheStore,
  InMemoryStreamTicketStore,
} from "../storage/in-memory.js";
import { createBrowserBoundary } from "./app.js";

const publicOrigin = "https://client.test";
const cookieSigningKey = new Uint8Array(32).fill(7);

describe("browser boundary sessions", () => {
  it("keeps anonymous sessions stateless by default", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const create = vi.spyOn(browserSessions, "create");
    const boundary = createDefaultModeBoundary({ browserSessions });

    const response = await boundary.app.request(`${publicOrigin}/v1/browser/session`);
    const cookie = cookiePair(requiredCookie(response));
    const context = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie } }),
    );

    expect(response.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
    await expect(browserSessions.get(context.browserSession.id)).resolves.toBeNull();
    expect(JSON.parse(decodeCookiePayload(cookie))).toMatchObject({
      id: context.browserSession.id,
    });
  });

  it("keeps repeated cookieless anonymous sessions out of durable storage in stateless mode", async () => {
    const backing = new InMemoryBrowserSessionStore();
    const create = vi.spyOn(backing, "create");
    const deleteExpired = vi.spyOn(backing, "deleteExpired");
    const boundary = createBoundary({ browserSessions: backing });

    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        Promise.resolve(boundary.app.request(`${publicOrigin}/v1/browser/session`)),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(deleteExpired).toHaveBeenCalledTimes(1);
    const first = responses.at(0);
    if (first === undefined) throw new Error("expected an anonymous session response");
    await expect(
      boundary.resolveRequest(
        new Request(`${publicOrigin}/`, {
          headers: { cookie: cookiePair(requiredCookie(first)) },
        }),
      ),
    ).resolves.toMatchObject({ browserSession: { authenticated: false } });
  });

  it("returns a typed capacity denial for stored anonymous sessions", async () => {
    const boundary = createStoredModeBoundary({ storedSessionCapacity: 1 });

    const admitted = await boundary.app.request(`${publicOrigin}/v1/browser/session`);
    const denied = await boundary.app.request(`${publicOrigin}/v1/browser/session`);

    expect(admitted.status).toBe(200);
    expect(denied.status).toBe(429);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED", message: "Browser session capacity is exhausted." },
    });
  });

  it("limits stored live sessions per client without blocking another client", async () => {
    const boundary = createStoredModeBoundary({
      clientIp: (request) => request.headers.get("x-test-client") ?? "missing",
      storedSessionCapacity: 10,
      storedSessionCapacityPerClient: 1,
    });

    const first = await boundary.app.request(`${publicOrigin}/v1/browser/session`, {
      headers: { "x-test-client": "client-a" },
    });
    const sameClient = await boundary.app.request(`${publicOrigin}/v1/browser/session`, {
      headers: { "x-test-client": "client-a" },
    });
    const otherClient = await boundary.app.request(`${publicOrigin}/v1/browser/session`, {
      headers: { "x-test-client": "client-b" },
    });

    expect(first.status).toBe(200);
    expect(sameClient.status).toBe(429);
    expect(otherClient.status).toBe(200);
  });

  it("rate-limits stored session creation before allocating another record", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const boundary = createStoredModeBoundary({
      browserSessions,
      clientIp: () => "client-a",
      storedSessionCapacityPerClient: 10,
      storedSessionCreationLimit: 1,
      storedSessionCreationWindowMilliseconds: 60_000,
    });
    const first = await boundary.app.request(`${publicOrigin}/v1/browser/session`);
    const firstContext = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, {
        headers: { cookie: cookiePair(requiredCookie(first)) },
      }),
    );
    await browserSessions.delete(firstContext.browserSession.id);

    const denied = await boundary.app.request(`${publicOrigin}/v1/browser/session`);

    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("60");
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED", retryAfterSeconds: 60 },
    });
  });

  it("retains one allocation budget until a stored browser session is gone", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const budget = new BudgetScope({
      operation: "browser.session.admit",
      limits: { activeAllocations: 1 },
    });
    const createBudgetScope = vi.fn(() => budget);
    const boundary = createStoredModeBoundary({ browserSessions, createBudgetScope });

    const admitted = await boundary.app.request(`${publicOrigin}/v1/browser/session`);
    const cookie = cookiePair(requiredCookie(admitted));
    const context = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie } }),
    );

    expect(admitted.status).toBe(200);
    expect(createBudgetScope).toHaveBeenCalledWith({
      adapterId: "browser",
      origin: publicOrigin,
      operation: "browser.session.admit",
    });
    expect(budget.snapshot().used.activeAllocations).toBe(1);

    const exhausted = await boundary.app.request(`${publicOrigin}/v1/browser/session`);
    expect(exhausted.status).not.toBe(200);
    await expect(browserSessions.get(context.browserSession.id)).resolves.not.toBeNull();
    expect(budget.snapshot().used.activeAllocations).toBe(1);

    await browserSessions.delete(context.browserSession.id);
    await expect(
      boundary.resolveRequest(new Request(`${publicOrigin}/`, { headers: { cookie } })),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(budget.snapshot().used.activeAllocations).toBe(0);
    await boundary.close();
  });

  it("releases failed and closed stored browser allocation reservations", async () => {
    const budget = new BudgetScope({
      operation: "browser.session.admit",
      limits: { activeAllocations: 2 },
    });
    const boundary = createStoredModeBoundary({
      storedSessionCapacity: 1,
      createBudgetScope: () => budget,
    });

    expect((await boundary.app.request(`${publicOrigin}/v1/browser/session`)).status).toBe(200);
    expect((await boundary.app.request(`${publicOrigin}/v1/browser/session`)).status).toBe(429);
    expect(budget.snapshot().used.activeAllocations).toBe(1);

    await boundary.close();
    expect(budget.snapshot().used.activeAllocations).toBe(0);
  });

  it("rolls back an admission that completes while the boundary closes", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const budget = new BudgetScope({
      operation: "browser.session.admit",
      limits: { activeAllocations: 1 },
    });
    const originalAdmit = browserSessions.admit.bind(browserSessions);
    let continueAdmission: (() => void) | undefined;
    let admissionStarted: (() => void) | undefined;
    const admissionGate = new Promise<void>((resolve) => {
      continueAdmission = resolve;
    });
    const started = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    let admittedId: string | undefined;
    const admit = vi.spyOn(browserSessions, "admit").mockImplementation(async (record, limits) => {
      admittedId = record.id;
      admissionStarted?.();
      await admissionGate;
      return originalAdmit(record, limits);
    });
    const boundary = createStoredModeBoundary({
      browserSessions,
      createBudgetScope: () => budget,
    });

    const responsePromise = boundary.app.request(`${publicOrigin}/v1/browser/session`);
    await started;
    const closing = boundary.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    continueAdmission?.();

    const response = await responsePromise;
    await closing;
    expect(closed).toBe(true);
    expect(response.status).toBe(502);
    expect(admittedId).toBeDefined();
    await expect(browserSessions.get(admittedId ?? "missing")).resolves.toBeNull();
    expect(budget.snapshot().used.activeAllocations).toBe(0);

    expect((await boundary.app.request(`${publicOrigin}/v1/browser/session`)).status).toBe(502);
    expect(admit).toHaveBeenCalledOnce();
  });

  it("rejects close and retains accounting when admission rollback fails", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const budget = new BudgetScope({
      operation: "browser.session.admit",
      limits: { activeAllocations: 1 },
    });
    const originalAdmit = browserSessions.admit.bind(browserSessions);
    const rollbackError = new Error("durable session rollback failed");
    let continueAdmission: (() => void) | undefined;
    let admissionStarted: (() => void) | undefined;
    const admissionGate = new Promise<void>((resolve) => {
      continueAdmission = resolve;
    });
    const started = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    const admit = vi.spyOn(browserSessions, "admit").mockImplementation(async (record, limits) => {
      admissionStarted?.();
      await admissionGate;
      return originalAdmit(record, limits);
    });
    const rollback = vi.spyOn(browserSessions, "delete").mockRejectedValue(rollbackError);
    const get = vi.spyOn(browserSessions, "get");
    const boundary = createStoredModeBoundary({
      browserSessions,
      createBudgetScope: () => budget,
    });

    const responsePromise = boundary.app.request(`${publicOrigin}/v1/browser/session`);
    await started;
    const closing = boundary.close();
    const closeResult = closing.then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    continueAdmission?.();

    expect((await responsePromise).status).not.toBe(200);
    await expect(closeResult).resolves.toEqual({ resolved: false, error: rollbackError });
    expect(budget.snapshot().used.activeAllocations).toBe(1);
    expect(rollback).toHaveBeenCalledOnce();

    const callsAfterClose = {
      admit: admit.mock.calls.length,
      delete: rollback.mock.calls.length,
      get: get.mock.calls.length,
    };
    expect((await boundary.app.request(`${publicOrigin}/v1/browser/session`)).status).toBe(502);
    expect(admit).toHaveBeenCalledTimes(callsAfterClose.admit);
    expect(rollback).toHaveBeenCalledTimes(callsAfterClose.delete);
    expect(get).toHaveBeenCalledTimes(callsAfterClose.get);
    expect(boundary.close()).toBe(closing);
  });

  it("releases a stored browser allocation after passive expiry", async () => {
    let current = new Date("2026-07-12T00:00:00.000Z");
    const budget = new BudgetScope({
      operation: "browser.session.admit",
      limits: { activeAllocations: 1 },
    });
    const browserSessions = new InMemoryBrowserSessionStore({ now: () => current });
    const boundary = createStoredModeBoundary({
      browserSessions,
      now: () => current,
      sessionTtlMilliseconds: 1_000,
      createBudgetScope: () => budget,
    });
    const response = await boundary.app.request(`${publicOrigin}/v1/browser/session`);
    const cookie = cookiePair(requiredCookie(response));
    expect(budget.snapshot().used.activeAllocations).toBe(1);

    current = new Date("2026-07-12T00:00:01.000Z");
    await expect(
      boundary.resolveRequest(new Request(`${publicOrigin}/`, { headers: { cookie } })),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(budget.snapshot().used.activeAllocations).toBe(0);
    await boundary.close();
  });

  it("rejects a mismatched stored browser admission budget before allocation", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const admit = vi.spyOn(browserSessions, "admit");
    const boundary = createStoredModeBoundary({
      browserSessions,
      createBudgetScope: () => new BudgetScope({ operation: "browser.session.other" }),
    });

    const response = await boundary.app.request(`${publicOrigin}/v1/browser/session`);

    expect(response.status).not.toBe(200);
    expect(admit).not.toHaveBeenCalled();
    await boundary.close();
  });

  it("gates readiness on the startup expiry cleanup", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    let finishCleanup: (() => void) | undefined;
    const deleteExpired = vi.spyOn(browserSessions, "deleteExpired").mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finishCleanup = () => resolve(0);
        }),
    );
    const boundary = createBoundary({ browserSessions });

    const response = boundary.app.request(`${publicOrigin}/v1/browser/session`);
    await vi.waitFor(() => expect(deleteExpired).toHaveBeenCalledTimes(1));
    finishCleanup?.();
    await expect(response).resolves.toMatchObject({ status: 200 });
    await boundary.close();
  });

  it("does not sweep stores that declare native expiry", async () => {
    const browserSessions = Object.assign(new InMemoryBrowserSessionStore(), {
      expiryMode: "native" as const,
    });
    const oauthStates = Object.assign(new InMemoryOAuthStateStore(), {
      expiryMode: "native" as const,
    });
    const authChallenges = Object.assign(new InMemoryShortCacheStore(), {
      expiryMode: "native" as const,
    });
    const deleteExpiredSessions = vi.spyOn(browserSessions, "deleteExpired");
    const deleteExpiredStates = vi.spyOn(oauthStates, "deleteExpired");
    const deleteExpiredChallenges = vi.spyOn(authChallenges, "deleteExpired");
    const boundary = createBoundary({ browserSessions, oauthStates, authChallenges });

    await boundary.ready;

    expect(deleteExpiredSessions).not.toHaveBeenCalled();
    expect(deleteExpiredStates).not.toHaveBeenCalled();
    expect(deleteExpiredChallenges).not.toHaveBeenCalled();
    await boundary.close();
  });

  it("creates a stateless anonymous session with a signed host cookie and hashed CSRF", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const boundary = createBoundary({ browserSessions });

    const response = await boundary.app.request(`${publicOrigin}/v1/browser/session`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ authenticated: false, csrfToken: expect.any(String) });
    expect(payload).not.toHaveProperty("data");
    const cookie = requiredCookie(response);
    expect(cookie).toContain("__Host-activityplug=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");

    const context = await boundary.resolveRequest(
      new Request(`${publicOrigin}/v1/browser/session`, {
        headers: { cookie: cookiePair(cookie) },
      }),
    );
    expect(context.browserSession.authenticated).toBe(false);
    expect(context.browserSession.csrfTokenHash).toBe(
      createHash("sha256").update(payload.csrfToken).digest("base64url"),
    );
    expect(JSON.stringify(context.browserSession)).not.toContain(payload.csrfToken);
    expect(cookie).not.toContain(context.browserSession.id);
  });

  it("rejects a stateless anonymous cookie at its signed expiry", async () => {
    let current = new Date("2026-07-12T00:00:00.000Z");
    const boundary = createBoundary({
      now: () => current,
      sessionTtlMilliseconds: 1_000,
    });
    const anonymous = await anonymousSession(boundary);

    current = new Date("2026-07-12T00:00:01.000Z");

    await expect(
      boundary.resolveRequest(
        new Request(`${publicOrigin}/`, { headers: { cookie: anonymous.cookie } }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("reissues a signed stateless cookie through stored admission during rollback", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const stateless = createBoundary({ browserSessions });
    const anonymous = await anonymousSession(stateless);
    const statelessContext = await stateless.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: anonymous.cookie } }),
    );
    await expect(browserSessions.get(statelessContext.browserSession.id)).resolves.toBeNull();

    const stored = createStoredModeBoundary({ browserSessions });
    const response = await stored.app.request(`${publicOrigin}/v1/browser/session`, {
      headers: { cookie: anonymous.cookie },
    });
    const storedCookie = cookiePair(requiredCookie(response));

    expect(response.status).toBe(200);
    await expect(browserSessions.get(statelessContext.browserSession.id)).resolves.toBeNull();
    expect(decodeCookiePayload(storedCookie)).not.toBe(statelessContext.browserSession.id);
    await expect(
      stored.resolveRequest(new Request(`${publicOrigin}/`, { headers: { cookie: storedCookie } })),
    ).resolves.toMatchObject({ browserSession: { authenticated: false } });
  });

  it("recovers an authenticated session from a legacy stored opaque cookie in stateless mode", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const stored = createStoredModeBoundary({ authSessions, browserSessions });
    const anonymous = await anonymousSession(stored);
    const context = await stored.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: anonymous.cookie } }),
    );
    await authSessions.create(storedSession());
    expect(
      await browserSessions.compareAndSet(
        context.browserSession.id,
        context.browserSession.revision,
        {
          ...context.browserSession,
          authenticated: true,
          activityPlugSessionId: "upstream-session-secret",
          revision: context.browserSession.revision + 1,
        },
      ),
    ).toBe(true);

    const stateless = createBoundary({ authSessions, browserSessions });
    const response = await stateless.app.request(`${publicOrigin}/v1/browser/session`, {
      headers: { cookie: anonymous.cookie },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      adapter: "mastodon",
      account: { username: "alice" },
    });
    expect(JSON.parse(decodeCookiePayload(cookiePair(requiredCookie(response))))).toMatchObject({
      v: 1,
      id: context.browserSession.id,
    });
  });

  it("rejects a CSRF token issued for a different anonymous cookie before service work", async () => {
    const start = vi.fn(async () => {
      throw new Error("service work must not run");
    });
    const boundary = createBoundary({
      service: createTestService({ auth: { ...createTestService().auth, start } }),
    });
    const first = await anonymousSession(boundary);
    const second = await anonymousSession(boundary);

    const response = await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: first.cookie,
        "x-activityplug-csrf": second.csrfToken,
      },
      body: JSON.stringify({
        kind: "oauth",
        adapter: "mastodon",
        origin: "https://social.example",
        returnTo: "/home",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN", requestId: expect.any(String) },
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps one server-bound CSRF token valid across browser tabs and cross-site GETs", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const boundary = createBoundary({ browserSessions });
    const first = await anonymousSession(boundary);

    const [firstTab, secondTab] = await Promise.all([
      boundary.app.request(`${publicOrigin}/v1/browser/session`, {
        headers: { cookie: first.cookie },
      }),
      boundary.app.request(`${publicOrigin}/v1/browser/session`, {
        headers: { cookie: first.cookie },
      }),
    ]);
    const crossSite = await boundary.app.request(`${publicOrigin}/v1/browser/session`, {
      headers: {
        cookie: first.cookie,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });

    await expect(firstTab.json()).resolves.toEqual({
      authenticated: false,
      csrfToken: first.csrfToken,
    });
    await expect(secondTab.json()).resolves.toEqual({
      authenticated: false,
      csrfToken: first.csrfToken,
    });
    await expect(crossSite.json()).resolves.toEqual({
      authenticated: false,
      csrfToken: first.csrfToken,
    });
    expect(crossSite.headers.get("access-control-allow-origin")).toBeNull();

    const context = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: first.cookie } }),
    );
    expect(context.browserSession.csrfTokenHash).toBe(
      createHash("sha256").update(first.csrfToken).digest("base64url"),
    );
  });

  it("migrates legacy random CSRF hashes with CAS before returning the stable token", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const boundary = createBoundary({ browserSessions });
    const anonymous = await anonymousSession(boundary);
    const context = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: anonymous.cookie } }),
    );
    expect(await browserSessions.create(context.browserSession)).toBe(true);
    expect(
      await browserSessions.compareAndSet(
        context.browserSession.id,
        context.browserSession.revision,
        {
          ...context.browserSession,
          csrfTokenHash: createHash("sha256").update("legacy-csrf-token").digest("base64url"),
          revision: context.browserSession.revision + 1,
        },
      ),
    ).toBe(true);

    const migrated = await boundary.app.request(`${publicOrigin}/v1/browser/session`, {
      headers: { cookie: anonymous.cookie },
    });
    const payload = (await migrated.json()) as { readonly csrfToken: string };
    const refreshed = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: anonymous.cookie } }),
    );

    expect(payload.csrfToken).toBe(anonymous.csrfToken);
    expect(refreshed.browserSession.csrfTokenHash).toBe(
      createHash("sha256").update(payload.csrfToken).digest("base64url"),
    );
  });

  it("resolves authenticated sessions without exposing the ActivityPlug session id", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const boundary = createBoundary({ authSessions, browserSessions });
    const anonymous = await anonymousSession(boundary);
    const context = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: anonymous.cookie } }),
    );
    expect(await browserSessions.create(context.browserSession)).toBe(true);
    await authSessions.create(storedSession());
    expect(
      await browserSessions.compareAndSet(
        context.browserSession.id,
        context.browserSession.revision,
        {
          ...context.browserSession,
          authenticated: true,
          activityPlugSessionId: "upstream-session-secret",
          revision: context.browserSession.revision + 1,
        },
      ),
    ).toBe(true);

    const response = await boundary.app.request(`${publicOrigin}/v1/browser/session`, {
      headers: { cookie: anonymous.cookie },
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      authenticated: true,
      adapter: "mastodon",
      origin: "https://social.example",
      account: { username: "alice" },
    });
    expect(text).not.toContain("upstream-session-secret");
    expect(text).not.toContain("access-secret");
    expect(text).not.toContain('"raw"');
  });
});

describe("browser boundary public origin", () => {
  it("accepts HTTP loopback origins for development and serves them end to end", async () => {
    for (const origin of ["http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000"]) {
      const boundary = createDefaultModeBoundary({ publicOrigin: origin });
      const response = await boundary.app.request(`${origin}/v1/browser/session`, {
        headers: { origin },
      });
      expect(response.status).toBe(200);
      await boundary.close();
    }
  });

  it("rejects HTTP loopback origins once the boundary opts out", () => {
    expect(() =>
      createDefaultModeBoundary({
        publicOrigin: "http://localhost:4000",
        allowInsecureLoopback: false,
      }),
    ).toThrow("Browser public origin must be an absolute HTTPS origin.");
  });

  it("rejects non-loopback HTTP origins even when loopback is allowed", () => {
    expect(() =>
      createDefaultModeBoundary({
        publicOrigin: "http://product.example",
        allowInsecureLoopback: true,
      }),
    ).toThrow("Browser public origin must be an absolute HTTPS origin or an HTTP loopback origin.");
  });
});

describe("browser boundary authentication", () => {
  it("promotes a stateless anonymous session only when authentication starts", async () => {
    const browserSessions = new InMemoryBrowserSessionStore();
    const admit = vi.spyOn(browserSessions, "admit");
    const start = vi.fn(async ({ state }: { readonly state: string }) => oauthStartPayload(state));
    const base = createTestService();
    const boundary = createBoundary({
      browserSessions,
      service: createTestService({ auth: { ...base.auth, start } }),
    });
    const anonymous = await anonymousSession(boundary);

    expect(admit).not.toHaveBeenCalled();
    const response = await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "oauth",
        adapter: "mastodon",
        origin: "https://social.example",
        returnTo: "/home",
      }),
    });

    expect(response.status).toBe(200);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0]?.[0]).toMatchObject({ authenticated: false });
  });

  it.each([
    "https://social.example/path",
    "https://social.example?tenant=one",
    "https://social.example#account",
  ])("rejects a non-origin remote server URL exactly: %s", async (origin) => {
    const start = vi.fn(async () => oauthStartPayload("state"));
    const base = createTestService();
    const boundary = createBoundary({
      service: createTestService({ auth: { ...base.auth, start } }),
    });
    const anonymous = await anonymousSession(boundary);

    const response = await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "oauth",
        adapter: "mastodon",
        origin,
        returnTo: "/home",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(start).not.toHaveBeenCalled();
  });

  it("binds HackersPub email challenges to the initiating anonymous session", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const start = vi.fn(async () => ({
      challengeId: "remote-email-challenge",
      expiresAt: "2099-07-12T01:00:00.000Z",
    }));
    const verify = vi.fn(async () => {
      await authSessions.create(storedSession("emailChallenge"));
      return publicSession("emailChallenge");
    });
    const base = createTestService();
    const boundary = createBoundary({
      authSessions,
      service: createTestService({
        auth: {
          ...base.auth,
          emailChallenge: { start, verify },
        },
      }),
    });
    const anonymous = await anonymousSession(boundary);

    const started = await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "emailChallenge",
        adapter: "hackerspub",
        origin: "https://social.example",
        email: "alice@example.test",
      }),
    });
    const startPayload = (await started.json()) as {
      readonly kind: string;
      readonly challengeId: string;
      readonly expiresAt: string;
    };

    expect(started.status).toBe(200);
    expect(startPayload).toMatchObject({
      kind: "emailChallenge",
      challengeId: expect.any(String),
      expiresAt: "2099-07-12T01:00:00.000Z",
    });
    expect(startPayload).not.toHaveProperty("data");
    expect(startPayload.challengeId).not.toBe("remote-email-challenge");
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: "hackerspub",
        origin: "https://social.example",
        identifier: "alice@example.test",
        verificationUriTemplate: `${publicOrigin}/{?token,code}`,
        signal: expect.any(AbortSignal),
      }),
    );

    const complete = () =>
      boundary.app.request(`${publicOrigin}/v1/browser/auth/complete`, {
        method: "POST",
        headers: jsonHeaders(anonymous),
        body: JSON.stringify({
          kind: "emailChallenge",
          challengeId: startPayload.challengeId,
          code: "123456",
        }),
      });
    const completions = await Promise.all([complete(), complete()]);
    const completed = completions.find((response) => response.status === 200);
    const replay = completions.find((response) => response.status !== 200);
    if (completed === undefined || replay === undefined) {
      throw new Error("expected one successful and one rejected concurrent completion");
    }
    const completeText = await completed.text();
    expect(completed.status).toBe(200);
    expect(JSON.parse(completeText)).toMatchObject({
      authenticated: true,
      strategy: "emailChallenge",
      account: { username: "alice" },
    });
    expect(JSON.parse(completeText)).not.toHaveProperty("data");
    expect(completeText).not.toContain("remote-email-challenge");
    expect(completeText).not.toContain("upstream-session-secret");
    expect(completeText).not.toContain('"raw"');
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: "hackerspub",
        origin: "https://social.example",
        challengeId: "remote-email-challenge",
        code: "123456",
        signal: expect.any(AbortSignal),
      }),
    );

    expect(replay.status).toBe(401);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("routes passkey ceremonies through typed server primitives without credential leakage", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const start = vi.fn(async () => ({
      challengeId: "remote-passkey-challenge",
      options: {
        challenge: "public-webauthn-challenge",
        rpId: "social.example",
        userVerification: "preferred" as const,
      },
      expiresAt: "2099-07-12T01:00:00.000Z",
    }));
    const finish = vi.fn(async () => {
      await authSessions.create(storedSession("passkey"));
      return publicSession("passkey");
    });
    const base = createTestService();
    const boundary = createBoundary({
      authSessions,
      service: createTestService({
        auth: { ...base.auth, passkey: { start, finish } },
      }),
    });
    const anonymous = await anonymousSession(boundary);
    const started = await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "passkey",
        adapter: "hackerspub",
        origin: "https://social.example",
        email: "alice@example.test",
      }),
    });
    const startPayload = (await started.json()) as { readonly challengeId: string };
    expect(started.status).toBe(200);
    expect(startPayload).not.toHaveProperty("raw");

    const credential = passkeyCredential();
    Reflect.deleteProperty(credential, "clientExtensionResults");
    const completed = await boundary.app.request(`${publicOrigin}/v1/browser/auth/complete`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({ kind: "passkey", challengeId: startPayload.challengeId, credential }),
    });

    expect(completed.status).toBe(200);
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: "hackerspub",
        origin: "https://social.example",
        challengeId: "remote-passkey-challenge",
        credential: { ...credential, clientExtensionResults: {} },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(await completed.text()).not.toContain("access-secret");
  });

  it("retries email hydration from a pending session without replaying the one-shot code", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const start = vi.fn(async () => ({
      challengeId: "remote-email-challenge",
      expiresAt: "2099-07-12T01:00:00.000Z",
    }));
    let proofConsumed = false;
    const verify = vi.fn(async () => {
      if (proofConsumed) throw new Error("email proof must be consumed only once");
      proofConsumed = true;
      await authSessions.create(storedSession("emailChallenge"));
      return publicSession("emailChallenge");
    });
    let viewerAttempt = 0;
    const viewer = vi.fn(async ({ sessionId }: { readonly sessionId: string }) => {
      viewerAttempt += 1;
      if (viewerAttempt === 1) {
        throw new ActivityPlugError("NETWORK_ERROR", "temporary hydration failure");
      }
      return {
        account: testViewerAccount,
        session: { ...publicSession("emailChallenge"), id: sessionId },
      };
    });
    const base = createTestService();
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      service: createTestService({
        auth: { ...base.auth, emailChallenge: { start, verify } },
        viewer,
      }),
    });
    const anonymous = await anonymousSession(boundary);
    const started = await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "emailChallenge",
        adapter: "hackerspub",
        origin: "https://social.example",
        email: "alice@example.test",
      }),
    });
    const challengeId = ((await started.json()) as { readonly challengeId: string }).challengeId;
    const complete = () =>
      boundary.app.request(`${publicOrigin}/v1/browser/auth/complete`, {
        method: "POST",
        headers: jsonHeaders(anonymous),
        body: JSON.stringify({ kind: "emailChallenge", challengeId, code: "123456" }),
      });

    const failed = await complete();
    expect(failed.status).toBe(502);
    const afterFailure = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: anonymous.cookie } }),
    );
    expect(afterFailure.browserSession.authenticated).toBe(false);
    await expect(authSessions.get("upstream-session-secret")).resolves.not.toBeNull();

    const retried = await complete();
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("retries passkey hydration without replaying the one-shot assertion", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const start = vi.fn(async () => ({
      challengeId: "remote-passkey-challenge",
      options: { challenge: "public-challenge" },
      expiresAt: "2099-07-12T01:00:00.000Z",
    }));
    let proofConsumed = false;
    const finish = vi.fn(async () => {
      if (proofConsumed) throw new Error("passkey proof must be consumed only once");
      proofConsumed = true;
      await authSessions.create(storedSession("passkey"));
      return publicSession("passkey");
    });
    let viewerAttempt = 0;
    const viewer = vi.fn(async ({ sessionId }: { readonly sessionId: string }) => {
      viewerAttempt += 1;
      if (viewerAttempt === 1) {
        throw new ActivityPlugError("NETWORK_ERROR", "temporary hydration failure");
      }
      return {
        account: testViewerAccount,
        session: { ...publicSession("passkey"), id: sessionId },
      };
    });
    const base = createTestService();
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      service: createTestService({
        auth: { ...base.auth, passkey: { start, finish } },
        viewer,
      }),
    });
    const anonymous = await anonymousSession(boundary);
    const started = await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "passkey",
        adapter: "hackerspub",
        origin: "https://social.example",
      }),
    });
    const challengeId = ((await started.json()) as { readonly challengeId: string }).challengeId;
    const complete = () =>
      boundary.app.request(`${publicOrigin}/v1/browser/auth/complete`, {
        method: "POST",
        headers: jsonHeaders(anonymous),
        body: JSON.stringify({
          kind: "passkey",
          challengeId,
          credential: passkeyCredential(),
        }),
      });

    expect((await complete()).status).toBe(502);
    const retried = await complete();
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("claims OAuth state once and redirects only to the bound same-origin return path", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const challengeCache = new InMemoryShortCacheStore();
    const deleteChallenge = vi.fn((key: string) => challengeCache.delete(key));
    let state = "";
    const start = vi.fn(async (input: { readonly state: string }) => {
      state = input.state;
      return {
        client: {
          clientId: "remote-client-id",
          clientSecret: "remote-client-secret",
          redirectUris: [`${publicOrigin}/v1/browser/auth/callback`],
        },
        authorization: {
          url: new URL(`https://social.example/oauth/authorize?state=${input.state}`),
          state: input.state,
          codeVerifier: "server-only-code-verifier",
        },
        callbackBinding: {
          adapter: "mastodon",
          origin: "https://social.example",
          clientRequestId: "request-1",
        },
      };
    });
    const exchange = vi.fn(async () => {
      await authSessions.create(storedSession("oauth"));
      return publicSession("oauth");
    });
    const base = createTestService();
    const boundary = createBoundary({
      authSessions,
      authChallenges: {
        get: (key) => challengeCache.get(key),
        take: (key) => challengeCache.take(key),
        set: (key, value, expiresAt) => challengeCache.set(key, value, expiresAt),
        delete: deleteChallenge,
      },
      service: createTestService({ auth: { ...base.auth, start, exchange } }),
    });
    const anonymous = await anonymousSession(boundary);
    const started = await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "oauth",
        adapter: "mastodon",
        origin: "https://social.example",
        returnTo: "/home?tab=local",
      }),
    });
    const startText = await started.text();
    expect(started.status).toBe(200);
    expect(JSON.parse(startText)).toEqual({
      kind: "oauth",
      redirectUrl: expect.stringContaining("https://social.example/oauth/authorize"),
    });
    expect(startText).not.toContain("remote-client-secret");
    expect(startText).not.toContain("server-only-code-verifier");

    const callback = await boundary.app.request(
      `${publicOrigin}/v1/browser/auth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: anonymous.cookie } },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`${publicOrigin}/home?tab=local`);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(deleteChallenge).toHaveBeenCalledWith(expect.stringMatching(/^browser-oauth:/u));
    await expect(authSessions.get("upstream-session-secret")).resolves.toMatchObject({
      storageExpiresAt: expect.any(String),
      owner: {
        kind: "browser-session",
        id: expect.any(String),
      },
    });

    const replay = await boundary.app.request(
      `${publicOrigin}/v1/browser/auth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: anonymous.cookie } },
    );
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toBe(`${publicOrigin}/`);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("retries OAuth hydration from a pending session without replaying the code exchange", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    let state = "";
    const start = vi.fn(async (input: { readonly state: string }) => {
      state = input.state;
      return {
        client: {
          clientId: "remote-client-id",
          redirectUris: [`${publicOrigin}/v1/browser/auth/callback`],
        },
        authorization: {
          url: new URL(`https://social.example/oauth/authorize?state=${input.state}`),
          state: input.state,
          codeVerifier: "server-only-code-verifier",
        },
        callbackBinding: {
          adapter: "mastodon",
          origin: "https://social.example",
          clientRequestId: "request-1",
        },
      };
    });
    let proofConsumed = false;
    const exchange = vi.fn(async () => {
      if (proofConsumed) throw new Error("OAuth code must be consumed only once");
      proofConsumed = true;
      await authSessions.create(storedSession("oauth"));
      return publicSession("oauth");
    });
    let viewerAttempt = 0;
    const viewer = vi.fn(async ({ sessionId }: { readonly sessionId: string }) => {
      viewerAttempt += 1;
      if (viewerAttempt === 1) {
        throw new ActivityPlugError("NETWORK_ERROR", "temporary hydration failure");
      }
      return {
        account: testViewerAccount,
        session: { ...publicSession("oauth"), id: sessionId },
      };
    });
    const base = createTestService();
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      service: createTestService({ auth: { ...base.auth, start, exchange }, viewer }),
    });
    const anonymous = await anonymousSession(boundary);
    await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "oauth",
        adapter: "mastodon",
        origin: "https://social.example",
        returnTo: "/home",
      }),
    });
    const callbackUrl = `${publicOrigin}/v1/browser/auth/callback?code=code-1&state=${encodeURIComponent(state)}`;

    const failedHydration = await boundary.app.request(callbackUrl, {
      headers: { cookie: anonymous.cookie },
    });
    expect(failedHydration.status).toBe(303);
    expect(failedHydration.headers.get("location")).toBe(`${publicOrigin}/home`);
    await expect(authSessions.get("upstream-session-secret")).resolves.not.toBeNull();

    const retried = await boundary.app.request(callbackUrl, {
      headers: { cookie: anonymous.cookie },
    });
    expect(retried.status).toBe(303);
    expect(retried.headers.get("location")).toBe(`${publicOrigin}/home`);
    expect(exchange).toHaveBeenCalledTimes(1);
    const requestContext = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: anonymous.cookie } }),
    );
    expect(requestContext.browserSession.authenticated).toBe(true);
  });

  it("redirects cleanly when OAuth metadata or state stores fail", async () => {
    const unavailableCache = createBoundary({
      authChallenges: {
        get: async () => {
          throw new Error("cache unavailable");
        },
        take: async () => null,
        set: async () => undefined,
        delete: async () => undefined,
      },
    });
    const missingState = Buffer.alloc(32, 3).toString("base64url");
    const metadataFailure = await unavailableCache.app.request(
      `${publicOrigin}/v1/browser/auth/callback?code=secret-code&state=${missingState}`,
    );
    expect(metadataFailure.status).toBe(303);
    expect(metadataFailure.headers.get("location")).toBe(`${publicOrigin}/`);
    expect(metadataFailure.headers.get("content-type")).toBeNull();

    const backingStates = new InMemoryOAuthStateStore();
    let state = "";
    const start = vi.fn(async (input: { readonly state: string }) => {
      state = input.state;
      return oauthStartPayload(input.state);
    });
    const base = createTestService();
    const claimFailure = createBoundary({
      oauthStates: {
        create: (record) => backingStates.create(record),
        claim: async () => {
          throw new Error("state store unavailable");
        },
        consume: (claim) => backingStates.consume(claim),
        release: (claim) => backingStates.release(claim),
        deleteExpired: (expiredAt) => backingStates.deleteExpired(expiredAt),
      },
      service: createTestService({ auth: { ...base.auth, start } }),
    });
    const anonymous = await anonymousSession(claimFailure);
    await claimFailure.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "oauth",
        adapter: "mastodon",
        origin: "https://social.example",
        returnTo: "/home",
      }),
    });
    const claimResponse = await claimFailure.app.request(
      `${publicOrigin}/v1/browser/auth/callback?code=secret-code&state=${state}`,
      { headers: { cookie: anonymous.cookie } },
    );
    expect(claimResponse.status).toBe(303);
    expect(claimResponse.headers.get("location")).toBe(`${publicOrigin}/home`);
    expect(claimResponse.headers.get("content-type")).toBeNull();
  });

  it("keeps the attached auth session when OAuth cleanup fails after browser CAS", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const backingStates = new InMemoryOAuthStateStore();
    let state = "";
    const start = vi.fn(async (input: { readonly state: string }) => {
      state = input.state;
      return oauthStartPayload(input.state);
    });
    const exchange = vi.fn(async () => {
      await authSessions.create(storedSession("oauth"));
      return publicSession("oauth");
    });
    const base = createTestService();
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      oauthStates: {
        create: (record) => backingStates.create(record),
        claim: (stateHash, leaseExpiresAt) => backingStates.claim(stateHash, leaseExpiresAt),
        consume: async () => {
          throw new Error("cleanup unavailable");
        },
        release: (claim) => backingStates.release(claim),
        deleteExpired: (expiredAt) => backingStates.deleteExpired(expiredAt),
      },
      service: createTestService({ auth: { ...base.auth, start, exchange } }),
    });
    const anonymous = await anonymousSession(boundary);
    await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "oauth",
        adapter: "mastodon",
        origin: "https://social.example",
        returnTo: "/home",
      }),
    });

    const callback = await boundary.app.request(
      `${publicOrigin}/v1/browser/auth/callback?code=code-1&state=${state}`,
      { headers: { cookie: anonymous.cookie } },
    );

    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`${publicOrigin}/home`);
    await expect(authSessions.get("upstream-session-secret")).resolves.not.toBeNull();
    const requestContext = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: anonymous.cookie } }),
    );
    expect(requestContext.browserSession.authenticated).toBe(true);
  });

  it("rejects cross-origin OAuth return targets before service work", async () => {
    const start = vi.fn();
    const base = createTestService();
    const boundary = createBoundary({
      service: createTestService({ auth: { ...base.auth, start } }),
    });
    const anonymous = await anonymousSession(boundary);
    const response = await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "oauth",
        adapter: "mastodon",
        origin: "https://social.example",
        returnTo: "https://evil.example/steal",
      }),
    });
    expect(response.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores spoofable proxy IP headers unless a trusted resolver is configured", async () => {
    const take = vi.fn(async () => ({ allowed: true as const }));
    const base = createTestService();
    const service = createTestService({
      auth: {
        ...base.auth,
        emailChallenge: {
          ...base.auth.emailChallenge,
          start: async () => ({
            challengeId: "remote-email-challenge",
            expiresAt: "2099-07-12T01:00:00.000Z",
          }),
        },
      },
    });
    const untrusted = createBoundary({ service, authStartLimiter: { take } });
    const first = await anonymousSession(untrusted);
    await untrusted.app.fetch(
      new Request(`${publicOrigin}/v1/browser/auth/start`, {
        method: "POST",
        headers: {
          ...jsonHeaders(first),
          "x-forwarded-for": "203.0.113.44",
          "x-real-ip": "203.0.113.45",
        },
        body: JSON.stringify({
          kind: "emailChallenge",
          adapter: "hackerspub",
          origin: "https://social.example",
          email: "alice@example.test",
        }),
      }),
      { incoming: { socket: { remoteAddress: "203.0.113.10" } } },
    );
    expect(take).toHaveBeenLastCalledWith(expect.objectContaining({ clientIp: "203.0.113.10" }));

    const trustedTake = vi.fn(async () => ({ allowed: true as const }));
    const trusted = createBoundary({
      service,
      authStartLimiter: { take: trustedTake },
      clientIp: (request, peerAddress) => {
        expect(peerAddress).toBe("203.0.113.10");
        return request.headers.get("x-forwarded-for") ?? "unknown";
      },
    });
    const second = await anonymousSession(trusted);
    await trusted.app.fetch(
      new Request(`${publicOrigin}/v1/browser/auth/start`, {
        method: "POST",
        headers: { ...jsonHeaders(second), "x-forwarded-for": "203.0.113.44" },
        body: JSON.stringify({
          kind: "emailChallenge",
          adapter: "hackerspub",
          origin: "https://social.example",
          email: "alice@example.test",
        }),
      }),
      { incoming: { socket: { remoteAddress: "203.0.113.10" } } },
    );
    expect(trustedTake).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientIp: "203.0.113.44" }),
    );
  });

  it("fails closed when a remote challenge cannot be stored", async () => {
    const base = createTestService();
    const boundary = createBoundary({
      service: createTestService({
        auth: {
          ...base.auth,
          emailChallenge: {
            ...base.auth.emailChallenge,
            start: async () => ({
              challengeId: "remote-email-challenge",
              expiresAt: "2099-07-12T01:00:00.000Z",
            }),
          },
        },
      }),
      authChallenges: {
        get: async () => null,
        take: async () => null,
        set: async () => {
          throw new Error("cache unavailable");
        },
        delete: async () => undefined,
      },
    });
    const anonymous = await anonymousSession(boundary);

    const response = await boundary.app.request(`${publicOrigin}/v1/browser/auth/start`, {
      method: "POST",
      headers: jsonHeaders(anonymous),
      body: JSON.stringify({
        kind: "emailChallenge",
        adapter: "hackerspub",
        origin: "https://social.example",
        email: "alice@example.test",
      }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "UPSTREAM_FAILURE",
        message: "Authentication challenge could not be stored.",
      },
    });
  });
});

describe("browser boundary authenticated routes", () => {
  it("derives timeline authority from the cookie and returns recursive raw-free DTOs", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const home = vi.fn();
    const base = createTestService();
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      service: createTestService({
        timelines: {
          ...base.timelines,
          home: async (input) => {
            home(input);
            return {
              nodes: [
                {
                  ref: createEntityRef({
                    adapter: "mastodon",
                    origin: "https://social.example",
                    type: "post",
                    id: "post-1",
                  }),
                  author: { ...testViewerAccount, raw: { accessToken: "nested-secret" } },
                  contentHtml: "<p>Hello</p>",
                  createdAt: "2026-07-12T00:00:00.000Z",
                  visibility: "public",
                  sensitive: false,
                  media: [],
                  raw: { accessToken: "post-secret" },
                },
              ],
              pageInfo: {
                hasNextPage: true,
                hasPreviousPage: false,
                endCursor: "next-page",
              },
            };
          },
        },
      }),
    });
    const session = await authenticateBrowser(boundary, authSessions, browserSessions);

    const response = await boundary.app.request(
      `${publicOrigin}/v1/browser/api/timelines/home?cursor=current&limit=20`,
      { headers: { cookie: session.cookie } },
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      data: {
        posts: [{ contentHtml: "<p>Hello</p>", author: { username: "alice" } }],
        pageInfo: { nextCursor: "next-page" },
      },
    });
    expect(text).not.toContain('"raw"');
    expect(text).not.toContain("nested-secret");
    expect(home).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "upstream-session-secret",
        page: { after: "current", limit: 20 },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("passes attachment-only, reply-only, and quote-only posts to the service", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const base = createTestService();
    const create = vi.fn(base.posts.create);
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      service: createTestService({ posts: { ...base.posts, create } }),
    });
    const session = await authenticateBrowser(boundary, authSessions, browserSessions);

    const mediaOnly = await boundary.app.request(`${publicOrigin}/v1/browser/api/posts`, {
      method: "POST",
      headers: jsonHeaders(session),
      body: JSON.stringify({ content: "", mediaIds: ["media-1", "media-1"] }),
    });
    const replyOnly = await boundary.app.request(`${publicOrigin}/v1/browser/api/posts`, {
      method: "POST",
      headers: jsonHeaders(session),
      body: JSON.stringify({ content: " ", replyToId: "post-1" }),
    });
    const quoteOnly = await boundary.app.request(`${publicOrigin}/v1/browser/api/posts`, {
      method: "POST",
      headers: jsonHeaders(session),
      body: JSON.stringify({ content: "\n", quoteOfId: "post-2" }),
    });

    expect(mediaOnly.status).toBe(200);
    expect(replyOnly.status).toBe(200);
    expect(quoteOnly.status).toBe(200);
    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: "",
        mediaIds: ["media-1", "media-1"],
        sessionId: "upstream-session-secret",
      }),
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: " ", replyToId: "post-1" }),
    );
    expect(create).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ content: "\n", quoteOfId: "post-2" }),
    );
  });

  it("rejects blank posts and malformed media IDs before service work", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const base = createTestService();
    const create = vi.fn(base.posts.create);
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      service: createTestService({ posts: { ...base.posts, create } }),
    });
    const session = await authenticateBrowser(boundary, authSessions, browserSessions);
    const post = (body: unknown) =>
      boundary.app.request(`${publicOrigin}/v1/browser/api/posts`, {
        method: "POST",
        headers: jsonHeaders(session),
        body: JSON.stringify(body),
      });

    const blank = await post({ content: " ", mediaIds: [] });
    const blankMediaId = await post({ content: "", mediaIds: [" "] });
    const nonStringMediaId = await post({ content: "", mediaIds: [42] });
    const nonArrayMediaIds = await post({ content: "", mediaIds: "media-1" });

    expect(blank.status).toBe(400);
    await expect(blank.json()).resolves.toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Post creation requires text, media, a reply target, or a quote target.",
      },
    });
    expect(blankMediaId.status).toBe(400);
    expect(nonStringMediaId.status).toBe(400);
    expect(nonArrayMediaIds.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("revokes and deletes both server-side sessions before expiring the cookie", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const budget = new BudgetScope({
      operation: "browser.session.admit",
      limits: { activeAllocations: 1 },
    });
    const revokeSession = vi.fn(async ({ sessionId }: { readonly sessionId: string }) => {
      const stored = await authSessions.get(sessionId);
      if (stored !== null) await authSessions.compareAndDelete(sessionId, stored.revision);
    });
    const base = createTestService();
    const boundary = createStoredModeBoundary({
      authSessions,
      browserSessions,
      createBudgetScope: () => budget,
      service: createTestService({ auth: { ...base.auth, revokeSession } }),
    });
    const session = await authenticateBrowser(boundary, authSessions, browserSessions);
    expect(budget.snapshot().used.activeAllocations).toBe(1);
    const before = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: session.cookie } }),
    );

    const response = await boundary.app.request(`${publicOrigin}/v1/browser/logout`, {
      method: "POST",
      headers: jsonHeaders(session),
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true });
    expect(revokeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "upstream-session-secret",
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(authSessions.get("upstream-session-secret")).resolves.toBeNull();
    await expect(browserSessions.get(before.browserSession.id)).resolves.toBeNull();
    expect(budget.snapshot().used.activeAllocations).toBe(0);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("expires the cookie and deletes auth state when browser-session cleanup fails", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const boundary = createBoundary({ authSessions, browserSessions });
    const session = await authenticateBrowser(boundary, authSessions, browserSessions);
    vi.spyOn(browserSessions, "delete").mockRejectedValueOnce(
      new Error("browser-session cleanup unavailable"),
    );

    const response = await boundary.app.request(`${publicOrigin}/v1/browser/logout`, {
      method: "POST",
      headers: jsonHeaders(session),
      body: "{}",
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(authSessions.get("upstream-session-secret")).resolves.toBeNull();
  });

  it("expires the cookie and deletes browser state when auth cleanup fails", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const boundary = createBoundary({ authSessions, browserSessions });
    const session = await authenticateBrowser(boundary, authSessions, browserSessions);
    const before = await boundary.resolveRequest(
      new Request(`${publicOrigin}/`, { headers: { cookie: session.cookie } }),
    );
    vi.spyOn(authSessions, "compareAndDelete").mockRejectedValueOnce(
      new Error("auth-session cleanup unavailable"),
    );

    const response = await boundary.app.request(`${publicOrigin}/v1/browser/logout`, {
      method: "POST",
      headers: jsonHeaders(session),
      body: "{}",
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(browserSessions.get(before.browserSession.id)).resolves.toBeNull();
  });

  it("exchanges stream tickets once and passes the request AbortSignal to the service", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const notifications = vi.fn(async (_input: { readonly signal?: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "heartbeat" as const, stream: "notifications" as const };
      },
    }));
    const base = createTestService();
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      service: createTestService({
        streams: { ...base.streams, notifications },
      }),
    });
    const session = await authenticateBrowser(boundary, authSessions, browserSessions);
    const issued = await boundary.app.request(`${publicOrigin}/v1/browser/stream-tickets`, {
      method: "POST",
      headers: jsonHeaders(session),
      body: JSON.stringify({ operation: "stream.notifications" }),
    });
    const issuedBody = (await issued.json()) as { readonly data: { readonly ticket: string } };
    expect(issued.status).toBe(200);

    const streamed = await boundary.app.request(
      `${publicOrigin}/v1/browser/stream?ticket=${encodeURIComponent(issuedBody.data.ticket)}`,
      { headers: { cookie: session.cookie } },
    );
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(notifications).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "upstream-session-secret",
        signal: expect.any(AbortSignal),
      }),
    );
    const streamSignal = notifications.mock.calls[0]?.[0]?.signal;
    await streamed.body?.cancel("browser disconnected");
    expect(streamSignal?.aborted).toBe(true);
    expect(streamSignal?.reason).toBe("browser disconnected");

    const replay = await boundary.app.request(
      `${publicOrigin}/v1/browser/stream?ticket=${encodeURIComponent(issuedBody.data.ticket)}`,
      { headers: { cookie: session.cookie } },
    );
    expect(replay.status).toBe(401);
  });

  it("hydrates canonical profile posts, pagination, and supported relationship state", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const posts = vi.fn(async () => ({
      nodes: [],
      pageInfo: {
        hasNextPage: true,
        hasPreviousPage: false,
        endCursor: "profile-next",
      },
    }));
    const relationship = vi.fn(async () => ({
      account: testViewerAccount.ref,
      following: false,
      followedBy: true,
      requested: true,
      blocking: false,
      muting: false,
      raw: { accessToken: "relationship-secret" },
    }));
    const follow = vi.fn(async () => ({ ...(await relationship()), following: true }));
    const base = createTestService();
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      service: createTestService({
        capabilities: () =>
          createCapabilitySet({ "accounts.relationships": capability("supported") }),
        accounts: { ...base.accounts, posts },
        social: { ...base.social, relationship, follow },
      }),
    });
    const session = await authenticateBrowser(boundary, authSessions, browserSessions);

    const profile = await boundary.app.request(
      `${publicOrigin}/v1/browser/api/profiles/${encodeURIComponent(testViewerAccount.ref.id)}?cursor=profile-current&limit=10`,
      { headers: { cookie: session.cookie } },
    );
    const profileText = await profile.text();
    expect(profile.status).toBe(200);
    expect(JSON.parse(profileText)).toMatchObject({
      data: {
        profile: { username: "alice" },
        posts: [],
        pageInfo: { nextCursor: "profile-next" },
        relationship: { following: false, followedBy: true, requested: true },
      },
    });
    expect(profileText).not.toContain("relationship-secret");
    expect(posts).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "upstream-session-secret",
        page: { after: "profile-current", limit: 10 },
        signal: expect.any(AbortSignal),
      }),
    );

    const followed = await boundary.app.request(
      `${publicOrigin}/v1/browser/api/profiles/${encodeURIComponent(testViewerAccount.ref.id)}/follow`,
      { method: "POST", headers: jsonHeaders(session), body: "{}" },
    );
    expect(followed.status).toBe(200);
    await expect(followed.json()).resolves.toMatchObject({
      data: {
        profile: { username: "alice" },
        posts: [],
        pageInfo: { nextCursor: "profile-next" },
        relationship: { requested: true },
      },
    });
  });

  it("includes named raw-free hashtags in search results", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const base = createTestService();
    const search = vi.fn(
      async (
        _input: Parameters<typeof base.search.search>[0] & { readonly signal?: AbortSignal },
      ) => ({
        accounts: [],
        posts: [],
        hashtags: [
          {
            name: "activitypub",
            url: "https://social.example/tags/activitypub",
            history: [{ day: "2026-07-12", uses: 12, accounts: 4, raw: { secret: true } }],
            raw: { accessToken: "hashtag-secret" },
          },
        ],
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
        raw: { accessToken: "search-secret" },
      }),
    );
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      service: createTestService({ search: { ...base.search, search } }),
    });
    const session = await authenticateBrowser(boundary, authSessions, browserSessions);
    const controller = new AbortController();

    const response = await boundary.app.request(
      new Request(`${publicOrigin}/v1/browser/api/search?q=activityplug&type=all`, {
        headers: { cookie: session.cookie },
        signal: controller.signal,
      }),
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      data: {
        hashtags: [
          {
            name: "activitypub",
            history: [{ day: "2026-07-12", uses: 12, accounts: 4 }],
          },
        ],
      },
    });
    expect(text).not.toContain('"raw"');
    expect(text).not.toContain("hashtag-secret");
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const serviceSignal = search.mock.calls[0]?.[0]?.signal as AbortSignal;
    controller.abort("client disconnected");
    expect(serviceSignal.aborted).toBe(true);
    expect(serviceSignal.reason).toBe("client disconnected");
  });

  it("terminates aborted requests without writing a JSON error envelope", async () => {
    const authSessions = new InMemoryAuthSessionStore();
    const browserSessions = new InMemoryBrowserSessionStore();
    const base = createTestService();
    const search = vi.fn(
      async (
        input: Parameters<typeof base.search.search>[0] & { readonly signal?: AbortSignal },
      ) => {
        input.signal?.throwIfAborted();
        return base.search.search(input);
      },
    );
    const boundary = createBoundary({
      authSessions,
      browserSessions,
      service: createTestService({ search: { ...base.search, search } }),
    });
    const session = await authenticateBrowser(boundary, authSessions, browserSessions);
    const controller = new AbortController();
    const request = new Request(`${publicOrigin}/v1/browser/api/search?q=activityplug`, {
      headers: { cookie: session.cookie },
      signal: controller.signal,
    });
    controller.abort(new DOMException("client disconnected", "AbortError"));

    const response = await boundary.app.request(request);

    expect(response.status).toBe(499);
    expect(response.headers.get("content-type")).toBeNull();
    await expect(response.text()).resolves.toBe("");
  });
});

function createBoundary(overrides: Partial<Parameters<typeof createBrowserBoundary>[0]> = {}) {
  return createBrowserBoundary({
    anonymousSessionMode: "stateless",
    ...boundaryOptions(overrides),
  });
}

function createDefaultModeBoundary(
  overrides: Partial<Parameters<typeof createBrowserBoundary>[0]> = {},
) {
  return createBrowserBoundary(boundaryOptions(overrides));
}

function createStoredModeBoundary(
  overrides: Partial<Parameters<typeof createBrowserBoundary>[0]> = {},
) {
  return createBrowserBoundary({
    anonymousSessionMode: "stored",
    ...boundaryOptions(overrides),
  });
}

function boundaryOptions(
  overrides: Partial<Parameters<typeof createBrowserBoundary>[0]> = {},
): Parameters<typeof createBrowserBoundary>[0] {
  return {
    publicOrigin,
    cookieSigningKey,
    service: createTestService({
      capabilities: () => createCapabilitySet(),
      viewer: async ({ sessionId }) => ({
        account: testViewerAccount,
        session: {
          id: sessionId,
          adapter: "mastodon",
          origin: "https://social.example",
          strategy: "oauth",
          scopes: ["read", "write"],
          capabilities: {},
        },
      }),
    }),
    authSessions: new InMemoryAuthSessionStore(),
    browserSessions: new InMemoryBrowserSessionStore(),
    oauthStates: new InMemoryOAuthStateStore(),
    streamTickets: new InMemoryStreamTicketStore(),
    authStartLimiter: new InMemoryOAuthStartLimiter(),
    authChallenges: new InMemoryShortCacheStore(),
    ...overrides,
  };
}

async function anonymousSession(boundary: ReturnType<typeof createBrowserBoundary>) {
  const response = await boundary.app.request(`${publicOrigin}/v1/browser/session`);
  const payload = (await response.json()) as { readonly csrfToken: string };
  return { cookie: cookiePair(requiredCookie(response)), csrfToken: payload.csrfToken };
}

async function authenticateBrowser(
  boundary: ReturnType<typeof createBrowserBoundary>,
  authSessions: InMemoryAuthSessionStore,
  browserSessions: InMemoryBrowserSessionStore,
) {
  const anonymous = await anonymousSession(boundary);
  const context = await boundary.resolveRequest(
    new Request(`${publicOrigin}/`, { headers: { cookie: anonymous.cookie } }),
  );
  if (
    (await browserSessions.get(context.browserSession.id)) === null &&
    !(await browserSessions.create(context.browserSession))
  ) {
    throw new Error("failed to promote browser test session");
  }
  await authSessions.create(storedSession());
  const transitioned = await browserSessions.compareAndSet(
    context.browserSession.id,
    context.browserSession.revision,
    {
      ...context.browserSession,
      authenticated: true,
      activityPlugSessionId: "upstream-session-secret",
      revision: context.browserSession.revision + 1,
    },
  );
  if (!transitioned) throw new Error("failed to authenticate browser test session");
  return anonymous;
}

function requiredCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (cookie === null) throw new Error("expected a Set-Cookie header");
  return cookie;
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

function decodeCookiePayload(cookie: string): string {
  const value = cookie.split("=", 2)[1];
  const encoded = value?.split(".", 1)[0];
  if (encoded === undefined) throw new Error("expected a signed browser cookie");
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function storedSession(
  strategy: "oauth" | "emailChallenge" | "passkey" = "oauth",
): StoredAuthSession {
  return {
    id: "upstream-session-secret",
    adapter: strategy === "oauth" ? "mastodon" : "hackerspub",
    origin: "https://social.example",
    strategy,
    scopes: ["read", "write"],
    capabilities: {},
    tokenSet: { accessToken: "access-secret" },
    account: createEntityRef({
      adapter: strategy === "oauth" ? "mastodon" : "hackerspub",
      origin: "https://social.example",
      type: "account",
      id: "alice",
    }),
    revision: 0,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

function publicSession(strategy: "oauth" | "emailChallenge" | "passkey") {
  return {
    id: "upstream-session-secret",
    adapter: strategy === "oauth" ? "mastodon" : "hackerspub",
    origin: "https://social.example",
    strategy,
    scopes: ["read", "write"],
    capabilities: {},
  } as const;
}

function jsonHeaders(session: { readonly cookie: string; readonly csrfToken: string }) {
  return {
    "content-type": "application/json",
    cookie: session.cookie,
    "x-activityplug-csrf": session.csrfToken,
  };
}

function passkeyCredential() {
  return {
    id: "credential-id",
    rawId: "credential-raw-id",
    type: "public-key" as const,
    response: {
      clientDataJSON: "client-data",
      authenticatorData: "authenticator-data",
      signature: "signature",
    },
    clientExtensionResults: {},
  };
}

function oauthStartPayload(state: string) {
  return {
    client: {
      clientId: "remote-client-id",
      redirectUris: [`${publicOrigin}/v1/browser/auth/callback`],
    },
    authorization: {
      url: new URL(`https://social.example/oauth/authorize?state=${state}`),
      state,
      codeVerifier: "server-only-code-verifier",
    },
    callbackBinding: {
      adapter: "mastodon",
      origin: "https://social.example",
      clientRequestId: "request-1",
    },
  };
}
