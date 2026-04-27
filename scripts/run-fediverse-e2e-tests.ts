import { spawn } from "node:child_process";

const targets = process.env["ACTIVITYPLUG_FEDIVERSE_TARGETS"];
const knownAdapters = new Set(["mastodon", "misskey", "pleroma", "hollo", "hackerspub"]);
const strict = process.env["ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED"] === "1";
const requiredAdapters = parseRequiredAdapters(
  process.env["ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS"],
);

if (targets === undefined || targets.trim().length === 0) {
  skipOrFail("ACTIVITYPLUG_FEDIVERSE_TARGETS is not set.", "Skipping Fediverse E2E tests.");
}

const parsedTargets = parseTargets(targets);
if (parsedTargets.length === 0) {
  skipOrFail("ACTIVITYPLUG_FEDIVERSE_TARGETS is empty.", "Skipping Fediverse E2E tests.");
}
const invalidTarget = parsedTargets.find((target) => !knownAdapters.has(target.adapter));
if (invalidTarget !== undefined) {
  console.error(`Unknown Fediverse E2E adapter target: ${invalidTarget.adapter}`);
  process.exit(1);
}
if (strict) {
  const missingAdapters = requiredAdapters.filter(
    (adapter) => !parsedTargets.some((target) => target.adapter === adapter),
  );
  if (missingAdapters.length > 0) {
    console.error(
      `ACTIVITYPLUG_FEDIVERSE_TARGETS is missing required strict targets: ${missingAdapters.join(
        ", ",
      )}.`,
    );
    process.exit(1);
  }
}

const child = spawn(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--passWithNoTests",
    "packages/mastodon/src/e2e.test.ts",
    "packages/misskey/src/e2e.test.ts",
    "packages/pleroma/src/e2e.test.ts",
    "packages/hollo/src/e2e.test.ts",
    "packages/hackerspub/src/e2e.test.ts",
    "packages/server/src/e2e.test.ts",
  ],
  {
    env: {
      ...process.env,
      ACTIVITYPLUG_FEDIVERSE_E2E: "1",
    },
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`Fediverse E2E test process exited from signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

function parseTargets(value: string): ReadonlyArray<{ readonly adapter: string }> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new TypeError("target payload is not an array");
    }
    return parsed.map((target) => {
      if (typeof target !== "object" || target === null || Array.isArray(target)) {
        throw new TypeError("target entry is not an object");
      }
      const adapter = (target as Record<string, unknown>)["adapter"];
      if (typeof adapter !== "string" || adapter.length === 0) {
        throw new TypeError("target adapter is missing");
      }
      return { adapter };
    });
  } catch (error) {
    return fail(
      `ACTIVITYPLUG_FEDIVERSE_TARGETS must be a JSON array of target objects: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseRequiredAdapters(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [...knownAdapters];
  const adapters = value
    .split(",")
    .map((adapter) => adapter.trim())
    .filter((adapter) => adapter.length > 0);
  if (adapters.length === 0) {
    fail("ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS must include at least one adapter.");
  }
  const unknownAdapter = adapters.find((adapter) => !knownAdapters.has(adapter));
  if (unknownAdapter !== undefined) {
    fail(`Unknown required Fediverse E2E adapter: ${unknownAdapter}.`);
  }
  return adapters;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function skipOrFail(reason: string, skipMessage: string): never {
  if (strict) fail(`${reason} Fediverse E2E targets are required.`);
  console.warn(
    `${reason} ${skipMessage} Set ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1 to require execution.`,
  );
  process.exit(0);
}
