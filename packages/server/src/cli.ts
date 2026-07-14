import { isIP, SocketAddress } from "node:net";

import { canonicalizeOrigin } from "@activityplug/core";
import { createHackersPubAdapter } from "@activityplug/hackerspub";
import { createHolloAdapter } from "@activityplug/hollo";
import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";
import { createPleromaAdapter } from "@activityplug/pleroma";
import { object } from "@optique/core/constructs";
import { multiple, optional, withDefault } from "@optique/core/modifiers";
import { flag, option } from "@optique/core/primitives";
import { integer, string } from "@optique/core/valueparser";
import { run } from "@optique/run";

import { configureServerLogging } from "./runtime/logging.js";
import {
  assertRuntimeOptions,
  createActivityPlugServer,
  startActivityPlugServer,
  type StartServerOptions,
} from "./runtime/server.js";
import { nodeLookupAddresses } from "./security/node-egress.js";
import { createNodePinnedWebSocketFactory } from "./security/node-websocket-egress.js";
import { createOriginPolicy } from "./security/origin-policy.js";
import {
  InMemoryBrowserSessionStore,
  InMemoryOAuthStartLimiter,
  InMemoryOAuthStateStore,
  InMemoryShortCacheStore,
  InMemoryStreamTicketStore,
} from "./storage/in-memory.js";

export interface ServerCliOptions {
  readonly hostname: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly allowPrivateNetworks: boolean;
  readonly browser?: {
    readonly publicOrigin: string;
    readonly cookieSigningKey: Uint8Array;
    readonly memoryStores: boolean;
    readonly trustedProxyAddresses: readonly string[];
  };
}

const parser = object({
  hostname: withDefault(option("--host", string({ metavar: "HOST" })), "127.0.0.1"),
  port: withDefault(option("--port", integer({ metavar: "PORT" })), 4000),
  allowedOrigins: multiple(option("--allow-origin", string({ metavar: "ORIGIN" }))),
  allowPrivateNetworks: withDefault(flag("--allow-private-networks"), false),
  browserPublicOrigin: optional(option("--browser-origin", string({ metavar: "ORIGIN" }))),
  browserMemoryStores: withDefault(flag("--browser-memory-stores"), false),
  trustedProxyAddresses: multiple(option("--trusted-proxy", string({ metavar: "IP" }))),
});

export function parseServerCliArgs(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ServerCliOptions {
  return parseServerCliArgsWithOptions(args, {
    environment,
    stdout: () => {},
    stderr: () => {},
    onExit: (exitCode) => {
      throw new CliParseError(exitCode);
    },
  });
}

export async function runServerCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseServerCliArgsWithOptions(args, { environment: process.env });
  await configureServerLogging();
  startActivityPlugServer(toStartOptions(options));
}

export class CliParseError extends Error {
  public override readonly name = "CliParseError";
  public readonly exitCode: number;

  public constructor(exitCode: number) {
    super(`CLI parsing failed with exit code ${exitCode}.`);
    this.exitCode = exitCode;
  }
}

function parseServerCliArgsWithOptions(
  args: readonly string[],
  options: {
    readonly stdout?: (text: string) => void;
    readonly stderr?: (text: string) => void;
    readonly onExit?: (exitCode: number) => never;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): ServerCliOptions {
  const parsed = run(parser, {
    args,
    programName: "activityplug-server",
    help: "option",
    colors: false,
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
  });
  try {
    assertRuntimeOptions({ hostname: parsed.hostname, port: parsed.port });
    const result: ServerCliOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      allowedOrigins: parsed.allowedOrigins.map((origin) => normalizeAllowedOrigin(origin)),
      allowPrivateNetworks: parsed.allowPrivateNetworks,
      ...browserCliOptions(
        parsed.browserPublicOrigin,
        parsed.browserMemoryStores,
        parsed.trustedProxyAddresses,
        options.environment ?? process.env,
      ),
    };
    assertCliOptions(result);
    return result;
  } catch (error) {
    const writeError = options.stderr ?? ((text: string) => console.error(text));
    writeError(error instanceof Error ? error.message : String(error));
    const exit = options.onExit ?? process.exit;
    return exit(1);
  }
}

export function createServerFromCliOptions(options: ServerCliOptions) {
  if (options.browser !== undefined && !options.browser.memoryStores) {
    throw new RangeError(
      "CLI browser mode requires explicit in-memory development storage configuration.",
    );
  }
  const originPolicy = createCliOriginPolicy(options.allowedOrigins);
  const webSocket = createNodePinnedWebSocketFactory({
    originPolicy,
    lookup: nodeLookupAddresses,
    allowPrivateNetworks: options.allowPrivateNetworks,
  });
  return createActivityPlugServer({
    adapters: [
      createMastodonAdapter({ webSocket }),
      createMisskeyAdapter({ webSocket }),
      createPleromaAdapter({ webSocket }),
      createHolloAdapter(),
      createHackersPubAdapter(),
    ],
    originPolicy,
    allowPrivateNetworks: options.allowPrivateNetworks,
    tokenImport: { enabled: false },
    ...(options.browser === undefined
      ? {}
      : {
          browser: {
            publicOrigin: options.browser.publicOrigin,
            cookieSigningKey: options.browser.cookieSigningKey,
            browserSessions: new InMemoryBrowserSessionStore(),
            oauthStates: new InMemoryOAuthStateStore(),
            streamTickets: new InMemoryStreamTicketStore(),
            authStartLimiter: new InMemoryOAuthStartLimiter(),
            authChallenges: new InMemoryShortCacheStore(),
            ...(options.browser.trustedProxyAddresses.length === 0
              ? {}
              : { clientIp: createTrustedProxyClientIp(options.browser.trustedProxyAddresses) }),
          },
        }),
  });
}

function toStartOptions(options: ServerCliOptions): StartServerOptions {
  const server = createServerFromCliOptions(options);
  return {
    hostname: options.hostname,
    port: options.port,
    service: server.service,
    app: server.app,
  };
}

export function createCliOriginPolicy(allowedOrigins: readonly string[]) {
  return createOriginPolicy(allowedOrigins);
}

function assertCliOptions(options: ServerCliOptions): void {
  if (options.port < 1) {
    throw new RangeError("Server port must be an integer between 1 and 65535.");
  }
  for (const origin of options.allowedOrigins) {
    normalizeAllowedOrigin(origin);
  }
}

function normalizeAllowedOrigin(origin: string): string {
  const normalized = canonicalizeOrigin(origin);
  if (new URL(normalized).protocol !== "https:") {
    throw new RangeError("Remote origins configured through the CLI must use HTTPS.");
  }
  return normalized;
}

function browserCliOptions(
  inputOrigin: string | undefined,
  memoryStores: boolean,
  trustedProxyAddresses: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Pick<ServerCliOptions, "browser"> {
  const encodedKey = environment["ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY"];
  if (inputOrigin === undefined) {
    if (encodedKey !== undefined || memoryStores || trustedProxyAddresses.length > 0) {
      throw new RangeError("Browser storage, cookie, and proxy settings require --browser-origin.");
    }
    return {};
  }
  const origin = canonicalizeOrigin(inputOrigin);
  if (new URL(origin).protocol !== "https:") {
    throw new RangeError("Browser origin must use HTTPS.");
  }
  if (encodedKey === undefined) {
    throw new RangeError(
      "ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY is required with --browser-origin.",
    );
  }
  if (!memoryStores) {
    throw new RangeError(
      "CLI browser mode requires explicit --browser-memory-stores for development; configure durable stores through createActivityPlugServer for production.",
    );
  }
  const cookieSigningKey = decodeBrowserSigningKey(encodedKey);
  return {
    browser: {
      publicOrigin: origin,
      cookieSigningKey,
      memoryStores: true,
      trustedProxyAddresses: trustedProxyAddresses.map(normalizeIpAddress),
    },
  };
}

function decodeBrowserSigningKey(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new RangeError("Browser cookie signing key must be unpadded base64url.");
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.toString("base64url") !== encoded || key.byteLength < 32) {
    throw new RangeError("Browser cookie signing key must contain at least 32 bytes.");
  }
  return new Uint8Array(key);
}

export function createTrustedProxyClientIp(
  trustedProxyAddresses: readonly string[],
): (request: Request, peerAddress: string | undefined) => string {
  const trusted = new Set(trustedProxyAddresses.map(normalizeIpAddress));
  if (trusted.size === 0) {
    throw new RangeError("At least one trusted proxy address is required.");
  }
  return (request, peerAddress) => {
    const peer = optionalNormalizedIpAddress(peerAddress);
    if (peer === null) return "unknown";
    if (!trusted.has(peer)) return peer;

    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded !== null) {
      const hops = forwarded.split(",").map((value) => optionalNormalizedIpAddress(value));
      if (hops.some((hop) => hop === null)) return peer;
      for (let index = hops.length - 1; index >= 0; index -= 1) {
        const hop = hops[index];
        if (hop !== null && !trusted.has(hop)) return hop;
      }
      return peer;
    }

    return optionalNormalizedIpAddress(request.headers.get("x-real-ip")) ?? peer;
  };
}

function normalizeIpAddress(value: string): string {
  const normalized = optionalNormalizedIpAddress(value);
  if (normalized === null) throw new RangeError(`Trusted proxy must be an IP address: ${value}.`);
  return normalized;
}

function optionalNormalizedIpAddress(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let candidate = value.trim().toLowerCase();
  if (candidate.startsWith("::ffff:") && isIP(candidate.slice(7)) === 4) {
    candidate = candidate.slice(7);
  }
  const family = isIP(candidate);
  if (family === 0) return null;
  return SocketAddress.parse(family === 6 ? `[${candidate}]` : candidate)?.address ?? null;
}
