import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runCommand, type Spawn } from "./acquire-fediverse-sources.ts";
import { reportStageResult, type StageResultReporter } from "./fediverse-e2e-results.ts";

export type { Spawn } from "./acquire-fediverse-sources.ts";

interface PleromaBuildRequest {
  readonly sourceDirectory: string;
  readonly commit: string;
  readonly repositoryRoot: string;
}

interface PleromaBuildDependencies {
  readonly onResult?: StageResultReporter;
  readonly spawn?: Spawn;
}

export async function buildPleromaE2E(
  request: PleromaBuildRequest,
  dependencies: PleromaBuildDependencies = {},
): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(request.commit)) {
    throw new TypeError("Pleroma source commit must be an exact lowercase SHA-1.");
  }
  const spawn = dependencies.spawn ?? nodeSpawn;
  const onResult = dependencies.onResult ?? reportStageResult;
  const image = `activityplug-pleroma-e2e:${request.commit}`;
  try {
    const head = (
      await runCommand(spawn, "git", ["-C", request.sourceDirectory, "rev-parse", "HEAD"])
    ).trim();
    if (head !== request.commit) {
      throw new Error(`Pleroma checkout HEAD is ${head}, expected ${request.commit}.`);
    }
    await runStreamingCommand(
      spawn,
      "docker",
      [
        "build",
        "--file",
        join(request.repositoryRoot, "test/e2e/pleroma/Dockerfile"),
        "--build-context",
        `pleroma_source=${request.sourceDirectory}`,
        "--build-arg",
        `SOURCE_REF=${request.commit}`,
        "--tag",
        image,
        "--tag",
        "activityplug-fediverse-e2e-pleroma-web",
        request.repositoryRoot,
      ],
      { cwd: request.repositoryRoot },
    );
    const status = await runCommand(spawn, "git", [
      "-C",
      request.sourceDirectory,
      "status",
      "--porcelain",
    ]);
    if (status.trim().length > 0) {
      throw new Error("Pleroma builder modified the verified Pleroma checkout.");
    }
    onResult({
      target: "pleroma",
      stage: "build",
      status: "passed",
      external: true,
      message: `Built ${image} from the verified checkout.`,
    });
    return image;
  } catch (error) {
    onResult({
      target: "pleroma",
      stage: "build",
      status: "failed",
      external: true,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function runStreamingCommand(
  spawn: Spawn,
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", process.stderr, process.stderr],
    });
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (signal !== null) reject(new Error(`${command} exited from signal ${signal}.`));
      else if (code !== 0) reject(new Error(`${command} exited with code ${code ?? 1}.`));
      else resolve();
    });
  });
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [sourceDirectory, commit, repositoryRoot = process.cwd()] = process.argv.slice(2);
  if (sourceDirectory === undefined || commit === undefined) {
    console.error("Usage: build-pleroma-e2e.ts <source-directory> <commit> [repository-root]");
    process.exitCode = 2;
  } else {
    const onResult =
      process.env["ACTIVITYPLUG_E2E_SUPPRESS_RESULTS"] === "1" ? () => undefined : undefined;
    buildPleromaE2E({ sourceDirectory, commit, repositoryRoot }, { onResult }).catch(
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
  }
}
