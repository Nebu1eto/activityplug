import { ActivityPlugError, type ActivityPlugErrorContext } from "@activityplug/core";

export interface PublicActivityPlugError {
  readonly code: ActivityPlugError["code"];
  readonly message: string;
  readonly adapter?: string;
  readonly origin?: string;
  readonly operation?: string;
  readonly capability?: string;
}

export function createInternalServerError(): ActivityPlugError {
  return new ActivityPlugError("INTERNAL_ERROR", "An internal server error occurred.");
}

export function serializeActivityPlugError(error: ActivityPlugError): PublicActivityPlugError {
  return {
    code: error.code,
    message: error.message,
    ...sanitizeErrorContext(error.context),
  };
}

function sanitizeErrorContext(
  context: ActivityPlugErrorContext,
): Omit<PublicActivityPlugError, "code" | "message"> {
  return {
    ...(context.adapter === undefined ? {} : { adapter: context.adapter }),
    ...(context.origin === undefined ? {} : { origin: context.origin }),
    ...(context.operation === undefined ? {} : { operation: context.operation }),
    ...(context.capability === undefined ? {} : { capability: context.capability }),
  };
}
