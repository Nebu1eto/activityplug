import {
  ActivityPlugError,
  createCapabilitySet,
  isIsoDateTimeString,
  type AdapterOperationContext,
  type AuthAdapterContext,
  type EmailChallengeStartInput,
  type EmailChallengeStartResult,
  type EmailChallengeVerifyInput,
  type PasskeyCredentialTransport,
  type PasskeyAuthenticationResponse,
  type PasskeyClientExtensionResults,
  type PasskeyFinishInput,
  type PasskeyPublicKeyRequest,
  type PasskeyStartInput,
  type PasskeyStartResult,
  type TokenSet,
} from "@activityplug/core";

import {
  completeLoginChallengeDocument,
  getPasskeyAuthenticationOptionsDocument,
  loginByEmailDocument,
  loginByPasskeyDocument,
} from "./graphql-documents.js";
import { graphql, isRecord, isUuidString, nonEmptyString } from "./transport.js";
import { type HackersPubAdapterOptions } from "./types.js";

// Pinned compatibility values from HackersPub commit 116001b: models/signin.ts and models/passkey.ts.
const emailChallengeTtlMs = 12 * 60 * 60 * 1000;
const passkeyChallengeTtlMs = 5 * 60 * 1000;
const passkeyTransports = new Set<PasskeyCredentialTransport>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

export async function startEmailChallenge(
  input: EmailChallengeStartInput,
  context: AuthAdapterContext,
  options: HackersPubAdapterOptions,
): Promise<EmailChallengeStartResult> {
  const operation = "auth.emailChallenge.start";
  const operationContext = toOperationContext(context);
  const response = await graphql(
    loginByEmailDocument,
    {
      email: input.identifier,
      locale: input.locale ?? "en",
      verifyUrl: input.verificationUriTemplate,
    },
    operationContext,
    options,
    operation,
  );
  const result = response.loginByEmail;
  if (!isRecord(result) || typeof result["__typename"] !== "string") {
    throw protocolError(context, operation, "loginByEmail.__typename");
  }
  if (result["__typename"] === "AccountNotFoundError") {
    throw new ActivityPlugError("NOT_FOUND", "HackersPub account was not found.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  if (result["__typename"] !== "LoginChallenge") {
    throw protocolError(context, operation, "loginByEmail.__typename");
  }
  if (!isUuidString(result.token) || !nonEmptyString(result.created)) {
    throw protocolError(context, operation, "loginByEmail.challenge");
  }
  if (!isIsoDateTimeString(result.created)) {
    throw protocolError(context, operation, "loginByEmail.created");
  }
  const createdAt = Date.parse(result.created);
  return {
    challengeId: result.token,
    expiresAt: new Date(createdAt + emailChallengeTtlMs).toISOString(),
  };
}

export async function verifyEmailChallenge(
  input: EmailChallengeVerifyInput,
  context: AuthAdapterContext,
  options: HackersPubAdapterOptions,
): Promise<TokenSet> {
  const operation = "auth.emailChallenge.verify";
  const response = await graphql(
    completeLoginChallengeDocument,
    { token: input.challengeId, code: input.code },
    toOperationContext(context),
    options,
    operation,
  );
  return sessionTokenSet(response.completeLoginChallenge, context, operation);
}

export async function startPasskey(
  _input: PasskeyStartInput,
  context: AuthAdapterContext,
  options: HackersPubAdapterOptions,
): Promise<PasskeyStartResult> {
  const operation = "auth.passkey.start";
  const challengeId = crypto.randomUUID();
  const startedAt = Date.now();
  const response = await graphql(
    getPasskeyAuthenticationOptionsDocument,
    { sessionId: challengeId },
    toOperationContext(context),
    options,
    operation,
  );
  return {
    challengeId,
    expiresAt: new Date(startedAt + passkeyChallengeTtlMs).toISOString(),
    options: decodePasskeyOptions(response.getPasskeyAuthenticationOptions, context, operation),
  };
}

export async function finishPasskey(
  input: PasskeyFinishInput,
  context: AuthAdapterContext,
  options: HackersPubAdapterOptions,
): Promise<TokenSet> {
  const operation = "auth.passkey.finish";
  const response = await graphql(
    loginByPasskeyDocument,
    {
      sessionId: input.challengeId,
      authenticationResponse: decodePasskeyCredential(input.credential, context, operation),
    },
    toOperationContext(context),
    options,
    operation,
  );
  return sessionTokenSet(response.loginByPasskey, context, operation);
}

function decodePasskeyCredential(
  value: unknown,
  context: AuthAdapterContext,
  operation: string,
): PasskeyAuthenticationResponse {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.rawId) ||
    value.type !== "public-key" ||
    !isRecord(value.response) ||
    !isRecord(value.clientExtensionResults)
  ) {
    throw protocolError(context, operation, "credential");
  }
  const response = value.response;
  if (
    !nonEmptyString(response.clientDataJSON) ||
    !nonEmptyString(response.authenticatorData) ||
    !nonEmptyString(response.signature)
  ) {
    throw protocolError(context, operation, "credential.response");
  }
  const authenticatorAttachment = value.authenticatorAttachment;
  if (
    authenticatorAttachment !== undefined &&
    authenticatorAttachment !== "cross-platform" &&
    authenticatorAttachment !== "platform"
  ) {
    throw protocolError(context, operation, "credential.authenticatorAttachment");
  }
  const userHandle = optionalStringValue(
    response.userHandle,
    "credential.response.userHandle",
    context,
    operation,
  );
  return {
    id: value.id,
    rawId: value.rawId,
    type: "public-key",
    ...(authenticatorAttachment === undefined ? {} : { authenticatorAttachment }),
    response: {
      clientDataJSON: response.clientDataJSON,
      authenticatorData: response.authenticatorData,
      signature: response.signature,
      ...(userHandle === undefined ? {} : { userHandle }),
    },
    clientExtensionResults: decodeClientExtensionResults(
      value.clientExtensionResults,
      context,
      operation,
    ),
  };
}

function decodeClientExtensionResults(
  value: Readonly<Record<string, unknown>>,
  context: AuthAdapterContext,
  operation: string,
): PasskeyClientExtensionResults {
  const appid = optionalBooleanValue(
    value.appid,
    "clientExtensionResults.appid",
    context,
    operation,
  );
  const hmacCreateSecret = optionalBooleanValue(
    value.hmacCreateSecret,
    "clientExtensionResults.hmacCreateSecret",
    context,
    operation,
  );
  const credProps = optionalCredProps(value.credProps, context, operation);
  const largeBlob = optionalLargeBlob(value.largeBlob, context, operation);
  const prf = optionalPrf(value.prf, context, operation);
  return {
    ...(appid === undefined ? {} : { appid }),
    ...(credProps === undefined ? {} : { credProps }),
    ...(hmacCreateSecret === undefined ? {} : { hmacCreateSecret }),
    ...(largeBlob === undefined ? {} : { largeBlob }),
    ...(prf === undefined ? {} : { prf }),
  };
}

function optionalCredProps(
  value: unknown,
  context: AuthAdapterContext,
  operation: string,
): PasskeyClientExtensionResults["credProps"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw protocolError(context, operation, "clientExtensionResults.credProps");
  const rk = optionalBooleanValue(
    value.rk,
    "clientExtensionResults.credProps.rk",
    context,
    operation,
  );
  return rk === undefined ? {} : { rk };
}

function optionalLargeBlob(
  value: unknown,
  context: AuthAdapterContext,
  operation: string,
): PasskeyClientExtensionResults["largeBlob"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw protocolError(context, operation, "clientExtensionResults.largeBlob");
  const supported = optionalBooleanValue(
    value.supported,
    "clientExtensionResults.largeBlob.supported",
    context,
    operation,
  );
  const written = optionalBooleanValue(
    value.written,
    "clientExtensionResults.largeBlob.written",
    context,
    operation,
  );
  const blob = optionalStringValue(
    value.blob,
    "clientExtensionResults.largeBlob.blob",
    context,
    operation,
  );
  return {
    ...(supported === undefined ? {} : { supported }),
    ...(blob === undefined ? {} : { blob }),
    ...(written === undefined ? {} : { written }),
  };
}

function optionalPrf(
  value: unknown,
  context: AuthAdapterContext,
  operation: string,
): PasskeyClientExtensionResults["prf"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw protocolError(context, operation, "clientExtensionResults.prf");
  const enabled = optionalBooleanValue(
    value.enabled,
    "clientExtensionResults.prf.enabled",
    context,
    operation,
  );
  let results: NonNullable<PasskeyClientExtensionResults["prf"]>["results"] | undefined;
  if (value.results !== undefined && value.results !== null) {
    if (!isRecord(value.results) || !nonEmptyString(value.results.first)) {
      throw protocolError(context, operation, "clientExtensionResults.prf.results");
    }
    const second = optionalStringValue(
      value.results.second,
      "clientExtensionResults.prf.results.second",
      context,
      operation,
    );
    results = {
      first: value.results.first,
      ...(second === undefined ? {} : { second }),
    };
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(results === undefined ? {} : { results }),
  };
}

function optionalBooleanValue(
  value: unknown,
  field: string,
  context: AuthAdapterContext,
  operation: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  throw protocolError(context, operation, field);
}

function optionalStringValue(
  value: unknown,
  field: string,
  context: AuthAdapterContext,
  operation: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  throw protocolError(context, operation, field);
}

function decodePasskeyOptions(
  value: unknown,
  context: AuthAdapterContext,
  operation: string,
): PasskeyPublicKeyRequest {
  if (!isRecord(value) || !nonEmptyString(value.challenge)) {
    throw protocolError(context, operation, "challenge");
  }
  const timeout = optionalPositiveNumber(value.timeout, "timeout", context, operation);
  const rpId = optionalNonEmptyString(value.rpId, "rpId", context, operation);
  const userVerification = optionalUserVerification(value.userVerification, context, operation);
  const allowCredentials = decodeAllowCredentials(value.allowCredentials, context, operation);
  return {
    challenge: value.challenge,
    ...(timeout === undefined ? {} : { timeout }),
    ...(rpId === undefined ? {} : { rpId }),
    ...(allowCredentials === undefined ? {} : { allowCredentials }),
    ...(userVerification === undefined ? {} : { userVerification }),
  };
}

function decodeAllowCredentials(
  value: unknown,
  context: AuthAdapterContext,
  operation: string,
): PasskeyPublicKeyRequest["allowCredentials"] {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw protocolError(context, operation, "allowCredentials");
  return value.map((credential, credentialIndex) => {
    if (
      !isRecord(credential) ||
      !nonEmptyString(credential.id) ||
      credential.type !== "public-key"
    ) {
      throw protocolError(context, operation, `allowCredentials[${credentialIndex}]`);
    }
    let transports: readonly PasskeyCredentialTransport[] | undefined;
    if (credential.transports !== undefined && credential.transports !== null) {
      if (!Array.isArray(credential.transports)) {
        throw protocolError(context, operation, `allowCredentials[${credentialIndex}].transports`);
      }
      transports = credential.transports.map((transport, transportIndex) => {
        if (
          typeof transport !== "string" ||
          !passkeyTransports.has(transport as PasskeyCredentialTransport)
        ) {
          throw protocolError(
            context,
            operation,
            `allowCredentials[${credentialIndex}].transports[${transportIndex}]`,
          );
        }
        return transport as PasskeyCredentialTransport;
      });
    }
    return {
      id: credential.id,
      type: "public-key" as const,
      ...(transports === undefined ? {} : { transports }),
    };
  });
}

function optionalPositiveNumber(
  value: unknown,
  field: string,
  context: AuthAdapterContext,
  operation: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw protocolError(context, operation, field);
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
  context: AuthAdapterContext,
  operation: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (nonEmptyString(value)) return value;
  throw protocolError(context, operation, field);
}

function optionalUserVerification(
  value: unknown,
  context: AuthAdapterContext,
  operation: string,
): PasskeyPublicKeyRequest["userVerification"] {
  if (value === undefined || value === null) return undefined;
  if (value === "required" || value === "preferred" || value === "discouraged") return value;
  throw protocolError(context, operation, "userVerification");
}

function sessionTokenSet(value: unknown, context: AuthAdapterContext, operation: string): TokenSet {
  if (value === null) {
    throw new ActivityPlugError("AUTH_REQUIRED", "HackersPub authentication failed.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  if (isRecord(value) && value["__typename"] === "AccountBannedError") {
    throw new ActivityPlugError("AUTH_REQUIRED", "HackersPub account is banned.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  if (!isRecord(value) || !isUuidString(value.id)) {
    throw protocolError(context, operation, "session.id");
  }
  return { accessToken: value.id, tokenType: "Bearer" };
}

function protocolError(
  context: AuthAdapterContext,
  operation: string,
  field: string,
): ActivityPlugError {
  return new ActivityPlugError(
    "REMOTE_PROTOCOL_ERROR",
    "HackersPub authentication response did not match the expected protocol.",
    {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
      raw: { field: field.slice(0, 128) },
    },
  );
}

function toOperationContext(context: AuthAdapterContext): AdapterOperationContext {
  return {
    adapterId: context.adapterId,
    origin: context.origin,
    capabilities: createCapabilitySet(),
    fetch: context.fetch,
  };
}
