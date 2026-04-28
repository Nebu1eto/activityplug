import { type CapabilityName } from "@activityplug/core";

type SearchKind = "accounts" | "posts" | "hashtags" | undefined;

export function hackersPubSearchCapability(type: SearchKind): CapabilityName {
  if (type === "posts") return "search.posts";
  if (type === "hashtags") return "search.hashtags";
  return "search.accounts";
}

export function hackersPubSearchOperation(type: SearchKind): string {
  return type === undefined ? "search" : hackersPubSearchCapability(type);
}
