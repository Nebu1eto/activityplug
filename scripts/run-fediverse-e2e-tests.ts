import { spawn } from "node:child_process";

const targets = process.env["ACTIVITYPLUG_FEDIVERSE_TARGETS"];
const knownAdapters = new Set(["mastodon", "misskey", "pleroma", "hollo", "hackerspub"]);
const strict = process.env["ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED"] === "1";
const reprovisionPackageTargets =
  process.env["ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS"] !== "0";
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

const adapterFiles = new Map([
  ["mastodon", "packages/mastodon/src/e2e.test.ts"],
  ["misskey", "packages/misskey/src/e2e.test.ts"],
  ["pleroma", "packages/pleroma/src/e2e.test.ts"],
  ["hollo", "packages/hollo/src/e2e.test.ts"],
  ["hackerspub", "packages/hackerspub/src/e2e.test.ts"],
]);

const selectedAdapters = [...new Set(parsedTargets.map((target) => target.adapter))];

await runVitest("packages/server/src/e2e.test.ts");
for (const adapter of selectedAdapters) {
  const file = adapterFiles.get(adapter);
  if (file === undefined) fail(`Unknown Fediverse E2E adapter file: ${adapter}.`);
  const packageTargets = reprovisionPackageTargets ? `[${await runProvision(adapter)}]` : undefined;
  await runVitest(file, packageTargets);
}

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
      const record = target as Record<string, unknown>;
      const adapter = record["adapter"];
      if (typeof adapter !== "string" || adapter.length === 0) {
        throw new TypeError("target adapter is missing");
      }
      validateTargetRecord(adapter, record);
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

function validateTargetRecord(adapter: string, target: Record<string, unknown>): void {
  const required = ["origin"] as const;
  for (const field of required) {
    if (typeof target[field] !== "string" || target[field].length === 0) {
      throw new TypeError(`${adapter} target is missing ${field}`);
    }
  }
  const token = typeof target["token"] === "string" && target["token"].length > 0;
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
    if (typeof target[field] !== "string" || target[field].length === 0) {
      throw new TypeError(`${adapter} target is missing ${field}`);
    }
  }
  if (
    (adapter === "mastodon" || adapter === "pleroma") &&
    (typeof target["notificationClearRawId"] !== "string" ||
      target["notificationClearRawId"].length === 0 ||
      typeof target["notificationGraphqlClearRawId"] !== "string" ||
      target["notificationGraphqlClearRawId"].length === 0 ||
      typeof target["notificationGraphqlDismissRawId"] !== "string" ||
      target["notificationGraphqlDismissRawId"].length === 0)
  ) {
    throw new TypeError(`${adapter} target is missing notification destructive fixtures`);
  }
  if (
    adapter === "mastodon" ||
    adapter === "misskey" ||
    adapter === "pleroma" ||
    adapter === "hollo"
  ) {
    for (const field of [
      "followRequestHttpAcceptRawId",
      "followRequestGraphqlAcceptRawId",
      "followRequestHttpRejectRawId",
      "followRequestGraphqlRejectRawId",
    ]) {
      if (typeof target[field] !== "string" || target[field].length === 0) {
        throw new TypeError(`${adapter} target is missing ${field}`);
      }
    }
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

function runVitest(file: string, targetOverride?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "vitest", "run", "--passWithNoTests", "--fileParallelism=false", file],
      {
        env: {
          ...process.env,
          ACTIVITYPLUG_FEDIVERSE_E2E: "1",
          ...(targetOverride === undefined
            ? {}
            : { ACTIVITYPLUG_FEDIVERSE_TARGETS: targetOverride }),
        },
        stdio: "inherit",
      },
    );
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Fediverse E2E test process exited from signal ${signal}.`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Fediverse E2E test process exited with code ${code ?? 1}.`));
    });
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

function runProvision(adapter: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [`test/e2e/provision.${adapter}.sh`], {
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Fediverse E2E provision process exited from signal ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Fediverse E2E provision process exited with code ${code ?? 1}.`));
        return;
      }
      const target = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);
      if (target === undefined) {
        reject(new Error(`Fediverse E2E provision did not emit a target for ${adapter}.`));
        return;
      }
      try {
        JSON.parse(target);
      } catch (error) {
        reject(
          new Error(
            `Fediverse E2E provision emitted invalid JSON for ${adapter}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
        return;
      }
      resolve(target);
    });
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
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
