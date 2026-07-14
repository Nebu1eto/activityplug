import { ActivityPlugError, canonicalizeOrigin, type OriginPolicy } from "@activityplug/core";

export function createOriginPolicy(allowedOrigins: readonly string[]): OriginPolicy {
  const allowed = new Set(allowedOrigins.map((origin) => canonicalizePolicyOrigin(origin)));
  return {
    assertAllowed: async (origin, operation) => {
      const canonicalOrigin = canonicalizePolicyOrigin(origin, operation);
      if (allowed.has(canonicalOrigin)) return;
      throw originNotAllowed(canonicalOrigin, operation);
    },
  };
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
