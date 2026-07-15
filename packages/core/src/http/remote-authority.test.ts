import { describe, expect, it, vi } from "vitest";

import { BudgetScope } from "../security/budget.js";
import { setRequestBudget } from "../security/request-budget.js";
import { createBrowserRemoteAuthority, createRemoteAuthority } from "./remote-authority.js";

describe("remote authority", () => {
  it("allows same-origin requests and delegates only after authorization", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    const authority = createRemoteAuthority({ transport });

    const response = await authority.fetch(
      "https://social.example/api/v1/accounts",
      { headers: { authorization: "Bearer secret" } },
      {
        destination: "HTTPS://SOCIAL.EXAMPLE:443",
        credentialIssuer: "https://social.example",
        operation: "account.get",
        credentialClass: "oauth-access-token",
      },
    );

    expect(await response.text()).toBe("ok");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("requires a directional grant for split-origin credentials", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    const denied = createRemoteAuthority({ transport });
    const request = {
      destination: "https://api.example",
      credentialIssuer: "https://issuer.example",
      operation: "account.get",
      credentialClass: "oauth-access-token",
    } as const;

    await expect(
      denied.fetch(
        "https://api.example/account",
        { headers: { authorization: "Bearer secret" } },
        request,
      ),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(transport).not.toHaveBeenCalled();

    const granted = createRemoteAuthority({
      transport,
      credentialGrants: [
        {
          issuer: "https://issuer.example",
          recipient: "https://api.example",
          operation: "account.get",
          credentialClass: "oauth-access-token",
          representations: ["authorization-header"],
        },
      ],
    });
    await expect(
      granted.fetch(
        "https://api.example/account",
        { headers: { authorization: "Bearer secret" } },
        request,
      ),
    ).resolves.toBeInstanceOf(Response);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("does not apply directional grants in reverse", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    const authority = createRemoteAuthority({
      transport,
      credentialGrants: [
        {
          issuer: "https://issuer.example",
          recipient: "https://api.example",
          operation: "account.get",
          credentialClass: "oauth-access-token",
          representations: ["authorization-header"],
        },
      ],
    });

    await expect(
      authority.fetch(
        "https://issuer.example/account",
        { headers: { authorization: "Bearer secret" } },
        {
          destination: "https://issuer.example",
          credentialIssuer: "https://api.example",
          operation: "account.get",
          credentialClass: "oauth-access-token",
        },
      ),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    {
      operation: "account.lookup",
      credentialClass: "oauth-access-token",
    },
    {
      operation: "account.get",
      credentialClass: "oauth-client-credential",
    },
  ])(
    "requires an exact operation and credential class grant match",
    async ({ operation, credentialClass }) => {
      const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
      const authority = createRemoteAuthority({
        transport,
        credentialGrants: [
          {
            issuer: "https://issuer.example",
            recipient: "https://api.example",
            operation: "account.get",
            credentialClass: "oauth-access-token",
            representations: ["authorization-header"],
          },
        ],
      });

      await expect(
        authority.fetch(
          "https://api.example/account",
          { headers: { authorization: "Bearer secret" } },
          {
            destination: "https://api.example",
            credentialIssuer: "https://issuer.example",
            operation,
            credentialClass,
          },
        ),
      ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    { representation: "form-body" as const, key: "PaSsWoRd" },
    { representation: "form-body" as const, key: "CLIENT%5FASSERTION" },
    { representation: "form-body" as const, key: "assertion" },
    { representation: "json-body" as const, key: "PaSsWoRd" },
    { representation: "json-body" as const, key: "CLIENT_ASSERTION" },
    { representation: "json-body" as const, key: "Assertion" },
    { representation: "json-body" as const, key: "ID_TOKEN" },
    { representation: "json-body" as const, key: "device_code" },
    { representation: "json-body" as const, key: "Subject_Token" },
  ])(
    "rejects exact OAuth credential key $key in $representation",
    async ({ representation, key }) => {
      const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
      const authority = createRemoteAuthority({ transport });
      const body =
        representation === "form-body"
          ? `${key}=secret`
          : JSON.stringify({ public: { nested: [{ [key]: "secret" }] } });

      await expect(
        authority.fetch(
          "https://api.example/oauth/token",
          {
            method: "POST",
            headers: {
              "content-type":
                representation === "form-body"
                  ? "application/x-www-form-urlencoded"
                  : "application/json",
            },
            body,
          },
          {
            destination: "https://api.example",
            credentialIssuer: "https://issuer.example",
            operation: "oauth.exchange",
            credentialClass: "oauth-client-credential",
          },
        ),
      ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://other.example/account",
    "https://social.example/account?access_token=secret",
    "https://user:secret@social.example/account",
  ])("rejects an unauthorized target or URL credential before network I/O", async (url) => {
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    const authority = createRemoteAuthority({ transport });

    await expect(
      authority.fetch(url, undefined, {
        destination: "https://social.example",
        credentialIssuer: "https://social.example",
        operation: "account.get",
        credentialClass: "oauth-access-token",
      }),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["ClIeNt_SeCrEt", "%72efresh%5Ftoken", "CODE%5FVERIFIER", "%63ode", "STATE"])(
    "rejects case-insensitive and encoded OAuth query credentials: %s",
    async (key) => {
      const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
      const authority = createRemoteAuthority({ transport });

      await expect(
        authority.fetch(`https://social.example/account?${key}=secret`, undefined, {
          destination: "https://social.example",
          credentialIssuer: "https://social.example",
          operation: "account.get",
          credentialClass: "oauth-access-token",
        }),
      ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("allows exact-key near matches and non-secret OAuth query parameters", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    const authority = createRemoteAuthority({ transport });

    await expect(
      authority.fetch(
        "https://social.example/account?client_secret_hint=x&refresh_tokens=x&code_challenge=x&client_id=x&page_token=x&stateful=x",
        undefined,
        {
          destination: "https://social.example",
          credentialIssuer: "https://social.example",
          operation: "account.get",
          credentialClass: "oauth-access-token",
        },
      ),
    ).resolves.toBeInstanceOf(Response);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    {
      contentType: "application/x-www-form-urlencoded",
      body: "client_id=public&ClIeNt%5FSeCrEt=secret",
      representation: "form-body" as const,
    },
    {
      contentType: "application/json",
      body: JSON.stringify({ public: { nested: [{ ReFrEsH_ToKeN: "secret" }] } }),
      representation: "json-body" as const,
    },
  ])(
    "requires a directional $representation grant for split-origin body credentials",
    async ({ contentType, body, representation }) => {
      const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
      const scopedRequest = {
        destination: "https://api.example",
        credentialIssuer: "https://issuer.example",
        operation: "oauth.exchange",
        credentialClass: "oauth-client-credential",
      } as const;
      const init = { method: "POST", headers: { "content-type": contentType }, body };

      await expect(
        createRemoteAuthority({ transport }).fetch(
          "https://api.example/oauth/token",
          init,
          scopedRequest,
        ),
      ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
      expect(transport).not.toHaveBeenCalled();

      const wrongRepresentation = createRemoteAuthority({
        transport,
        credentialGrants: [
          {
            issuer: "https://issuer.example",
            recipient: "https://api.example",
            operation: "oauth.exchange",
            credentialClass: "oauth-client-credential",
            representations: [representation === "form-body" ? "json-body" : "form-body"],
          },
        ],
      });
      await expect(
        wrongRepresentation.fetch("https://api.example/oauth/token", init, scopedRequest),
      ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
      expect(transport).not.toHaveBeenCalled();

      const granted = createRemoteAuthority({
        transport,
        credentialGrants: [
          {
            issuer: "https://issuer.example",
            recipient: "https://api.example",
            operation: "oauth.exchange",
            credentialClass: "oauth-client-credential",
            representations: [representation],
          },
        ],
      });
      await expect(
        granted.fetch("https://api.example/oauth/token", init, scopedRequest),
      ).resolves.toBeInstanceOf(Response);
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      contentType: "application/x-www-form-urlencoded",
      body: "client_secret_hint=x&refresh_tokens=x&code_challenge=x&client_id=x&passwordless=true&client_assertion_type=jwt",
    },
    {
      contentType: "application/activity+json",
      body: JSON.stringify({
        tokenized: true,
        nested: [{ stateful: "x", passwordless: true, assertions: [] }],
        passwordPolicy: "strong",
        verificationCode: "public-label",
      }),
    },
  ])("allows split-origin bodies without exact credential keys", async ({ contentType, body }) => {
    const transport = vi.fn<typeof fetch>(async (request) => {
      expect(await new Request(request).text()).toBe(body);
      return new Response("ok");
    });
    const authority = createRemoteAuthority({ transport });

    await expect(
      authority.fetch(
        "https://api.example/inbox",
        { method: "POST", headers: { "content-type": contentType }, body },
        {
          destination: "https://api.example",
          credentialIssuer: "https://issuer.example",
          operation: "activity.publish",
          credentialClass: "oauth-access-token",
        },
      ),
    ).resolves.toBeInstanceOf(Response);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "an unknown content type",
      headers: new Headers({ "content-type": "application/octet-stream" }),
      body: "client_secret=secret",
    },
    {
      label: "an oversized supported body",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ padding: "x".repeat(64 * 1024), access_token: "secret" }),
    },
    {
      label: "a body with an oversized declared length",
      headers: new Headers({ "content-length": "65537", "content-type": "application/json" }),
      body: JSON.stringify({ access_token: "secret" }),
    },
    {
      label: "a malformed supported body",
      headers: new Headers({ "content-type": "application/json" }),
      body: '{"public":',
    },
  ])("rejects $label before split-origin network I/O", async ({ headers, body }) => {
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    const authority = createRemoteAuthority({ transport });

    await expect(
      authority.fetch(
        "https://api.example/oauth/token",
        { method: "POST", headers, body },
        {
          destination: "https://api.example",
          credentialIssuer: "https://issuer.example",
          operation: "oauth.exchange",
          credentialClass: "oauth-client-credential",
        },
      ),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("preserves same-origin bundled OAuth bodies without consuming the request", async () => {
    const body = JSON.stringify({ client_secret: "secret", padding: "x".repeat(64 * 1024) });
    const transport = vi.fn<typeof fetch>(async (request) => {
      expect(await new Request(request).text()).toBe(body);
      return new Response("ok");
    });
    const authority = createRemoteAuthority({ transport });

    await expect(
      authority.fetch(
        "https://issuer.example/oauth/token",
        { method: "POST", headers: { "content-type": "application/json" }, body },
        {
          destination: "https://issuer.example",
          credentialIssuer: "https://issuer.example",
          operation: "oauth.exchange",
          credentialClass: "oauth-client-credential",
        },
      ),
    ).resolves.toBeInstanceOf(Response);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("honors an explicit same-origin body representation restriction", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    const authority = createRemoteAuthority({
      transport,
      sameOriginRepresentations: ["authorization-header", "cookie-header"],
    });

    await expect(
      authority.fetch(
        "https://issuer.example/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_secret: "secret" }),
        },
        {
          destination: "https://issuer.example",
          credentialIssuer: "https://issuer.example",
          operation: "oauth.exchange",
          credentialClass: "oauth-client-credential",
        },
      ),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { dimension: "reads" as const, limits: { reads: 0 } },
    { dimension: "bytes" as const, limits: { reads: 1, bytes: 0 } },
  ])(
    "charges credential inspection against a zero $dimension budget before transport",
    async ({ dimension, limits }) => {
      const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
      const budget = new BudgetScope({ operation: "oauth.exchange", limits });
      const request = setRequestBudget(
        new Request("https://api.example/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ public: true }),
        }),
        budget,
      );

      await expect(
        createRemoteAuthority({ transport }).fetch(request, undefined, {
          destination: "https://api.example",
          credentialIssuer: "https://issuer.example",
          operation: "oauth.exchange",
          credentialClass: "oauth-client-credential",
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_LIMIT_EXCEEDED",
        dimension,
        limit: 0,
      });
      expect(transport).not.toHaveBeenCalled();
      expect(budget.snapshot().used[dimension]).toBe(0);
    },
  );

  it("charges successful inspection chunks to the inherited request budget", async () => {
    const body = JSON.stringify({ public: true });
    const budget = new BudgetScope({
      operation: "activity.publish",
      limits: { reads: 2, bytes: 64 },
    });
    const request = setRequestBudget(
      new Request("https://api.example/inbox", {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body,
      }),
      budget,
    );
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));

    await expect(
      createRemoteAuthority({ transport }).fetch(request, undefined, {
        destination: "https://api.example",
        credentialIssuer: "https://issuer.example",
        operation: "activity.publish",
        credentialClass: "oauth-access-token",
      }),
    ).resolves.toBeInstanceOf(Response);
    expect(budget.snapshot().used.reads).toBe(1);
    expect(budget.snapshot().used.bytes).toBe(new TextEncoder().encode(body).byteLength);
  });

  it("aborts a never-settling credential inspection and cancels its source", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    let markPullStarted: (() => void) | undefined;
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve;
    });
    const source = new ReadableStream<Uint8Array>({
      pull() {
        markPullStarted?.();
        return new Promise<void>(() => undefined);
      },
      cancel,
    });
    const abortController = new AbortController();
    const reason = new TypeError("caller cancelled");
    const request = new Request("https://api.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: source,
      duplex: "half",
      signal: abortController.signal,
    } as RequestInit);
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    const pending = createRemoteAuthority({ transport }).fetch(request, undefined, {
      destination: "https://api.example",
      credentialIssuer: "https://issuer.example",
      operation: "oauth.exchange",
      credentialClass: "oauth-client-credential",
    });

    await pullStarted;
    const rejected = expect(pending).rejects.toBe(reason);
    abortController.abort(reason);

    await rejected;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(transport).not.toHaveBeenCalled();
  });

  it("cancels both inspection branches after a streamed body exceeds 64 KiB", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(40 * 1024));
      },
      cancel,
    });
    const request = new Request("https://api.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: source,
      duplex: "half",
    } as RequestInit);
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));

    await expect(
      createRemoteAuthority({ transport }).fetch(request, undefined, {
        destination: "https://api.example",
        credentialIssuer: "https://issuer.example",
        operation: "oauth.exchange",
        credentialClass: "oauth-client-credential",
      }),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects raw global fetch as a generic authority transport", () => {
    expect(() => createRemoteAuthority({ transport: globalThis.fetch })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("authorizes WebSocket credentials only for an exact directional grant", () => {
    const authority = createRemoteAuthority({
      transport: async () => new Response("ok"),
      credentialGrants: [
        {
          issuer: "https://issuer.example",
          recipient: "https://stream.example",
          operation: "stream.notifications",
          credentialClass: "oauth-access-token",
          representations: ["websocket-subprotocol"],
        },
      ],
    });

    expect(() =>
      authority.assertCredentialAllowed?.({
        destination: "https://stream.example",
        credentialIssuer: "https://issuer.example",
        recipient: "https://stream.example",
        operation: "stream.notifications",
        credentialClass: "oauth-access-token",
        representation: "websocket-subprotocol",
      }),
    ).not.toThrow();
    expect(() =>
      authority.assertCredentialAllowed?.({
        destination: "https://stream.example",
        credentialIssuer: "https://issuer.example",
        recipient: "https://stream.example",
        operation: "stream.timeline",
        credentialClass: "oauth-access-token",
        representation: "websocket-subprotocol",
      }),
    ).toThrowError(expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }));
  });

  it.each([
    {
      destination: "https://api.example",
      credentialIssuer: "https://issuer.example",
      sameOriginRepresentations: ["authorization-header", "cookie-header"] as const,
    },
    {
      destination: "https://api.example",
      credentialIssuer: "https://api.example",
      sameOriginRepresentations: ["authorization-header"] as const,
    },
  ])(
    "omits ambient browser cookies when the destination or representation is not authorized",
    async ({ destination, credentialIssuer, sameOriginRepresentations }) => {
      const transport = vi.fn<typeof fetch>(async (request) => {
        expect(new Request(request).credentials).toBe("omit");
        return new Response("ok");
      });
      vi.stubGlobal("window", {});
      vi.stubGlobal("fetch", transport);
      try {
        const authority = createBrowserRemoteAuthority({ sameOriginRepresentations });
        await authority.fetch(
          `${destination}/account`,
          { credentials: "include" },
          {
            destination,
            credentialIssuer,
            operation: "account.get",
            credentialClass: "oauth-access-token",
          },
        );
        expect(transport).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
