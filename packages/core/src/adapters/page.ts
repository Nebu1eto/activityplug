import { ActivityPlugError } from "../errors/error.js";
import { decodeBase64UrlUtf8, encodeBase64UrlUtf8 } from "../utils/base64url.js";

export const PORTABLE_PAGE_LIMIT = 100;

/** @deprecated Use `PORTABLE_PAGE_LIMIT`. */
export const maxPageLimit = PORTABLE_PAGE_LIMIT;

const CURSOR_PREFIX = "apc";
const CURSOR_VERSION = "1";

export interface RawPageCursor {
  readonly adapter: string;
  readonly origin: string;
  readonly operation: string;
  readonly cursor: string;
}

export function encodePageCursor(raw: RawPageCursor): string {
  assertCursorPart("adapter", raw.adapter);
  assertCursorPart("origin", raw.origin);
  assertCursorPart("operation", raw.operation);
  assertCursorPart("cursor", raw.cursor);
  return `${CURSOR_PREFIX}_${CURSOR_VERSION}_${encodeBase64UrlUtf8(
    JSON.stringify([raw.adapter, raw.origin, raw.operation, raw.cursor]),
  )}`;
}

export function decodePageCursor(cursor: string, expected: Omit<RawPageCursor, "cursor">): string {
  const envelope = `${CURSOR_PREFIX}_${CURSOR_VERSION}_`;
  if (!cursor.startsWith(envelope)) {
    throw invalidPageCursor(expected, "Page cursor has an invalid envelope.");
  }
  const payload = cursor.slice(envelope.length);
  if (payload.length === 0)
    throw invalidPageCursor(expected, "Page cursor has an invalid envelope.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64UrlUtf8(payload));
  } catch (cause) {
    throw invalidPageCursor(expected, "Page cursor payload is not valid JSON.", cause);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    !parsed.every((part) => typeof part === "string")
  ) {
    throw invalidPageCursor(expected, "Page cursor payload has an invalid shape.");
  }
  const [adapter, origin, operation, rawCursor] = parsed;
  if (
    adapter !== expected.adapter ||
    origin !== expected.origin ||
    operation !== expected.operation
  ) {
    throw invalidPageCursor(expected, "Page cursor does not belong to this operation target.");
  }
  assertCursorPart("cursor", rawCursor);
  return rawCursor;
}

function assertCursorPart(name: string, value: string): void {
  if (value.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", `Page cursor ${name} must not be empty.`);
  }
}

function invalidPageCursor(
  expected: Omit<RawPageCursor, "cursor">,
  message: string,
  cause?: unknown,
): ActivityPlugError {
  return new ActivityPlugError(
    "VALIDATION_FAILED",
    message,
    {
      adapter: expected.adapter,
      origin: expected.origin,
      operation: expected.operation,
    },
    cause === undefined ? undefined : { cause },
  );
}
