import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";
import { object } from "@optique/core/constructs";
import { withDefault } from "@optique/core/modifiers";
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
}

const parser = object({
  hostname: withDefault(option("--host", string({ metavar: "HOST" })), "127.0.0.1"),
  port: withDefault(option("--port", integer({ metavar: "PORT" })), 4000),
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
    return parsed;
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
    tokenImport: { enabled: false },
  });
  return {
    hostname: options.hostname,
    port: options.port,
    service: server.service,
    app: server.app,
  };
}

function assertCliOptions(options: ServerCliOptions): void {
  if (options.port < 1) {
    throw new RangeError("Server port must be an integer between 1 and 65535.");
  }
}
