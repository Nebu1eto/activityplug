import {
  createAuthService,
  type AuthAdapter,
  type AuthService,
  type AuthSessionStore,
} from "../auth/service.js";
import { mergeCapabilityLayers, type CapabilitySet } from "../capabilities/capability.js";
import { ActivityPlugError, unsupportedOperation } from "../errors/error.js";
import { decodeOpaqueId } from "../ids/opaque-id.js";
import {
  type Account,
  type Connection,
  type InstanceProfile,
  type Post,
} from "../types/entities.js";
import { type AdapterMetadata } from "./metadata.js";
import { maxPageLimit } from "./page.js";

export interface ActivityPlugAdapter {
  readonly metadata: AdapterMetadata;
  readonly auth?: AuthAdapter;
  readonly instances?: InstanceAdapterOperations;
  readonly accounts?: AccountAdapterOperations;
}

export interface AdapterOperationContext {
  readonly origin: string;
  readonly adapterId: string;
  readonly capabilities: CapabilitySet;
}

export interface InstanceAdapterOperations {
  readonly detect?: (
    input: DetectInstanceInput,
    context: AdapterOperationContext,
  ) => Promise<InstanceProfile>;
  readonly getProfile?: (
    input: GetInstanceProfileInput,
    context: AdapterOperationContext,
  ) => Promise<InstanceProfile>;
}

export interface AccountAdapterOperations {
  readonly getById?: (input: GetAccountInput, context: AdapterOperationContext) => Promise<Account>;
  readonly getByHandle?: (
    input: LookupAccountInput,
    context: AdapterOperationContext,
  ) => Promise<Account | null>;
  readonly listPosts?: (
    input: ListAccountPostsInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Post>>;
}

export interface ActivityPlugClientOptions {
  readonly adapter: ActivityPlugAdapter;
  readonly origin: string;
  readonly capabilities?: CapabilitySet;
  readonly sessionStore?: AuthSessionStore;
}

export interface ActivityPlugClient {
  readonly adapter: ActivityPlugAdapter;
  readonly origin: string;
  readonly capabilities: CapabilitySet;
  readonly auth: AuthService;
  readonly instances: InstanceService;
  readonly accounts: AccountService;
}

export interface DetectInstanceInput {
  readonly origin?: string;
}

export interface GetInstanceProfileInput {
  readonly origin?: string;
}

export interface GetAccountInput {
  readonly id: string;
}

export interface LookupAccountInput {
  readonly handle: string;
}

export interface PageInput {
  readonly after?: string;
  readonly before?: string;
  readonly limit?: number;
}

export interface ListAccountPostsInput {
  readonly accountId: string;
  readonly page?: PageInput;
}

export interface InstanceService {
  readonly detect: (input?: DetectInstanceInput) => Promise<InstanceProfile>;
  readonly getProfile: (input?: GetInstanceProfileInput) => Promise<InstanceProfile>;
}

export interface AccountService {
  readonly getById: (input: GetAccountInput) => Promise<Account>;
  readonly getByHandle: (input: LookupAccountInput) => Promise<Account | null>;
  readonly listPosts: (input: ListAccountPostsInput) => Promise<Connection<Post>>;
}

export function createActivityPlugClient(options: ActivityPlugClientOptions): ActivityPlugClient {
  const origin = normalizeOrigin(options.origin, "client.create", options.adapter.metadata.id);
  const client = {
    adapter: options.adapter,
    origin,
    capabilities:
      options.capabilities ??
      mergeCapabilityLayers([
        {
          source: "static",
          capabilities: options.adapter.metadata.staticCapabilities,
        },
      ]),
    ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
  };
  return {
    ...client,
    auth: createAuthService(client),
    instances: createInstanceService(client),
    accounts: createAccountService(client),
  };
}

export const createActivityPlug = createActivityPlugClient;

export function tokenAuth(
  accessToken: string,
  scopes?: readonly string[],
): {
  readonly accessToken: string;
  readonly scopes?: readonly string[];
} {
  if (accessToken.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Access token must not be empty.");
  }
  return {
    accessToken,
    ...(scopes === undefined ? {} : { scopes }),
  };
}

function createInstanceService(client: RequiredClientContext): InstanceService {
  return {
    detect: async (input = {}) => {
      const operation = client.adapter.instances?.detect ?? client.adapter.instances?.getProfile;
      if (operation === undefined) throw unsupportedOperation("instance.detect", context(client));
      const origin =
        input.origin === undefined
          ? client.origin
          : normalizeOrigin(input.origin, "instance.detect", client.adapter.metadata.id);
      return operation({ origin }, context(client, origin));
    },
    getProfile: async (input = {}) => {
      const operation = client.adapter.instances?.getProfile;
      if (operation === undefined) throw unsupportedOperation("instance.get", context(client));
      const origin =
        input.origin === undefined
          ? client.origin
          : normalizeOrigin(input.origin, "instance.get", client.adapter.metadata.id);
      return operation({ origin }, context(client, origin));
    },
  };
}

function createAccountService(client: RequiredClientContext): AccountService {
  return {
    getById: async (input) => {
      const operation = client.adapter.accounts?.getById;
      if (operation === undefined) throw unsupportedOperation("account.get", context(client));
      const raw = decodeOpaqueId(input.id);
      assertRawRefTarget(raw, client, "account", "account.get");
      return operation({ id: raw.id }, context(client));
    },
    getByHandle: async (input) => {
      const operation = client.adapter.accounts?.getByHandle;
      if (operation === undefined) throw unsupportedOperation("account.lookup", context(client));
      return operation(input, context(client));
    },
    listPosts: async (input) => {
      const operation = client.adapter.accounts?.listPosts;
      if (operation === undefined) throw unsupportedOperation("account.posts", context(client));
      validatePageInput(input.page, "account.posts", client);
      const raw = decodeOpaqueId(input.accountId);
      assertRawRefTarget(raw, client, "account", "account.posts");
      return operation(
        { accountId: raw.id, ...(input.page === undefined ? {} : { page: input.page }) },
        context(client),
      );
    },
  };
}

function validatePageInput(
  page: PageInput | undefined,
  operation: string,
  client: RequiredClientContext,
): void {
  if (page === undefined) return;
  if (typeof page !== "object" || page === null || Array.isArray(page)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Page input must be an object.", {
      adapter: client.adapter.metadata.id,
      origin: client.origin,
      operation,
    });
  }
  if (page.after !== undefined && (typeof page.after !== "string" || page.after.length === 0)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Page input after cursor must be non-empty.", {
      adapter: client.adapter.metadata.id,
      origin: client.origin,
      operation,
    });
  }
  if (page.before !== undefined && (typeof page.before !== "string" || page.before.length === 0)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Page input before cursor must be non-empty.",
      {
        adapter: client.adapter.metadata.id,
        origin: client.origin,
        operation,
      },
    );
  }
  if (
    page.limit !== undefined &&
    (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > maxPageLimit)
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Page input limit must be an integer between 1 and ${maxPageLimit}.`,
      {
        adapter: client.adapter.metadata.id,
        origin: client.origin,
        operation,
      },
    );
  }
}

function normalizeOrigin(origin: string, operation: string, adapter: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "ActivityPlug origin must be a valid HTTP(S) URL.",
      { adapter, origin, operation },
      { cause },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "ActivityPlug origin must use HTTP or HTTPS.",
      {
        adapter,
        origin,
        operation,
      },
    );
  }
  url.hash = "";
  url.search = "";
  return url.origin;
}

type RequiredClientContext = Omit<ActivityPlugClientOptions, "capabilities"> & {
  readonly capabilities: CapabilitySet;
};

function context(
  client: RequiredClientContext,
  origin: string = client.origin,
): AdapterOperationContext {
  return {
    adapterId: client.adapter.metadata.id,
    origin,
    capabilities: client.capabilities,
  };
}

function assertRawRefTarget(
  raw: ReturnType<typeof decodeOpaqueId>,
  client: RequiredClientContext,
  expectedType: string,
  operation: string,
): void {
  if (
    raw.adapter !== client.adapter.metadata.id ||
    raw.origin !== client.origin ||
    raw.type !== expectedType
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Opaque ID does not belong to this operation target.",
      {
        adapter: client.adapter.metadata.id,
        origin: client.origin,
        operation,
        raw,
      },
    );
  }
}
