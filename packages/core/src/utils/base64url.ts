import { ActivityPlugError } from "../errors/error.js";

export function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return encodeBinary(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function decodeBase64UrlUtf8(value: string): string {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = decodeBinary(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function encodeBinary(bytes: Uint8Array): string {
  const btoa = globalThis.btoa;
  if (btoa === undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "A base64 encoder is required for ActivityPlug IDs.",
      { operation: "base64url.encode" },
    );
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCodePoint(...bytes.slice(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBinary(value: string): string {
  const atob = globalThis.atob;
  if (atob === undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "A base64 decoder is required for ActivityPlug IDs.",
      { operation: "base64url.decode" },
    );
  }
  return atob(value);
}
