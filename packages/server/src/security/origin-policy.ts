import { ActivityPlugError, canonicalizeOrigin, type OriginPolicy } from "@activityplug/core";

// `URL.hostname` keeps IPv6 hosts bracketed, so the loopback address is listed
// in its bracketed form.
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface OpenOriginPolicyOptions {
  /**
   * Permits HTTP loopback origins in addition to HTTPS origins. Defaults to
   * true unless `NODE_ENV` is `production`.
   */
  readonly allowInsecureLoopback?: boolean;
}

/**
 * Builds a policy that admits any HTTPS origin.
 *
 * Use this when the deployment must reach ActivityPub servers that cannot be
 * enumerated in advance. The policy still rejects non-HTTP schemes, origins
 * carrying credentials or a path, and, outside development, plaintext HTTP.
 * Address-level protections stay in the vetted transport: private, loopback,
 * and link-local addresses remain blocked unless `allowPrivateNetworks` is
 * enabled, and each redirect hop is evaluated again.
 */
export function createOpenOriginPolicy(options: OpenOriginPolicyOptions = {}): OriginPolicy {
  const allowInsecureLoopback = options.allowInsecureLoopback ?? isDevelopmentRuntime();
  return {
    assertAllowed: async (origin, operation) => {
      const canonicalOrigin = canonicalizePolicyOrigin(origin, operation);
      const url = new URL(canonicalOrigin);
      if (url.protocol === "https:") return;
      if (
        allowInsecureLoopback &&
        url.protocol === "http:" &&
        loopbackHostnames.has(url.hostname)
      ) {
        return;
      }
      throw originNotAllowed(canonicalOrigin, operation);
    },
  };
}

/**
 * Builds an exact-match allowlist policy.
 *
 * An empty allowlist yields {@link createOpenOriginPolicy}, so a deployment
 * that names no origin can still reach arbitrary ActivityPub servers.
 */
export function createOriginPolicy(
  allowedOrigins: readonly string[],
  options: OpenOriginPolicyOptions = {},
): OriginPolicy {
  const allowed = new Set(allowedOrigins.map((origin) => canonicalizePolicyOrigin(origin)));
  if (allowed.size === 0) return createOpenOriginPolicy(options);
  return {
    assertAllowed: async (origin, operation) => {
      const canonicalOrigin = canonicalizePolicyOrigin(origin, operation);
      if (allowed.has(canonicalOrigin)) return;
      throw originNotAllowed(canonicalOrigin, operation);
    },
  };
}

function isDevelopmentRuntime(): boolean {
  return process.env["NODE_ENV"] !== "production";
}

function canonicalizePolicyOrigin(origin: string, operation = "server.originPolicy"): string {
  try {
    return canonicalizeOrigin(origin);
  } catch (cause) {
    throw new ActivityPlugError(
      "ORIGIN_NOT_ALLOWED",
      "Remote origin is not allowed by this server.",
      { origin, operation },
      { cause },
    );
  }
}

function originNotAllowed(origin: string, operation: string): ActivityPlugError {
  return new ActivityPlugError(
    "ORIGIN_NOT_ALLOWED",
    "Remote origin is not allowed by this server.",
    { origin, operation },
  );
}
