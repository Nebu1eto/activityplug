export const capabilityForControl = {
  create: "posts.create",
  reply: "posts.reply",
  quote: "posts.quote",
  context: "posts.context",
  upload: "media.upload",
  deleteUpload: "media.delete",
  favourite: "social.favourite",
  boost: "social.boost",
  bookmark: "social.bookmark",
  reaction: "social.reaction",
  follow: "social.follow",
} as const;

export type CapabilityControl = keyof typeof capabilityForControl;
export type CoreCapabilityStatus = "supported" | "unsupported" | "unknown";

export interface BrowserCapabilityDecision {
  readonly name: string;
  readonly status: CoreCapabilityStatus;
  readonly reason?: string | null;
}

export type CapabilityCollection =
  | readonly BrowserCapabilityDecision[]
  | { readonly capabilities: readonly BrowserCapabilityDecision[] };

export interface ControlDecision {
  readonly enabled: boolean;
  readonly reason?: string;
}

export type CapabilityMessageKey = "capability.unsupported" | "capability.unknown";
export type CapabilityTranslator = (key: CapabilityMessageKey) => string;

const defaultCapabilityMessages: Readonly<Record<CapabilityMessageKey, string>> = {
  "capability.unsupported": "This action is not supported by the connected server.",
  "capability.unknown": "Support for this action could not be confirmed.",
};

export const defaultCapabilityTranslator: CapabilityTranslator = (key) =>
  defaultCapabilityMessages[key];

export function supportedControl(): ControlDecision {
  return { enabled: true };
}

export function unsupportedControl(
  reason: string | null | undefined,
  translate: CapabilityTranslator = defaultCapabilityTranslator,
): ControlDecision {
  return {
    enabled: false,
    reason: nonBlankReason(reason) ?? translate("capability.unsupported"),
  };
}

export function unknownControl(
  reason: string | null | undefined,
  translate: CapabilityTranslator = defaultCapabilityTranslator,
): ControlDecision {
  return {
    enabled: false,
    reason: nonBlankReason(reason) ?? translate("capability.unknown"),
  };
}

export function controlDecision(
  capabilities: CapabilityCollection,
  control: CapabilityControl,
  translate: CapabilityTranslator = defaultCapabilityTranslator,
): ControlDecision {
  const capabilityName = capabilityForControl[control];
  const decisions = isCapabilitySet(capabilities) ? capabilities.capabilities : capabilities;
  const decision = decisions.find((candidate) => candidate.name === capabilityName);

  if (decision?.status === "supported") return supportedControl();
  if (decision?.status === "unsupported") {
    return unsupportedControl(decision.reason, translate);
  }
  return unknownControl(decision?.reason, translate);
}

function isCapabilitySet(
  capabilities: CapabilityCollection,
): capabilities is { readonly capabilities: readonly BrowserCapabilityDecision[] } {
  return !Array.isArray(capabilities);
}

function nonBlankReason(reason: string | null | undefined): string | undefined {
  return reason !== undefined && reason !== null && reason.trim() !== "" ? reason : undefined;
}
