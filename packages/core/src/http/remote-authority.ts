import { canonicalizeOrigin } from "../adapters/client.js";
import { ActivityPlugError } from "../errors/error.js";
import {
  chargeBodyChunk,
  getRequestBudget,
  inheritRequestBudget,
} from "../security/request-budget.js";

export type RemoteCredentialRepresentation =
  | "authorization-header"
  | "cookie-header"
  | "form-body"
  | "json-body"
  | "websocket-subprotocol";
export type RemoteCredentialClass = string;

export interface RemoteCredentialGrant {
  readonly issuer: string;
  readonly recipient: string;
  readonly operation: string;
  readonly credentialClass: RemoteCredentialClass;
  readonly representations: readonly RemoteCredentialRepresentation[];
}

export interface RemoteAuthorityRequest {
  readonly destination: string;
  readonly credentialIssuer: string;
  readonly operation: string;
  readonly credentialClass: RemoteCredentialClass;
}

export interface RemoteAuthority {
  readonly assertCredentialAllowed?: (
    authority: RemoteAuthorityRequest & {
      readonly recipient: string;
      readonly representation: RemoteCredentialRepresentation;
    },
  ) => void;
  readonly fetch: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    authority: RemoteAuthorityRequest,
  ) => Promise<Response>;
}

export interface RemoteAuthorityOptions {
  readonly transport: typeof globalThis.fetch;
  readonly credentialGrants?: readonly RemoteCredentialGrant[];
  readonly sameOriginRepresentations?: readonly RemoteCredentialRepresentation[];
}

export interface BrowserRemoteAuthorityOptions {
  readonly credentialGrants?: readonly RemoteCredentialGrant[];
  readonly sameOriginRepresentations?: readonly RemoteCredentialRepresentation[];
}

/**
 * Creates an authority around a transport that has already been vetted by its
 * runtime. A raw global fetch is intentionally not accepted here.
 */
export function createRemoteAuthority(options: RemoteAuthorityOptions): RemoteAuthority {
  return createRemoteAuthorityInternal(options, false);
}

/** Creates the only authority that may explicitly use the browser global fetch. */
export function createBrowserRemoteAuthority(
  options: BrowserRemoteAuthorityOptions = {},
): RemoteAuthority {
  if (typeof window === "undefined" || typeof globalThis.fetch !== "function") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Browser remote authority requires a browser fetch runtime.",
      { operation: "remote.authority.create" },
    );
  }
  return createRemoteAuthorityInternal({ ...options, transport: globalThis.fetch }, true);
}

function createRemoteAuthorityInternal(
  options: RemoteAuthorityOptions,
  allowGlobalFetch: boolean,
): RemoteAuthority {
  if (typeof options.transport !== "function") {
    throw invalidAuthority("Remote authority transport must be a function.");
  }
  if (!allowGlobalFetch && options.transport === globalThis.fetch) {
    throw invalidAuthority(
      "Raw global fetch is only available through createBrowserRemoteAuthority().",
    );
  }
  const sameOriginRepresentations = normalizeRepresentations(
    options.sameOriginRepresentations ?? [
      "authorization-header",
      "cookie-header",
      "form-body",
      "json-body",
      "websocket-subprotocol",
    ],
  );
  const grants = (options.credentialGrants ?? []).map(normalizeGrant);

  const isAllowed = (
    issuer: string,
    recipient: string,
    operation: string,
    credentialClass: string,
    representation: RemoteCredentialRepresentation,
  ): boolean =>
    issuer === recipient
      ? sameOriginRepresentations.has(representation)
      : grants.some(
          (grant) =>
            grant.issuer === issuer &&
            grant.recipient === recipient &&
            grant.operation === operation &&
            grant.credentialClass === credentialClass &&
            grant.representations.has(representation),
        );

  return {
    assertCredentialAllowed: (authority) => {
      const issuer = canonicalOrigin(authority.credentialIssuer, authority.operation);
      const recipient = canonicalOrigin(authority.recipient, authority.operation);
      const operation = nonEmptyScope(authority.operation, "operation");
      const credentialClass = nonEmptyScope(authority.credentialClass, "credential class");
      if (!isAllowed(issuer, recipient, operation, credentialClass, authority.representation)) {
        throw denied("Remote credential recipient or representation is not authorized.", authority);
      }
    },
    fetch: async (input, init, authority) => {
      const inputUrl = rawInputUrl(input);
      if (inputUrl !== undefined) assertNoUrlCredentials(inputUrl, authority);
      let request = createRequest(input, init, authority.operation);
      try {
        const destination = canonicalOrigin(authority.destination, authority.operation);
        const issuer = canonicalOrigin(authority.credentialIssuer, authority.operation);
        const operation = nonEmptyScope(authority.operation, "operation");
        const credentialClass = nonEmptyScope(authority.credentialClass, "credential class");
        const recipient = canonicalOrigin(new URL(request.url).origin, authority.operation);
        if (recipient !== destination) {
          throw denied("Remote request target does not match its scoped destination.", authority);
        }
        if (
          allowGlobalFetch &&
          (issuer !== recipient || !sameOriginRepresentations.has("cookie-header")) &&
          request.credentials !== "omit"
        ) {
          request = inheritRequestBudget(new Request(request, { credentials: "omit" }), request);
        }
        assertNoUrlCredentials(new URL(request.url), authority);
        const isRepresentationAllowed = (representation: RemoteCredentialRepresentation): boolean =>
          isAllowed(issuer, recipient, operation, credentialClass, representation);
        for (const representation of await credentialRepresentations(request, {
          failClosedUnknownBody: issuer !== recipient,
          isAllowed: isRepresentationAllowed,
          authority,
        })) {
          const allowed = isRepresentationAllowed(representation);
          if (!allowed) {
            throw denied(
              "Remote credential recipient or representation is not authorized.",
              authority,
            );
          }
        }
      } catch (cause) {
        cancelRequestBody(request, cause);
        throw cause;
      }
      return options.transport(request);
    },
  };
}

function rawInputUrl(input: RequestInfo | URL): URL | undefined {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return undefined;
  }
}

function normalizeGrant(grant: RemoteCredentialGrant): {
  readonly issuer: string;
  readonly recipient: string;
  readonly operation: string;
  readonly credentialClass: RemoteCredentialClass;
  readonly representations: ReadonlySet<RemoteCredentialRepresentation>;
} {
  return {
    issuer: canonicalOrigin(grant.issuer, "remote.authority.create"),
    recipient: canonicalOrigin(grant.recipient, "remote.authority.create"),
    operation: nonEmptyScope(grant.operation, "operation"),
    credentialClass: nonEmptyScope(grant.credentialClass, "credential class"),
    representations: normalizeRepresentations(grant.representations),
  };
}

function nonEmptyScope(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidAuthority(`Remote authority ${name} must not be empty.`);
  }
  return value;
}

function normalizeRepresentations(
  representations: readonly RemoteCredentialRepresentation[],
): ReadonlySet<RemoteCredentialRepresentation> {
  const normalized = new Set<RemoteCredentialRepresentation>();
  for (const representation of representations) {
    if (
      representation !== "authorization-header" &&
      representation !== "cookie-header" &&
      representation !== "form-body" &&
      representation !== "json-body" &&
      representation !== "websocket-subprotocol"
    ) {
      throw invalidAuthority("Remote authority received an unsupported credential representation.");
    }
    normalized.add(representation);
  }
  return normalized;
}

function createRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  operation: string,
): Request {
  try {
    const request = new Request(input, init);
    return input instanceof Request ? inheritRequestBudget(request, input) : request;
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Remote request must be a valid absolute HTTP(S) request.",
      { operation },
      { cause },
    );
  }
}

function canonicalOrigin(origin: string, operation: string): string {
  try {
    return canonicalizeOrigin(origin);
  } catch (cause) {
    if (cause instanceof ActivityPlugError) throw cause;
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Remote authority origin must be a valid HTTP(S) origin.",
      { operation },
      { cause },
    );
  }
}

async function credentialRepresentations(
  request: Request,
  options: {
    readonly failClosedUnknownBody: boolean;
    readonly isAllowed: (representation: RemoteCredentialRepresentation) => boolean;
    readonly authority: RemoteAuthorityRequest;
  },
): Promise<readonly RemoteCredentialRepresentation[]> {
  const representations: RemoteCredentialRepresentation[] = [];
  if (request.headers.has("authorization")) representations.push("authorization-header");
  if (request.headers.has("cookie")) representations.push("cookie-header");
  if (request.body === null) return representations;

  const representation = bodyRepresentation(request.headers.get("content-type"));
  if (representation === undefined) {
    if (options.failClosedUnknownBody) {
      throw denied(
        "Remote credential-bearing body representation is not authorized.",
        options.authority,
      );
    }
    return representations;
  }
  if (options.isAllowed(representation)) {
    representations.push(representation);
    return representations;
  }
  const body = await readBoundedBody(request, options.authority);
  if (containsBodyCredential(body, representation, options.authority)) {
    representations.push(representation);
  }
  return representations;
}

const MAX_CREDENTIAL_INSPECTION_BYTES = 64 * 1024;

function bodyRepresentation(contentType: string | null): "form-body" | "json-body" | undefined {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/x-www-form-urlencoded") return "form-body";
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) return "json-body";
  return undefined;
}

async function readBoundedBody(
  request: Request,
  authority: RemoteAuthorityRequest,
): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw denied("Remote credential-bearing body length is invalid.", authority);
    }
    if (parsedLength > MAX_CREDENTIAL_INSPECTION_BYTES) {
      throw denied("Remote credential-bearing body exceeds the inspection limit.", authority);
    }
  }

  const inspectionRequest = inheritRequestBudget(request.clone(), request);
  const budget = getRequestBudget(inspectionRequest);
  const reader = inspectionRequest.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, request.signal);
      if (done) break;
      chargeBodyChunk(budget, value.byteLength);
      length += value.byteLength;
      if (length > MAX_CREDENTIAL_INSPECTION_BYTES) {
        throw denied("Remote credential-bearing body exceeds the inspection limit.", authority);
      }
      chunks.push(value);
    }
    complete = true;
  } catch (cause) {
    cancelInspectionBodies(reader, request, cause);
    throw cause;
  } finally {
    if (complete) releaseReader(reader);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason;
  const read = reader.read();
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void read.then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}

function cancelInspectionBodies(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  request: Request,
  reason: unknown,
): void {
  const cancellation = reader.cancel(reason).catch(() => undefined);
  cancelRequestBody(request, reason);
  void Promise.resolve().then(() => releaseReader(reader));
  void cancellation.finally(() => releaseReader(reader));
}

function cancelRequestBody(request: Request, reason: unknown): void {
  try {
    void request.body?.cancel(reason).catch(() => undefined);
  } catch {
    // A pre-transport body may already be closing through its inspection branch.
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // A pending read keeps the lock until cancellation settles it.
  }
}

function containsBodyCredential(
  body: Uint8Array,
  representation: "form-body" | "json-body",
  authority: RemoteAuthorityRequest,
): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw denied("Remote credential-bearing body must be valid UTF-8.", authority);
  }
  if (representation === "form-body") {
    return [...new URLSearchParams(text).keys()].some((key) =>
      BODY_CREDENTIAL_KEYS.has(key.toLowerCase()),
    );
  }
  try {
    return jsonContainsCredential(JSON.parse(text));
  } catch {
    throw denied("Remote JSON body must be valid for credential inspection.", authority);
  }
}

function jsonContainsCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(jsonContainsCredential);
  if (value === null || typeof value !== "object") return false;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (BODY_CREDENTIAL_KEYS.has(key.toLowerCase()) || jsonContainsCredential(nestedValue)) {
      return true;
    }
  }
  return false;
}

const URL_CREDENTIAL_KEYS = new Set([
  "access_token",
  "api_key",
  "authorization",
  "client_secret",
  "code",
  "code_verifier",
  "i",
  "refresh_token",
  "state",
  "ticket",
  "token",
]);

const BODY_CREDENTIAL_KEYS = new Set([
  ...URL_CREDENTIAL_KEYS,
  "actor_token",
  "assertion",
  "auth_req_id",
  "client_assertion",
  "device_code",
  "id_token",
  "password",
  "subject_token",
  "user_code",
]);

function assertNoUrlCredentials(url: URL, authority: RemoteAuthorityRequest): void {
  if (url.username !== "" || url.password !== "") {
    throw denied("Remote credentials must not be represented in a URL.", authority);
  }
  for (const key of url.searchParams.keys()) {
    if (URL_CREDENTIAL_KEYS.has(key.toLowerCase())) {
      throw denied("Remote credentials must not be represented in a URL.", authority);
    }
  }
}

function denied(message: string, authority: RemoteAuthorityRequest): ActivityPlugError {
  return new ActivityPlugError("ORIGIN_NOT_ALLOWED", message, {
    origin: authority.destination,
    operation: authority.operation,
  });
}

function invalidAuthority(message: string): ActivityPlugError {
  return new ActivityPlugError("VALIDATION_FAILED", message, {
    operation: "remote.authority.create",
  });
}
