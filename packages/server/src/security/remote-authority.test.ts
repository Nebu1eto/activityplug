import { describe, expect, it, vi } from "vitest";

import { createServerRemoteAuthority } from "./remote-authority.js";

describe("server remote authority", () => {
  it("reuses the supplied vetted transport behind the portable contract", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("ok"));
    const authority = createServerRemoteAuthority({ fetch });

    await expect(
      authority.fetch("https://social.example/api", undefined, {
        destination: "https://social.example",
        credentialIssuer: "https://social.example",
        operation: "instance.get",
        credentialClass: "oauth-access-token",
      }),
    ).resolves.toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves directional WebSocket credential grants", () => {
    const authority = createServerRemoteAuthority({
      fetch: async () => new Response("ok"),
      credentialGrants: [
        {
          issuer: "https://social.example",
          recipient: "https://stream.example",
          operation: "stream.timeline",
          credentialClass: "oauth-access-token",
          representations: ["authorization-header"],
        },
      ],
    });

    expect(() =>
      authority.assertCredentialAllowed?.({
        destination: "https://stream.example",
        credentialIssuer: "https://social.example",
        recipient: "https://stream.example",
        operation: "stream.timeline",
        credentialClass: "oauth-access-token",
        representation: "authorization-header",
      }),
    ).not.toThrow();
  });
});
