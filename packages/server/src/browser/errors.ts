import { randomUUID } from "node:crypto";

import { isActivityPlugError, type ActivityPlugError } from "@activityplug/core";
import { type Context } from "hono";

import { type BrowserErrorCode, type BrowserErrorEnvelope } from "./types.js";

export class BrowserBoundaryError extends Error {
  public constructor(
    public readonly code: BrowserErrorCode,
    message: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502,
    public readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrowserBoundaryError";
  }
}

export function browserErrorResponse(context: Context, error: unknown): Response {
  const normalized = normalizeBrowserError(error);
  if (normalized.retryAfterSeconds !== undefined) {
    context.header("retry-after", String(normalized.retryAfterSeconds));
  }
  const body: BrowserErrorEnvelope = {
    error: {
      code: normalized.code,
      message: normalized.message,
      requestId: randomUUID(),
      ...(normalized.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: normalized.retryAfterSeconds }),
    },
  };
  return context.json(body, normalized.status);
}

export function isAbortFailure(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function normalizeBrowserError(error: unknown): BrowserBoundaryError {
  if (error instanceof BrowserBoundaryError) return error;
  if (isActivityPlugError(error)) return fromActivityPlugError(error);
  if (error instanceof DOMException && error.name === "AbortError") {
    return new BrowserBoundaryError("UPSTREAM_FAILURE", "Request was aborted.", 502);
  }
  return new BrowserBoundaryError("UPSTREAM_FAILURE", "The upstream request failed.", 502);
}

function fromActivityPlugError(error: ActivityPlugError): BrowserBoundaryError {
  switch (error.code) {
    case "VALIDATION_FAILED":
    case "REQUEST_LIMIT_EXCEEDED":
      return new BrowserBoundaryError("BAD_REQUEST", error.message, 400);
    case "AUTH_REQUIRED":
    case "AUTH_EXPIRED":
      return new BrowserBoundaryError("UNAUTHENTICATED", error.message, 401);
    case "ORIGIN_NOT_ALLOWED":
      return new BrowserBoundaryError("FORBIDDEN", error.message, 403);
    case "ADAPTER_NOT_FOUND":
    case "NOT_FOUND":
      return new BrowserBoundaryError("NOT_FOUND", error.message, 404);
    case "CONFLICT":
      return new BrowserBoundaryError("CONFLICT", error.message, 409);
    case "RATE_LIMITED":
      return new BrowserBoundaryError(
        "RATE_LIMITED",
        error.message,
        429,
        retryAfterSecondsFrom(error),
      );
    case "AUTH_UNSUPPORTED":
    case "CAPABILITY_UNKNOWN":
    case "UNSUPPORTED_OPERATION":
      return new BrowserBoundaryError("UNSUPPORTED", error.message, 422);
    default:
      return new BrowserBoundaryError("UPSTREAM_FAILURE", "The upstream request failed.", 502);
  }
}

function retryAfterSecondsFrom(error: ActivityPlugError): number | undefined {
  const raw = error.context.raw;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = Reflect.get(raw, "retryAfterSeconds");
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
