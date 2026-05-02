import { ActivityPlugError } from "../errors/error.js";

export function createUuid(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "A Web Crypto implementation is required to create UUIDs.",
      { operation: "crypto.randomUUID" },
    );
  }
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return createUuidFromRandomBytes(crypto);
}

function createUuidFromRandomBytes(crypto: Crypto): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
