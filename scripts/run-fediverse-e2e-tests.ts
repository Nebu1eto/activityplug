import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { stat as nodeStat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { type Spawn } from "./acquire-fediverse-sources.ts";
import {
  FEDIVERSE_TARGETS,
  reportStageResult,
  type FediverseProfile,
  type FediverseTarget,
  type StageResultReporter,
} from "./fediverse-e2e-results.ts";

export type { E2EStageResult } from "./fediverse-e2e-results.ts";

export type { Spawn } from "./acquire-fediverse-sources.ts";

interface RunnerDependencies {
  readonly onResult?: StageResultReporter;
  readonly spawn?: Spawn;
  readonly stat?: (path: string) => Promise<{ readonly size: number }>;
}

const knownAdapters = new Set<FediverseTarget>(FEDIVERSE_TARGETS);
const fediverseTargetSchema = z.enum(FEDIVERSE_TARGETS);
const jsonArraySchema = z.array(z.unknown());
const jsonRecordSchema = z.looseObject({});
const nonEmptyStringSchema = z.string().min(1);
const adapterFiles = {
  mastodon: "packages/mastodon/src/e2e.test.ts",
  misskey: "packages/misskey/src/e2e.test.ts",
  pleroma: "packages/pleroma/src/e2e.test.ts",
  hollo: "packages/hollo/src/e2e.test.ts",
  hackerspub: "packages/hackerspub/src/e2e.test.ts",
} satisfies Record<FediverseTarget, string>;

interface ParsedTarget {
  readonly adapter: FediverseTarget;
  readonly serialized: string;
}

export async function runFediverseE2ETests(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RunnerDependencies = {},
): Promise<void> {
  const strict = env["ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED"] === "1";
  const rawTargets = env["ACTIVITYPLUG_FEDIVERSE_TARGETS"];
  if (rawTargets === undefined || rawTargets.trim().length === 0) {
    if (strict) throw new Error("ACTIVITYPLUG_FEDIVERSE_TARGETS is required in strict mode.");
    console.warn(
      "ACTIVITYPLUG_FEDIVERSE_TARGETS is not set. Skipping Fediverse E2E tests. " +
        "Set ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1 to require execution.",
    );
    return;
  }

  const spawn = dependencies.spawn ?? nodeSpawn;
  const stat = dependencies.stat ?? nodeStat;
  const onResult = dependencies.onResult ?? reportStageResult;
  const requiredAdapters = parseRequiredAdapters(env["ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS"]);
  let parsedTargets: readonly ParsedTarget[];
  try {
    parsedTargets = parseTargets(rawTargets);
  } catch (error) {
    for (const adapter of requiredAdapters) {
      onResult({
        target: resultTargetFor(adapter, env),
        stage: "provision",
        status: "failed",
        external: true,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  if (parsedTargets.length === 0) {
    throw new Error("ACTIVITYPLUG_FEDIVERSE_TARGETS must include at least one target.");
  }
  if (strict) {
    const missing = requiredAdapters.filter(
      (adapter) => !parsedTargets.some((target) => target.adapter === adapter),
    );
    if (missing.length > 0) {
      throw new Error(`ACTIVITYPLUG_FEDIVERSE_TARGETS is missing: ${missing.join(", ")}.`);
    }
  }

  const reprovision = env["ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS"] !== "0";
  const selected = new Map<FediverseTarget, string>();
  for (const target of parsedTargets) {
    if (!selected.has(target.adapter)) selected.set(target.adapter, `[${target.serialized}]`);
  }

  for (const [adapter, initialTarget] of selected) {
    const resultTarget = resultTargetFor(adapter, env);
    let targetOverride = initialTarget;
    await runVitest(
      resultTarget,
      "server-test",
      "packages/server/src/e2e.test.ts",
      targetOverride,
      env,
      spawn,
      stat,
      onResult,
    );
    if (reprovision) {
      targetOverride = `[${await runProvision(adapter, resultTarget, env, spawn, onResult)}]`;
    } else {
      onResult({
        target: resultTarget,
        stage: "provision",
        status: "passed",
        external: true,
        message: "Using the supplied provisioned target.",
      });
    }
    await runVitest(
      resultTarget,
      "adapter-test",
      adapterFiles[adapter],
      targetOverride,
      env,
      spawn,
      stat,
      onResult,
    );
  }
}

async function runVitest(
  target: FediverseProfile,
  stage: "server-test" | "adapter-test",
  file: string,
  targetOverride: string,
  env: NodeJS.ProcessEnv,
  spawn: Spawn,
  stat: (path: string) => Promise<{ readonly size: number }>,
  onResult: StageResultReporter,
): Promise<void> {
  try {
    let details: { readonly size: number };
    try {
      details = await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Requested Fediverse E2E test file does not exist: ${file}.`, {
          cause: error,
        });
      }
      throw error;
    }
    if (details.size === 0) {
      throw new Error(`Requested Fediverse E2E test file is empty: ${file}.`);
    }
    await runProcess(spawn, "pnpm", ["exec", "vitest", "run", "--fileParallelism=false", file], {
      env: {
        ...env,
        ACTIVITYPLUG_FEDIVERSE_E2E: "1",
        ACTIVITYPLUG_FEDIVERSE_TARGETS: targetOverride,
      },
      stdio: ["ignore", process.stderr, process.stderr],
    });
    onResult({
      target,
      stage,
      status: "passed",
      external: false,
      message: `${file} passed.`,
    });
  } catch (error) {
    onResult({
      target,
      stage,
      status: "failed",
      external: false,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runProvision(
  adapter: FediverseTarget,
  resultTarget: FediverseProfile,
  env: NodeJS.ProcessEnv,
  spawn: Spawn,
  onResult: StageResultReporter,
): Promise<string> {
  try {
    const target = await runLastOutputLine(spawn, "bash", [`test/e2e/provision.${adapter}.sh`], {
      env,
      stdio: ["ignore", "pipe", process.stderr],
    });
    if (target === undefined) {
      throw new Error(`Fediverse E2E provision did not emit a target for ${adapter}.`);
    }
    try {
      const parsed = JSON.parse(target) as unknown;
      const parsedRecord = jsonRecordSchema.safeParse(parsed);
      if (!parsedRecord.success) {
        throw new TypeError("target is not an object");
      }
      validateTargetRecord(adapter, parsedRecord.data);
    } catch (error) {
      throw new Error(
        `Fediverse E2E provision emitted invalid JSON for ${adapter}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    onResult({
      target: resultTarget,
      stage: "provision",
      status: "passed",
      external: true,
      message: `Provisioned ${adapter}.`,
    });
    return target;
  } catch (error) {
    onResult({
      target: resultTarget,
      stage: "provision",
      status: "failed",
      external: true,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function runProcess(
  spawn: Spawn,
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
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

const MAX_PROVISION_LINE_BYTES = 1024 * 1024;

function runLastOutputLine(
  spawn: Spawn,
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let pending = "";
    let lastLine: string | undefined;
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) lastLine = trimmed;
      }
      if (Buffer.byteLength(pending) > MAX_PROVISION_LINE_BYTES) {
        settled = true;
        reject(new Error("Fediverse E2E provision emitted an oversized target line."));
      }
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
      const trailing = pending.trim();
      if (trailing.length > 0) lastLine = trailing;
      if (signal !== null) reject(new Error(`${command} exited from signal ${signal}.`));
      else if (code !== 0) reject(new Error(`${command} exited with code ${code ?? 1}.`));
      else resolve(lastLine);
    });
  });
}

function parseTargets(value: string): readonly ParsedTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError(
      `ACTIVITYPLUG_FEDIVERSE_TARGETS must be JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const parsedArray = jsonArraySchema.safeParse(parsed);
  if (!parsedArray.success) throw new TypeError("Fediverse target payload must be an array.");
  return parsedArray.data.map((target) => {
    const parsedRecord = jsonRecordSchema.safeParse(target);
    if (!parsedRecord.success) {
      throw new TypeError("Fediverse target entry must be an object.");
    }
    const record = parsedRecord.data;
    const adapter = record["adapter"];
    if (typeof adapter !== "string" || !fediverseTargetSchema.safeParse(adapter).success) {
      throw new TypeError(`Unknown Fediverse E2E adapter target: ${String(adapter)}`);
    }
    validateTargetRecord(adapter as FediverseTarget, record);
    return { adapter: adapter as FediverseTarget, serialized: JSON.stringify(record) };
  });
}

function isNonEmptyString(value: unknown): boolean {
  return nonEmptyStringSchema.safeParse(value).success;
}

function validateTargetRecord(adapter: FediverseTarget, target: Record<string, unknown>): void {
  if (!isNonEmptyString(target["origin"])) {
    throw new TypeError(`${adapter} target is missing origin`);
  }
  if (target["adapter"] !== adapter) {
    throw new TypeError(`${adapter} target emitted a mismatched adapter`);
  }
  const token = isNonEmptyString(target["token"]);
  if (!token) return;
  for (const field of [
    "accountHandle",
    "socialActionHandle",
    "postSearchQuery",
    "postSearchRawId",
    "notificationRawId",
    "notificationType",
    "notificationAccountRawId",
  ]) {
    if (!isNonEmptyString(target[field])) {
      throw new TypeError(`${adapter} target is missing ${field}`);
    }
  }
  if (adapter === "mastodon" || adapter === "pleroma") {
    for (const field of [
      "notificationClearRawId",
      "notificationGraphqlClearRawId",
      "notificationGraphqlDismissRawId",
    ]) {
      if (!isNonEmptyString(target[field])) {
        throw new TypeError(`${adapter} target is missing ${field}`);
      }
    }
  }
  if (adapter !== "hackerspub") {
    for (const field of [
      "followRequestHttpAcceptRawId",
      "followRequestGraphqlAcceptRawId",
      "followRequestHttpRejectRawId",
      "followRequestGraphqlRejectRawId",
    ]) {
      if (!isNonEmptyString(target[field])) {
        throw new TypeError(`${adapter} target is missing ${field}`);
      }
    }
  }
}

function resultTargetFor(adapter: FediverseTarget, env: NodeJS.ProcessEnv): FediverseProfile {
  return env["ACTIVITYPLUG_FEDIVERSE_PROFILE"] === "mastodon-minimum" && adapter === "mastodon"
    ? "mastodon-minimum"
    : adapter;
}

function parseRequiredAdapters(value: string | undefined): readonly FediverseTarget[] {
  if (value === undefined || value.trim().length === 0) return [...knownAdapters];
  const adapters = value
    .split(",")
    .map((adapter) => adapter.trim())
    .filter(Boolean);
  if (adapters.length === 0) throw new TypeError("At least one required adapter is needed.");
  for (const adapter of adapters) {
    if (!fediverseTargetSchema.safeParse(adapter).success) {
      throw new TypeError(`Unknown required Fediverse E2E adapter: ${adapter}.`);
    }
  }
  return adapters as FediverseTarget[];
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runFediverseE2ETests().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
