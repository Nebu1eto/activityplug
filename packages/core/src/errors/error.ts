import { type CapabilityName } from "../capabilities/capability.js";

export type ActivityPlugErrorCode =
  | "ADAPTER_NOT_FOUND"
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "AUTH_UNSUPPORTED"
  | "CAPABILITY_UNKNOWN"
  | "UNSUPPORTED_OPERATION"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "REMOTE_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

export interface ActivityPlugErrorContext {
  readonly adapter?: string;
  readonly origin?: string;
  readonly operation?: string;
  readonly capability?: CapabilityName;
  readonly raw?: unknown;
}

export type RemoteHttpErrorCode =
  | "AUTH_REQUIRED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "REMOTE_ERROR";

export class ActivityPlugError extends Error {
  public override readonly name = "ActivityPlugError";
  public readonly code: ActivityPlugErrorCode;
  public readonly context: ActivityPlugErrorContext;

  public constructor(
    code: ActivityPlugErrorCode,
    message: string,
    context: ActivityPlugErrorContext = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.context = context;
  }
}

export function unsupportedCapability(
  capability: CapabilityName,
  context: Omit<ActivityPlugErrorContext, "capability"> = {},
): ActivityPlugError {
  return new ActivityPlugError(
    "UNSUPPORTED_OPERATION",
    `Capability is not supported: ${capability}`,
    {
      ...context,
      capability,
    },
  );
}

export function unsupportedOperation(
  operation: string,
  context: ActivityPlugErrorContext = {},
): ActivityPlugError {
  return new ActivityPlugError(
    "UNSUPPORTED_OPERATION",
    `Operation is not supported: ${operation}`,
    {
      ...context,
      operation,
    },
  );
}

export function invalidOpaqueId(message: string, options?: ErrorOptions): ActivityPlugError {
  return new ActivityPlugError("VALIDATION_FAILED", message, {}, options);
}

export function remoteHttpErrorCodeForStatus(status: number): RemoteHttpErrorCode {
  if (status === 401 || status === 403) return "AUTH_REQUIRED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  return "REMOTE_ERROR";
}

export function isActivityPlugError(error: unknown): error is ActivityPlugError {
  return error instanceof ActivityPlugError;
}
