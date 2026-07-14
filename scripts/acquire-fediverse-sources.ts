import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  FEDIVERSE_TARGETS,
  type FediverseTarget,
  type StageResultReporter,
} from "./fediverse-e2e-results.ts";

interface SpawnedProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess;

export interface SourceAcquisitionRequest {
  readonly software: string;
  readonly repository: string;
  readonly ref: string;
  readonly commit: string;
}

interface DirectoryStatus {
  isDirectory(): boolean;
}

type StatFile = (path: string) => Promise<DirectoryStatus>;

interface AcquisitionDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly fs?: {
    readonly mkdir: typeof mkdir;
    readonly stat: StatFile;
  };
  readonly onResult?: StageResultReporter;
  readonly spawn?: Spawn;
}

export async function acquireFediverseSource(
  request: SourceAcquisitionRequest,
  dependencies: AcquisitionDependencies = {},
): Promise<string> {
  validateRequest(request);
  const target = request.software as FediverseTarget;
  try {
    const checkout = await acquire(request, dependencies);
    dependencies.onResult?.({
      target,
      stage: "checkout",
      status: "passed",
      external: true,
      message: `Verified ${request.commit} in the external source cache.`,
    });
    return checkout;
  } catch (error) {
    dependencies.onResult?.({
      target,
      stage: "checkout",
      status: "failed",
      external: true,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function acquire(
  request: SourceAcquisitionRequest,
  dependencies: AcquisitionDependencies,
): Promise<string> {
  const env = dependencies.env ?? process.env;
  const fs = dependencies.fs ?? { mkdir, stat };
  const spawn = dependencies.spawn ?? nodeSpawn;
  const cacheHome = env["XDG_CACHE_HOME"] ?? join(env["HOME"] ?? homedir(), ".cache");
  const checkout = join(
    cacheHome,
    "activityplug",
    "fediverse-sources",
    request.software,
    request.commit,
  );

  await fs.mkdir(dirname(checkout), { recursive: true });
  const initialized = await isDirectory(fs.stat, join(checkout, ".git"));
  if (!initialized) {
    await runCommand(spawn, "git", ["init", checkout]);
    await runCommand(spawn, "git", ["-C", checkout, "remote", "add", "origin", request.repository]);
  } else {
    await runCommand(spawn, "git", [
      "-C",
      checkout,
      "remote",
      "set-url",
      "origin",
      request.repository,
    ]);
  }

  await runCommand(spawn, "git", [
    "-C",
    checkout,
    "fetch",
    "--force",
    "--no-tags",
    "--depth=1",
    "origin",
    request.ref,
  ]);
  const resolved = await runCommand(spawn, "git", [
    "-C",
    checkout,
    "rev-parse",
    "FETCH_HEAD^{commit}",
  ]);
  if (resolved.trim() !== request.commit) {
    throw new Error(
      `${request.software} ref ${request.ref} resolved to ${resolved.trim()}, expected ${request.commit}.`,
    );
  }

  await runCommand(spawn, "git", ["-C", checkout, "checkout", "--detach", request.commit]);
  await runCommand(spawn, "git", ["-C", checkout, "reset", "--hard", request.commit]);
  await runCommand(spawn, "git", ["-C", checkout, "clean", "-ffdx"]);
  const head = await runCommand(spawn, "git", ["-C", checkout, "rev-parse", "HEAD"]);
  if (head.trim() !== request.commit) {
    throw new Error(
      `${request.software} checkout HEAD is ${head.trim()}, expected ${request.commit}.`,
    );
  }
  return checkout;
}

export function runCommand(
  spawn: Spawn,
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      const detail = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
      if (signal !== null) {
        reject(new Error(`${command} exited from signal ${signal}${detail}`));
      } else if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}${detail}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function isDirectory(statFile: StatFile, path: string): Promise<boolean> {
  try {
    return (await statFile(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validateRequest(request: SourceAcquisitionRequest): void {
  if (!new Set<string>(FEDIVERSE_TARGETS).has(request.software)) {
    throw new TypeError(`Invalid Fediverse software name: ${request.software}`);
  }
  if (!/^https:\/\/.+/.test(request.repository)) {
    throw new TypeError("Fediverse source repository must use HTTPS.");
  }
  if (request.ref.length === 0) throw new TypeError("Fediverse source ref must not be empty.");
  if (!/^[0-9a-f]{40}$/.test(request.commit)) {
    throw new TypeError("Fediverse source commit must be an exact lowercase SHA-1.");
  }
}

function parseArguments(args: readonly string[]): SourceAcquisitionRequest {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new TypeError("Expected --software, --repository, --ref, and --commit arguments.");
    }
    values.set(key.slice(2), value);
  }
  const software = values.get("software");
  const repository = values.get("repository");
  const ref = values.get("ref");
  const commit = values.get("commit");
  if ([software, repository, ref, commit].some((value) => value === undefined)) {
    throw new TypeError("Expected --software, --repository, --ref, and --commit arguments.");
  }
  return { software: software!, repository: repository!, ref: ref!, commit: commit! };
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  acquireFediverseSource(parseArguments(process.argv.slice(2)))
    .then((path) => console.log(path))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
