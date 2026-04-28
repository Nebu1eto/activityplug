import {
  ActivityPlugError,
  type AdapterOperationContext,
  type CapabilityName,
  type Post,
} from "@activityplug/core";

type SearchKind = "accounts" | "posts" | "hashtags" | undefined;

export function misskeyNodeInfoRelPriority(rel: string | undefined): number {
  if (rel === "http://nodeinfo.diaspora.software/ns/schema/2.1") return 3;
  if (rel === "http://nodeinfo.diaspora.software/ns/schema/2.0") return 2;
  if (rel === "http://nodeinfo.diaspora.software/ns/schema/1.0") return 1;
  return 0;
}

export function misskeySearchCapability(type: SearchKind): CapabilityName {
  if (type === "posts") return "search.posts";
  if (type === "hashtags") return "search.hashtags";
  return "search.accounts";
}

export function misskeySearchOperation(type: SearchKind): string {
  return type === undefined ? "search" : misskeySearchCapability(type);
}

export function unsupportedMisskeyPostOperation(
  context: AdapterOperationContext,
  operation: string,
  capabilityName: CapabilityName,
): Promise<Post> {
  return Promise.reject(
    new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "This adapter does not support this operation.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation,
        capability: capabilityName,
      },
    ),
  );
}
