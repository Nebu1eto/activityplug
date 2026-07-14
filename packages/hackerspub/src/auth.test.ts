import { createActivityPlugClient } from "@activityplug/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHackersPubAdapter } from "./index.js";

const now = new Date("2026-07-12T00:00:00.000Z");

describe("HackersPub challenge auth strategies", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes email challenge and passkey flows without exposing remote session tokens", async () => {
    const requests: Array<{ readonly query: string; readonly variables: Record<string, unknown> }> =
      [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as {
        readonly query: string;
        readonly variables: Record<string, unknown>;
      };
      requests.push(body);
      if (body.query.includes("loginByEmail")) {
        return Response.json({
          data: {
            loginByEmail: {
              __typename: "LoginChallenge",
              token: "00000000-0000-4000-8000-000000000100",
              created: "2026-07-12T00:00:00.000Z",
            },
          },
        });
      }
      if (body.query.includes("completeLoginChallenge")) {
        return Response.json({
          data: { completeLoginChallenge: { id: "00000000-0000-4000-8000-000000000101" } },
        });
      }
      if (body.query.includes("getPasskeyAuthenticationOptions")) {
        return Response.json({
          data: {
            getPasskeyAuthenticationOptions: {
              challenge: "challenge-base64url",
              timeout: 60_000,
              rpId: "hackerspub.example",
              allowCredentials: [
                { id: "credential-id", type: "public-key", transports: ["internal", "usb"] },
              ],
              userVerification: "preferred",
              serverSecret: "must-not-leak",
            },
          },
        });
      }
      return Response.json({
        data: { loginByPasskey: { id: "00000000-0000-4000-8000-000000000102" } },
      });
    });
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch,
    });

    const emailStart = await client.auth.emailChallenge.start({
      identifier: "person@example.test",
      locale: "ko-KR",
      verificationUriTemplate: "https://client.example/verify{?token,code}",
    });
    const emailSession = await client.auth.emailChallenge.verify({
      challengeId: emailStart.challengeId,
      code: "ABC123",
    });
    const passkeyStart = await client.auth.passkey.start({});
    const passkeySession = await client.auth.passkey.finish({
      challengeId: passkeyStart.challengeId,
      credential: {
        id: "credential-id",
        rawId: "credential-id",
        type: "public-key",
        response: {
          clientDataJSON: "client-data",
          authenticatorData: "authenticator-data",
          signature: "signature",
        },
        clientExtensionResults: {},
        serverSecret: "credential-secret",
      } as never,
    });

    expect(emailStart).toEqual({
      challengeId: "00000000-0000-4000-8000-000000000100",
      expiresAt: "2026-07-12T12:00:00.000Z",
    });
    expect(passkeyStart).toEqual({
      challengeId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expiresAt: "2026-07-12T00:05:00.000Z",
      options: {
        challenge: "challenge-base64url",
        timeout: 60_000,
        rpId: "hackerspub.example",
        allowCredentials: [
          { id: "credential-id", type: "public-key", transports: ["internal", "usb"] },
        ],
        userVerification: "preferred",
      },
    });
    expect(requests[0]?.variables).toEqual({
      email: "person@example.test",
      locale: "ko-KR",
      verifyUrl: "https://client.example/verify{?token,code}",
    });
    expect(requests[2]?.variables).toEqual({ sessionId: passkeyStart.challengeId });
    expect(requests[3]?.variables).toEqual({
      sessionId: passkeyStart.challengeId,
      authenticationResponse: expect.objectContaining({ id: "credential-id" }),
    });
    expect(JSON.stringify(requests[3]?.variables)).not.toContain("credential-secret");
    expect(
      JSON.stringify({ emailSession, passkeySession, emailStart, passkeyStart }),
    ).not.toContain("00000000-0000-4000-8000-000000000101");
    expect(
      JSON.stringify({ emailSession, passkeySession, emailStart, passkeyStart }),
    ).not.toContain("00000000-0000-4000-8000-000000000102");
    expect(JSON.stringify(passkeyStart)).not.toContain("serverSecret");
  });

  it("rejects malformed passkey options as a bounded protocol error", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        Response.json({
          data: {
            getPasskeyAuthenticationOptions: {
              challenge: "challenge",
              allowCredentials: [
                { id: "credential-id", type: "public-key", transports: ["serial"] },
              ],
              secret: "must-not-leak",
            },
          },
        }),
    });

    await expect(client.auth.passkey.start({})).rejects.toMatchObject({
      code: "REMOTE_PROTOCOL_ERROR",
      context: {
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        operation: "auth.passkey.start",
        raw: { field: "allowCredentials[0].transports[0]" },
      },
    });
  });

  it("rejects non-ISO email challenge timestamps", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        Response.json({
          data: {
            loginByEmail: {
              __typename: "LoginChallenge",
              token: "00000000-0000-4000-8000-000000000100",
              created: "0",
            },
          },
        }),
    });

    await expect(
      client.auth.emailChallenge.start({
        identifier: "person@example.test",
        verificationUriTemplate: "https://client.example/verify{?token,code}",
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_PROTOCOL_ERROR",
      context: expect.objectContaining({ raw: { field: "loginByEmail.created" } }),
    });
  });

  it("maps rejected and expired remote challenges to typed auth failures", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const body = (await new Request(input, init).json()) as { readonly query: string };
        if (body.query.includes("loginByEmail")) {
          return Response.json({
            data: { loginByEmail: { __typename: "AccountNotFoundError", query: "hidden" } },
          });
        }
        return Response.json({ data: { loginByPasskey: null } });
      },
    });

    await expect(
      client.auth.emailChallenge.start({
        identifier: "missing@example.test",
        verificationUriTemplate: "https://client.example/verify{?token,code}",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      client.auth.passkey.finish({
        challengeId: "00000000-0000-4000-8000-000000000100",
        credential: {
          id: "credential-id",
          rawId: "credential-id",
          type: "public-key",
          response: {
            clientDataJSON: "client-data",
            authenticatorData: "authenticator-data",
            signature: "signature",
          },
          clientExtensionResults: {},
        },
      }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
