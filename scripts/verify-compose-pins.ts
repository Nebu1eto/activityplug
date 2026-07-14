import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { z } from "zod";

const additionalComposePaths = [
  "test/e2e/docker-compose.yml",
  "test/e2e/docker-compose.mastodon-minimum.yml",
] as const;
const rootComposeFile = /^docker-compose(?:\.[a-z0-9][a-z0-9.-]*)?\.ya?ml$/iu;
const digestPinnedImage = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const requiredImageVariable = /^\$\{(ACTIVITYPLUG_[A-Z0-9_]+_IMAGE):\?[^}]+\}$/;
const immutableGitCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sourceRefKey = /(?:^|_)(?:GIT_)?(?:SOURCE_)?(?:REF|COMMIT)$/i;

const recordSchema = z.looseObject({});
const composeDocumentSchema = z.looseObject({ services: recordSchema });
const buildArgsSchema = z.looseObject({ args: recordSchema });

export async function verifyComposePins(root: URL): Promise<string[]> {
  const composePaths = await discoverComposePaths(root);
  const results = await Promise.all(
    composePaths.map(async (path) => {
      try {
        return verifyComposeText(await readFile(new URL(path, root), "utf8"), path);
      } catch (error) {
        return [`${path}: could not be read: ${errorMessage(error)}`];
      }
    }),
  );
  return results.flat();
}

/** Finds every root Compose file so new production stacks cannot skip pin checks. */
export async function discoverComposePaths(root: URL): Promise<string[]> {
  const entries = await readdir(fileURLToPath(root), { withFileTypes: true });
  const rootPaths = entries
    .filter((entry) => entry.isFile() && rootComposeFile.test(entry.name))
    .map((entry) => entry.name);
  return [...new Set([...rootPaths, ...additionalComposePaths])].toSorted();
}

export function verifyComposeText(source: string, file: string): string[] {
  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    return [`${file}: invalid Compose YAML: ${errorMessage(error)}`];
  }
  const parsedDocument = composeDocumentSchema.safeParse(document);
  if (!parsedDocument.success) {
    return [`${file}: services must be a mapping`];
  }

  const violations: string[] = [];
  for (const [serviceName, service] of Object.entries(parsedDocument.data.services).toSorted(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const parsedService = recordSchema.safeParse(service);
    if (!parsedService.success) {
      violations.push(`${file}: service ${serviceName} must be a mapping`);
      continue;
    }
    verifyImage(violations, file, serviceName, parsedService.data["image"]);
    verifyBuildImageArgs(violations, file, serviceName, parsedService.data["build"]);
    verifySourceRefs(violations, file, serviceName, parsedService.data["build"]);
  }
  return violations;
}

function verifyImage(violations: string[], file: string, service: string, image: unknown): void {
  if (image === undefined) return;
  if (
    typeof image !== "string" ||
    (!digestPinnedImage.test(image) && !requiredImageVariable.test(image))
  ) {
    violations.push(
      `${file}: service ${service} must use a digest-pinned image with a 64-character lowercase sha256 digest`,
    );
    return;
  }
  if (/:latest@sha256:/i.test(image)) {
    violations.push(`${file}: service ${service} image must not use the latest tag`);
  }
  const imageWithoutDigest = image.slice(0, image.indexOf("@sha256:"));
  if (/elasticsearch/i.test(imageWithoutDigest) && !/:7\.[^/:@]+$/.test(imageWithoutDigest)) {
    violations.push(`${file}: service ${service} image must select Elasticsearch 7.x`);
  }
}

function verifyBuildImageArgs(
  violations: string[],
  file: string,
  service: string,
  build: unknown,
): void {
  const parsedBuild = buildArgsSchema.safeParse(build);
  if (!parsedBuild.success) return;
  for (const [key, value] of Object.entries(parsedBuild.data.args)) {
    if (!key.endsWith("_IMAGE")) continue;
    const variable = typeof value === "string" ? requiredImageVariable.exec(value)?.[1] : undefined;
    if (variable !== `ACTIVITYPLUG_${key}`) {
      violations.push(
        `${file}: service ${service} build arg ${key} must require its digest-pinned ACTIVITYPLUG_${key} variable`,
      );
    }
  }
}

const productionImageVariables = [
  "ACTIVITYPLUG_NODE_IMAGE",
  "ACTIVITYPLUG_CADDY_IMAGE",
  "ACTIVITYPLUG_POSTGRES_IMAGE",
  "ACTIVITYPLUG_REDIS_IMAGE",
] as const;
const durablePasswordVariables = [
  "ACTIVITYPLUG_POSTGRES_PASSWORD",
  "ACTIVITYPLUG_REDIS_PASSWORD",
] as const;
const urlSafeBase64Password = /^[A-Za-z0-9_-]{32,}$/;

export function verifyProductionEnvironment(
  environment: NodeJS.ProcessEnv,
  mode: "durable" | "memory" = "durable",
): string[] {
  const violations: string[] = [];
  const variables =
    mode === "memory" ? productionImageVariables.slice(0, 2) : productionImageVariables;
  for (const variable of variables) {
    const value = environment[variable];
    if (value === undefined || !digestPinnedImage.test(value)) {
      violations.push(`${variable} must use a 64-character lowercase sha256 digest`);
      continue;
    }
    if (/:latest@sha256:/i.test(value)) {
      violations.push(`${variable} must not use the latest tag`);
    }
  }
  if (environment["ACTIVITYPLUG_PNPM_VERSION"] !== "11.12.0") {
    violations.push("ACTIVITYPLUG_PNPM_VERSION must equal 11.12.0");
  }
  if (mode === "durable") {
    const postgresPassword = environment["ACTIVITYPLUG_POSTGRES_PASSWORD"] ?? "";
    const redisPassword = environment["ACTIVITYPLUG_REDIS_PASSWORD"] ?? "";
    for (const variable of durablePasswordVariables) {
      if (!urlSafeBase64Password.test(environment[variable] ?? "")) {
        violations.push(`${variable} must contain at least 32 URL-safe base64 characters`);
      }
    }
    if (
      urlSafeBase64Password.test(postgresPassword) &&
      urlSafeBase64Password.test(redisPassword) &&
      postgresPassword === redisPassword
    ) {
      violations.push("ACTIVITYPLUG_POSTGRES_PASSWORD and ACTIVITYPLUG_REDIS_PASSWORD must differ");
    }
  }
  return violations;
}

function verifySourceRefs(
  violations: string[],
  file: string,
  service: string,
  build: unknown,
): void {
  const parsedBuild = recordSchema.safeParse(build);
  if (!parsedBuild.success) return;

  const checksums = verifyGitContexts(violations, file, service, parsedBuild.data);
  const parsedArgs = recordSchema.safeParse(parsedBuild.data["args"]);
  if (!parsedArgs.success) return;
  for (const [key, value] of Object.entries(parsedArgs.data).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!sourceRefKey.test(key)) continue;
    if (typeof value !== "string" || !immutableGitCommit.test(value)) {
      violations.push(
        `${file}: service ${service} build arg ${key} must use an exact lowercase Git commit`,
      );
      continue;
    }
    if (!checksums.has(value)) {
      violations.push(
        `${file}: service ${service} build arg ${key} must be bound to a remote Git context checksum`,
      );
    }
  }
}

function verifyGitContexts(
  violations: string[],
  file: string,
  service: string,
  build: Record<string, unknown>,
): Set<string> {
  const checksums = new Set<string>();
  verifyGitContext(violations, checksums, file, service, "build context", build["context"]);

  const parsedAdditionalContexts = recordSchema.safeParse(build["additional_contexts"]);
  if (!parsedAdditionalContexts.success) return checksums;
  for (const [name, context] of Object.entries(parsedAdditionalContexts.data).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    verifyGitContext(violations, checksums, file, service, `additional context ${name}`, context);
  }
  return checksums;
}

function verifyGitContext(
  violations: string[],
  checksums: Set<string>,
  file: string,
  service: string,
  label: string,
  context: unknown,
): void {
  if (typeof context !== "string" || !isRemoteGitContext(context)) return;
  const checksum = /[?&]checksum=([a-zA-Z0-9]+)(?:&|$)/.exec(context)?.[1];
  if (checksum === undefined || !immutableGitCommit.test(checksum)) {
    violations.push(
      `${file}: service ${service} ${label} must use an exact lowercase Git checksum`,
    );
    return;
  }
  checksums.add(checksum);
}

function isRemoteGitContext(context: string): boolean {
  return /^(?:(?:https?|git|ssh):\/\/|[^@\s]+@[^:\s]+:).+\.git(?:[?#]|$)/i.test(context);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(): Promise<void> {
  const violations = process.argv.includes("--production-env")
    ? verifyProductionEnvironment(process.env)
    : process.argv.includes("--memory-env")
      ? verifyProductionEnvironment(process.env, "memory")
      : await verifyComposePins(new URL("../", import.meta.url));
  if (violations.length === 0) return;
  for (const violation of violations) console.error(violation);
  process.exitCode = 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  void run();
}
