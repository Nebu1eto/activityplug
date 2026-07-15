import {
  createRemoteAuthority,
  type RemoteAuthority,
  type RemoteCredentialGrant,
} from "@activityplug/core";

export interface ServerRemoteAuthorityOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly credentialGrants?: readonly RemoteCredentialGrant[];
}

const authorities = new WeakMap<typeof globalThis.fetch, RemoteAuthority>();

/** Binds the server's vetted, DNS-pinned transport to the portable authority contract. */
export function createServerRemoteAuthority(
  options: ServerRemoteAuthorityOptions,
): RemoteAuthority {
  if (options.credentialGrants === undefined) {
    const existing = authorities.get(options.fetch);
    if (existing !== undefined) return existing;
  }
  const authority = createRemoteAuthority({
    transport: options.fetch,
    ...(options.credentialGrants === undefined
      ? {}
      : { credentialGrants: options.credentialGrants }),
  });
  if (options.credentialGrants === undefined) authorities.set(options.fetch, authority);
  return authority;
}
