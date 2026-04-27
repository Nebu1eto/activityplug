import { invalidOpaqueId } from "../errors/error.js";

export type OpaqueId = string & { readonly __activityPlugOpaqueId: unique symbol };

export type RawEntityId<EntityType extends string = string> = {
  readonly adapter: string;
  readonly origin: string;
  readonly type: EntityType;
  readonly id: string;
  readonly rawUrl?: string;
};

const PREFIX = "ap";
const VERSION = "1";

export function encodeOpaqueId(raw: RawEntityId): OpaqueId {
  assertIdPart("adapter", raw.adapter);
  assertIdPart("origin", raw.origin);
  assertIdPart("type", raw.type);
  assertIdPart("id", raw.id);
  const payload = JSON.stringify([raw.adapter, raw.origin, raw.type, raw.id]);
  return `${PREFIX}_${VERSION}_${toBase64Url(payload)}` as OpaqueId;
}

export function decodeOpaqueId(id: unknown): RawEntityId {
  if (typeof id !== "string") {
    throw invalidOpaqueId("Opaque ID must be a string.");
  }
  const [prefix, version, payload, ...rest] = id.split("_");
  if (prefix !== PREFIX || version !== VERSION || payload === undefined || rest.length > 0) {
    throw invalidOpaqueId("Opaque ID has an invalid envelope.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(payload));
  } catch (error) {
    throw invalidOpaqueId("Opaque ID payload is not valid JSON.", { cause: error });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    !parsed.every((part) => typeof part === "string")
  ) {
    throw invalidOpaqueId("Opaque ID payload has an invalid shape.");
  }
  const [adapter, origin, type, rawId] = parsed;
  assertIdPart("adapter", adapter);
  assertIdPart("origin", origin);
  assertIdPart("type", type);
  assertIdPart("id", rawId);
  return { adapter, origin, type, id: rawId };
}

export function createEntityRef<EntityType extends string>(
  raw: RawEntityId<EntityType>,
): {
  readonly id: OpaqueId;
  readonly type: EntityType;
  readonly adapter: string;
  readonly origin: string;
  readonly rawId: string;
  readonly rawUrl?: string;
} {
  return {
    id: encodeOpaqueId(raw),
    type: raw.type,
    adapter: raw.adapter,
    origin: raw.origin,
    rawId: raw.id,
    ...(raw.rawUrl === undefined ? {} : { rawUrl: raw.rawUrl }),
  };
}

function assertIdPart(name: string, value: string): void {
  if (value.length === 0) {
    throw invalidOpaqueId(`Opaque ID ${name} must not be empty.`);
  }
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
