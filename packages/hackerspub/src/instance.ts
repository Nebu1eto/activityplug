import {
  ActivityPlugError,
  createEntityRef,
  type AdapterOperationContext,
  type InstanceProfile,
} from "@activityplug/core";
import { HTTPError, TimeoutError } from "ky";

import {
  activityPlugError,
  clientFor,
  errorCodeForStatus,
  isRecord,
  nonEmptyString,
  safeResponseText,
} from "./transport.js";
import { type HackersPubAdapterOptions } from "./types.js";

export async function getInstanceProfile(
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<InstanceProfile> {
  const nodeInfo = await getNodeInfo(context, options);
  const host = new URL(context.origin).host;
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "instance",
      id: host,
      rawUrl: context.origin,
    }),
    software: {
      name: nodeInfo.software?.name ?? "hackerspub",
      ...(nodeInfo.software?.version === undefined ? {} : { version: nodeInfo.software.version }),
    },
    languages: [],
    registrations: {
      enabled: false,
      inviteRequired: true,
    },
    capabilities: context.capabilities,
    raw: nodeInfo.raw,
  };
}

export interface HackersPubNodeInfo {
  readonly software?: {
    readonly name?: string;
    readonly version?: string;
  };
  readonly raw: unknown;
}

export async function getNodeInfo(
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<HackersPubNodeInfo> {
  try {
    const links = await clientFor(context, options)
      .get(".well-known/nodeinfo")
      .json<{ readonly links?: readonly { readonly rel?: string; readonly href?: string }[] }>();
    if (!Array.isArray(links.links)) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub NodeInfo links response was malformed.",
        context,
        "instance.nodeInfo",
        links,
      );
    }
    const href = selectNodeInfoHref(links.links, context);
    const nodeInfo = await clientFor(context, options).get(href).json<unknown>();
    if (!isRecord(nodeInfo)) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub NodeInfo document was malformed.",
        context,
        "instance.nodeInfo",
        nodeInfo,
      );
    }
    const software = isRecord(nodeInfo.software) ? nodeInfo.software : undefined;
    return {
      software: {
        ...(typeof software?.name === "string" ? { name: software.name } : {}),
        ...(typeof software?.version === "string" ? { version: software.version } : {}),
      },
      raw: nodeInfo,
    };
  } catch (cause) {
    if (cause instanceof HTTPError) {
      throw activityPlugError(
        errorCodeForStatus(cause.response.status),
        `HackersPub NodeInfo request failed with HTTP ${cause.response.status}.`,
        context,
        "instance.nodeInfo",
        {
          status: cause.response.status,
          body: await safeResponseText(cause.response),
        },
      );
    }
    if (cause instanceof TimeoutError) {
      throw new ActivityPlugError(
        "TIMEOUT",
        "HackersPub NodeInfo request timed out.",
        {
          adapter: context.adapterId,
          origin: context.origin,
          operation: "instance.nodeInfo",
        },
        { cause },
      );
    }
    if (cause instanceof ActivityPlugError) throw cause;
    if (cause instanceof SyntaxError) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub NodeInfo response was not valid JSON.",
        context,
        "instance.nodeInfo",
      );
    }
    throw new ActivityPlugError(
      "NETWORK_ERROR",
      "HackersPub NodeInfo request failed before a response was received.",
      { adapter: context.adapterId, origin: context.origin, operation: "instance.nodeInfo" },
      { cause },
    );
  }
}

export function selectNodeInfoHref(
  links: readonly { readonly rel?: string; readonly href?: string }[],
  context: AdapterOperationContext,
): string {
  const priorities = [
    "http://nodeinfo.diaspora.software/ns/schema/2.1",
    "http://nodeinfo.diaspora.software/ns/schema/2.0",
  ];
  for (const rel of priorities) {
    const href = links.find((link) => link.rel === rel && nonEmptyString(link.href))?.href;
    if (href !== undefined) return sameOriginPath(href, context);
  }
  throw activityPlugError(
    "REMOTE_ERROR",
    "HackersPub NodeInfo links response did not include a supported NodeInfo document.",
    context,
    "instance.nodeInfo",
    links,
  );
}

export function sameOriginPath(href: string, context: AdapterOperationContext): string {
  let url: URL;
  try {
    url = new URL(href, context.origin);
  } catch (cause) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub NodeInfo href was malformed.",
      context,
      "instance.nodeInfo",
      { href, cause },
    );
  }
  if (url.origin !== context.origin) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub NodeInfo href must stay on the instance origin.",
      context,
      "instance.nodeInfo",
      { href },
    );
  }
  return `${url.pathname.replace(/^\//u, "")}${url.search}`;
}
