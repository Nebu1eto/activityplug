import { isIP } from "node:net";

import { ActivityPlugError } from "@activityplug/core";
import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";
import { object } from "@optique/core/constructs";
import { multiple, withDefault } from "@optique/core/modifiers";
import { option } from "@optique/core/primitives";
import { integer, string } from "@optique/core/valueparser";
import { run } from "@optique/run";

import { configureServerLogging } from "./runtime/logging.js";
import {
  assertRuntimeOptions,
  createActivityPlugServer,
  startActivityPlugServer,
  type StartServerOptions,
} from "./runtime/server.js";

export interface ServerCliOptions {
  readonly hostname: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
}

const parser = object({
  hostname: withDefault(option("--host", string({ metavar: "HOST" })), "127.0.0.1"),
  port: withDefault(option("--port", integer({ metavar: "PORT" })), 4000),
  allowedOrigins: multiple(option("--allow-origin", string({ metavar: "ORIGIN" }))),
});

export function parseServerCliArgs(args: readonly string[]): ServerCliOptions {
  return parseServerCliArgsWithOptions(args, {
    stdout: () => {},
    stderr: () => {},
    onExit: (exitCode) => {
      throw new CliParseError(exitCode);
    },
  });
}

export async function runServerCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseServerCliArgsWithOptions(args);
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
    assertCliOptions(parsed);
    return {
      ...parsed,
      allowedOrigins: parsed.allowedOrigins.map((origin) => normalizeAllowedOrigin(origin)),
    };
  } catch (error) {
    const writeError = options.stderr ?? ((text: string) => console.error(text));
    writeError(error instanceof Error ? error.message : String(error));
    const exit = options.onExit ?? process.exit;
    return exit(1);
  }
}

function toStartOptions(options: ServerCliOptions): StartServerOptions {
  const server = createActivityPlugServer({
    adapters: [createMastodonAdapter(), createMisskeyAdapter()],
    originPolicy: createCliOriginPolicy(options.allowedOrigins),
    tokenImport: { enabled: false },
  });
  return {
    hostname: options.hostname,
    port: options.port,
    service: server.service,
    app: server.app,
  };
}

export function createCliOriginPolicy(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return ({ origin, operation }: { readonly origin: string; readonly operation: string }) => {
    const url = parsePolicyOrigin(origin, operation);
    if (isBlockedHostname(url.hostname)) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "Remote origin is not allowed by this server.",
        { origin, operation },
      );
    }
    if (allowed.has(url.origin)) return;
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Remote origin is not allowed by this server.",
      { origin, operation },
    );
  };
}

function parsePolicyOrigin(origin: string, operation: string): URL {
  try {
    return new URL(origin);
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Remote origin must be an absolute URL.",
      { origin, operation },
      { cause },
    );
  }
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
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Allowed origin must use HTTP or HTTPS.");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new TypeError("Allowed origin must not be a private host.");
  }
  return url.origin;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    isBlockedIpAddress(normalized)
  );
}

function isBlockedIpAddress(address: string): boolean {
  const normalizedAddress = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const mappedIpv4 = ipv4MappedAddress(normalizedAddress);
  if (mappedIpv4 !== undefined) return isBlockedIpAddress(mappedIpv4);
  const family = isIP(normalizedAddress);
  if (family === 0) return false;
  if (family === 6) {
    const firstHextet = Number.parseInt(normalizedAddress.split(":")[0] ?? "", 16);
    return (
      normalizedAddress === "::1" ||
      normalizedAddress === "::" ||
      normalizedAddress.startsWith("100:") ||
      normalizedAddress.startsWith("2001:2:") ||
      normalizedAddress.startsWith("2001:db8:") ||
      normalizedAddress.startsWith("fc") ||
      normalizedAddress.startsWith("fd") ||
      (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
      (firstHextet >= 0xff00 && firstHextet <= 0xffff)
    );
  }
  const octets = normalizedAddress.split(".").map((part) => Number(part));
  const [first = 0, second = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

function ipv4MappedAddress(address: string): string | undefined {
  const dotted = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (dotted !== undefined) return dotted;
  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (hex === null) return undefined;
  const high = Number.parseInt(hex[1] ?? "", 16);
  const low = Number.parseInt(hex[2] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return undefined;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
