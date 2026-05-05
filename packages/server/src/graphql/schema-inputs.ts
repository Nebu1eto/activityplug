import { ActivityPlugError, isIsoDateTimeString } from "@activityplug/core";

export function postUpdateInput(input: unknown) {
  const value = objectInput(input);
  const output = {
    id: stringInput(value, "id"),
    ...(typeof value["origin"] === "string" ? { origin: stringInput(value, "origin") } : {}),
    ...(typeof value["adapter"] === "string" ? { adapter: value["adapter"] } : {}),
    sessionId: stringInput(value, "sessionId"),
    ...(value["content"] === undefined ? {} : { content: stringValueInput(value, "content") }),
    ...(typeof value["visibility"] === "string"
      ? { visibility: postVisibilityInput(value["visibility"]) }
      : {}),
    ...(typeof value["sensitive"] === "boolean" ? { sensitive: value["sensitive"] } : {}),
    ...(typeof value["summary"] === "string" ? { summary: value["summary"] } : {}),
    ...(typeof value["replyToId"] === "string" ? { replyToId: value["replyToId"] } : {}),
    ...(typeof value["quoteOfId"] === "string" ? { quoteOfId: value["quoteOfId"] } : {}),
    ...(Array.isArray(value["mediaIds"])
      ? { mediaIds: stringArrayInput(value["mediaIds"], "mediaIds") }
      : {}),
    ...(value["poll"] === undefined ? {} : { poll: pollInput(value["poll"]) }),
  };
  assertPostUpdateFields(output);
  return output;
}

export function schedulePostInput(input: unknown) {
  const value = objectInput(input);
  const output = {
    origin: stringInput(value, "origin"),
    ...(typeof value["adapter"] === "string" ? { adapter: value["adapter"] } : {}),
    sessionId: stringInput(value, "sessionId"),
    content: stringValueInput(value, "content"),
    scheduledAt: dateTimeInput(value, "scheduledAt"),
    ...(typeof value["visibility"] === "string"
      ? { visibility: postVisibilityInput(value["visibility"]) }
      : {}),
    ...(typeof value["sensitive"] === "boolean" ? { sensitive: value["sensitive"] } : {}),
    ...(typeof value["summary"] === "string" ? { summary: value["summary"] } : {}),
    ...(typeof value["replyToId"] === "string" ? { replyToId: value["replyToId"] } : {}),
    ...(typeof value["quoteOfId"] === "string" ? { quoteOfId: value["quoteOfId"] } : {}),
    ...(Array.isArray(value["mediaIds"])
      ? { mediaIds: stringArrayInput(value["mediaIds"], "mediaIds") }
      : {}),
    ...(value["poll"] === undefined ? {} : { poll: pollInput(value["poll"]) }),
  };
  assertCreatePostFields(output, "Scheduled post creation");
  return output;
}

export function updateScheduledPostInput(input: unknown) {
  const value = objectInput(input);
  return {
    id: stringInput(value, "id"),
    sessionId: stringInput(value, "sessionId"),
    scheduledAt: dateTimeInput(value, "scheduledAt"),
  };
}

export function uploadMediaFromUrlInput(input: unknown) {
  const value = objectInput(input);
  return {
    origin: stringInput(value, "origin"),
    ...(typeof value["adapter"] === "string" ? { adapter: value["adapter"] } : {}),
    sessionId: stringInput(value, "sessionId"),
    url: stringInput(value, "url"),
    ...(typeof value["description"] === "string" ? { description: value["description"] } : {}),
    ...(typeof value["sensitive"] === "boolean" ? { sensitive: value["sensitive"] } : {}),
  };
}

export function updateMediaInput(input: unknown) {
  const value = objectInput(input);
  const output = {
    id: stringInput(value, "id"),
    sessionId: stringInput(value, "sessionId"),
    ...(typeof value["description"] === "string" ? { description: value["description"] } : {}),
    ...(typeof value["sensitive"] === "boolean" ? { sensitive: value["sensitive"] } : {}),
  };
  if (output.description !== undefined || output.sensitive !== undefined) return output;
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Media update requires description or sensitive.",
  );
}

export function deleteMediaInput(input: unknown) {
  const value = objectInput(input);
  return {
    id: stringInput(value, "id"),
    sessionId: stringInput(value, "sessionId"),
  };
}

export function updateProfileInput(input: unknown) {
  const value = objectInput(input);
  return {
    origin: stringInput(value, "origin"),
    ...(typeof value["adapter"] === "string" ? { adapter: value["adapter"] } : {}),
    sessionId: stringInput(value, "sessionId"),
    ...(typeof value["displayName"] === "string" ? { displayName: value["displayName"] } : {}),
    ...(typeof value["note"] === "string" ? { note: value["note"] } : {}),
    ...(typeof value["avatarId"] === "string" ? { avatarId: value["avatarId"] } : {}),
    ...(typeof value["headerId"] === "string" ? { headerId: value["headerId"] } : {}),
    ...(typeof value["locked"] === "boolean" ? { locked: value["locked"] } : {}),
    ...(typeof value["bot"] === "boolean" ? { bot: value["bot"] } : {}),
    ...(value["fields"] === undefined ? {} : { fields: accountFields(value["fields"]) }),
  };
}

export function listInput(input: unknown) {
  const value = objectInput(input);
  return {
    origin: stringInput(value, "origin"),
    ...(typeof value["adapter"] === "string" ? { adapter: value["adapter"] } : {}),
    sessionId: stringInput(value, "sessionId"),
    title: stringInput(value, "title"),
    ...(typeof value["repliesPolicy"] === "string"
      ? { repliesPolicy: repliesPolicyInput(value["repliesPolicy"]) }
      : {}),
    ...(typeof value["exclusive"] === "boolean" ? { exclusive: value["exclusive"] } : {}),
  };
}

export function updateListInput(input: unknown) {
  const value = objectInput(input);
  return {
    id: stringInput(value, "id"),
    ...(typeof value["origin"] === "string" ? { origin: stringInput(value, "origin") } : {}),
    ...(typeof value["adapter"] === "string" ? { adapter: value["adapter"] } : {}),
    sessionId: stringInput(value, "sessionId"),
    title: stringInput(value, "title"),
    ...(typeof value["repliesPolicy"] === "string"
      ? { repliesPolicy: repliesPolicyInput(value["repliesPolicy"]) }
      : {}),
    ...(typeof value["exclusive"] === "boolean" ? { exclusive: value["exclusive"] } : {}),
  };
}

export function filterInput(input: unknown) {
  const value = objectInput(input);
  const contexts = nonEmptyStringArrayInput(value["context"], "context").map((context) =>
    filterContextInput(context),
  );
  return {
    origin: stringInput(value, "origin"),
    ...(typeof value["adapter"] === "string" ? { adapter: value["adapter"] } : {}),
    sessionId: stringInput(value, "sessionId"),
    title: stringInput(value, "title"),
    context: contexts,
    ...(typeof value["action"] === "string" ? { action: filterActionInput(value["action"]) } : {}),
    ...optionalPositiveIntegerInput(value, "expiresInSeconds"),
    keywords: filterKeywords(value["keywords"]),
  };
}

export function updateFilterInput(input: unknown) {
  const value = objectInput(input);
  const contexts = nonEmptyStringArrayInput(value["context"], "context").map((context) =>
    filterContextInput(context),
  );
  return {
    id: stringInput(value, "id"),
    ...(typeof value["origin"] === "string" ? { origin: stringInput(value, "origin") } : {}),
    ...(typeof value["adapter"] === "string" ? { adapter: value["adapter"] } : {}),
    sessionId: stringInput(value, "sessionId"),
    title: stringInput(value, "title"),
    context: contexts,
    ...(typeof value["action"] === "string" ? { action: filterActionInput(value["action"]) } : {}),
    ...optionalPositiveIntegerInput(value, "expiresInSeconds"),
    keywords: filterKeywords(value["keywords"]),
  };
}

export function listAccountInput(input: unknown) {
  const value = objectInput(input);
  return {
    id: stringInput(value, "id"),
    sessionId: stringInput(value, "sessionId"),
    accountId: stringInput(value, "accountId"),
  };
}

export function notificationTypeInput(
  value: string,
):
  | "mention"
  | "status"
  | "reblog"
  | "quote"
  | "quoted_update"
  | "follow"
  | "follow_request"
  | "favourite"
  | "emoji_reaction"
  | "poll"
  | "update"
  | "move"
  | "moderation_warning"
  | "severed_relationships"
  | "annual_report"
  | "admin.sign_up"
  | "admin.report"
  | "pleroma.emoji_reaction"
  | "pleroma.chat_mention"
  | "pleroma.report" {
  if (
    value === "mention" ||
    value === "status" ||
    value === "reblog" ||
    value === "quote" ||
    value === "quoted_update" ||
    value === "follow" ||
    value === "follow_request" ||
    value === "favourite" ||
    value === "emoji_reaction" ||
    value === "poll" ||
    value === "update" ||
    value === "move" ||
    value === "moderation_warning" ||
    value === "severed_relationships" ||
    value === "annual_report" ||
    value === "admin.sign_up" ||
    value === "admin.report" ||
    value === "pleroma.emoji_reaction" ||
    value === "pleroma.chat_mention" ||
    value === "pleroma.report"
  ) {
    return value;
  }
  throw new ActivityPlugError("VALIDATION_FAILED", `Unsupported notification type: ${value}`);
}

function assertPostUpdateFields(input: {
  readonly content?: string;
  readonly visibility?: unknown;
  readonly sensitive?: boolean;
  readonly summary?: string;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
  readonly mediaIds?: readonly string[];
  readonly poll?: unknown;
}): void {
  if (
    input.content !== undefined ||
    input.visibility !== undefined ||
    input.sensitive !== undefined ||
    input.summary !== undefined ||
    input.replyToId !== undefined ||
    input.quoteOfId !== undefined ||
    input.mediaIds !== undefined ||
    input.poll !== undefined
  ) {
    return;
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Post editing requires at least one editable field.",
  );
}

function pollInput(input: unknown) {
  const value = objectInput(input);
  return {
    options: pollOptionInput(value["options"], "poll.options"),
    ...(typeof value["multiple"] === "boolean" ? { multiple: value["multiple"] } : {}),
    ...optionalPositiveIntegerInput(value, "expiresInSeconds"),
  };
}

function assertCreatePostFields(
  input: {
    readonly content: string;
    readonly replyToId?: string;
    readonly quoteOfId?: string;
    readonly mediaIds?: readonly string[];
    readonly poll?: unknown;
  },
  operationName: string,
): void {
  if (
    input.content.trim().length > 0 ||
    input.replyToId !== undefined ||
    input.quoteOfId !== undefined ||
    (input.mediaIds !== undefined && input.mediaIds.length > 0) ||
    input.poll !== undefined
  ) {
    return;
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    `${operationName} requires text, media, a poll, or a reply/quote target.`,
  );
}

function filterKeywords(input: unknown) {
  return nonEmptyArrayInput(input, "keywords").map((keyword) => {
    const value = objectInput(keyword);
    return {
      keyword: stringInput(value, "keyword"),
      ...(typeof value["wholeWord"] === "boolean" ? { wholeWord: value["wholeWord"] } : {}),
    };
  });
}

function accountFields(input: unknown) {
  return arrayInput(input, "fields").map((item) => {
    const value = objectInput(item);
    return {
      name: stringInput(value, "name"),
      value: stringValueInput(value, "value"),
    };
  });
}

function optionalPositiveIntegerInput(
  input: Record<string, unknown>,
  field: string,
): Record<string, number> {
  const value = input[field];
  if (value === undefined) return {};
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return { [field]: value };
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    `GraphQL JSON input field must be a positive integer: ${field}.`,
  );
}

function objectInput(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  throw new ActivityPlugError("VALIDATION_FAILED", "GraphQL JSON input must be an object.");
}

function stringInput(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    `GraphQL JSON input field must be a non-empty string: ${field}.`,
  );
}

function dateTimeInput(input: Record<string, unknown>, field: string): string {
  const value = stringInput(input, field);
  if (isIsoDateTimeString(value)) return value;
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    `GraphQL input field must be a valid date-time string: ${field}.`,
  );
}

function stringValueInput(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value === "string") return value;
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    `GraphQL JSON input field must be a string: ${field}.`,
  );
}

function arrayInput(input: unknown, field: string): unknown[] {
  if (Array.isArray(input)) return input;
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    `GraphQL input field must be an array: ${field}.`,
  );
}

function nonEmptyArrayInput(input: unknown, field: string): unknown[] {
  const values = arrayInput(input, field);
  if (values.length > 0) return values;
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    `GraphQL input field must be a non-empty array: ${field}.`,
  );
}

function postVisibilityInput(
  value: string,
): "direct" | "followers" | "list" | "local" | "none" | "public" | "unlisted" {
  if (
    value === "public" ||
    value === "unlisted" ||
    value === "followers" ||
    value === "direct" ||
    value === "local" ||
    value === "list" ||
    value === "none"
  ) {
    return value;
  }
  throw new ActivityPlugError("VALIDATION_FAILED", "Unsupported post visibility.");
}

function repliesPolicyInput(value: string): "followed" | "list" | "none" {
  if (value === "followed" || value === "list" || value === "none") return value;
  throw new ActivityPlugError("VALIDATION_FAILED", "Unsupported list repliesPolicy.");
}

function filterContextInput(
  value: string,
): "account" | "home" | "notifications" | "profile" | "public" | "thread" {
  if (
    value === "home" ||
    value === "notifications" ||
    value === "public" ||
    value === "thread" ||
    value === "account" ||
    value === "profile"
  ) {
    return value;
  }
  throw new ActivityPlugError("VALIDATION_FAILED", "Unsupported filter context.");
}

function filterActionInput(value: string): "hide" | "warn" {
  if (value === "hide" || value === "warn") return value;
  throw new ActivityPlugError("VALIDATION_FAILED", "Unsupported filter action.");
}

function stringArrayInput(input: unknown[], field: string): readonly string[] {
  if (input.every((value) => typeof value === "string" && value.trim().length > 0)) {
    return input as string[];
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    `GraphQL JSON input field must be a non-empty string array: ${field}.`,
  );
}

function nonEmptyStringArrayInput(input: unknown, field: string): readonly string[] {
  return stringArrayInput(nonEmptyArrayInput(input, field), field);
}

function pollOptionInput(input: unknown, field: string): readonly string[] {
  const values = stringArrayInput(arrayInput(input, field), field);
  if (values.length >= 2) return values;
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    `GraphQL input field must include at least two items: ${field}.`,
  );
}
