export function createClientUuid(crypto: Crypto = globalThis.crypto): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [
    hex(bytes, 0, 4),
    hex(bytes, 4, 6),
    hex(bytes, 6, 8),
    hex(bytes, 8, 10),
    hex(bytes, 10, 16),
  ].join("-");
}

function hex(bytes: Uint8Array, start: number, end: number): string {
  let output = "";
  for (let index = start; index < end; index += 1) {
    output += bytes[index].toString(16).padStart(2, "0");
  }
  return output;
}
