import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";

import { expect, it, vi } from "vitest";

import {
  runFediverseE2ETests,
  type E2EStageResult,
  type Spawn,
} from "./run-fediverse-e2e-tests.js";

const target = JSON.stringify([{ adapter: "hollo", origin: "http://hollo.test" }]);

function spawnSequence(
  results: ReadonlyArray<
    | { readonly code?: number; readonly signal?: NodeJS.Signals | null; readonly stdout?: string }
    | { readonly error: Error }
  >,
): Spawn {
  let index = 0;
  return ((command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const result = results[index++];
    queueMicrotask(() => {
      if (result === undefined) throw new Error(`Unexpected spawn: ${command} ${args.join(" ")}`);
      if ("error" in result) {
        child.emit("error", result.error);
        child.emit("close", 1, null);
        return;
      }
      child.stdout.end(result.stdout ?? "");
      child.stderr.end();
      child.emit("close", result.code ?? 0, result.signal ?? null);
    });
    return child;
  }) as Spawn;
}

function dependencies(spawn: Spawn, results: E2EStageResult[]) {
  return {
    onResult: (result: E2EStageResult) => results.push(result),
    spawn,
    stat: async () => ({ size: 1 }),
  };
}

it("reports independent provision, server, and adapter stage records", async () => {
  const results: E2EStageResult[] = [];
  await runFediverseE2ETests(
    {
      ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED: "1",
      ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS: "hollo",
      ACTIVITYPLUG_FEDIVERSE_TARGETS: target,
    },
    dependencies(spawnSequence([{}, { stdout: `${target.slice(1, -1)}\n` }, {}]), results),
  );
  expect(results.map(({ stage, status }) => [stage, status])).toEqual([
    ["server-test", "passed"],
    ["provision", "passed"],
    ["adapter-test", "passed"],
  ]);
});

it("does not hide a missing or empty named suite with passWithNoTests", async () => {
  for (const size of [undefined, 0]) {
    const results: E2EStageResult[] = [];
    const spawn = vi.fn() as unknown as Spawn;
    await expect(
      runFediverseE2ETests(
        {
          ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS: "0",
          ACTIVITYPLUG_FEDIVERSE_TARGETS: target,
        },
        {
          onResult: (result) => results.push(result),
          spawn,
          stat: async () => {
            if (size === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return { size };
          },
        },
      ),
    ).rejects.toThrow(size === 0 ? "is empty" : "does not exist");
    expect(spawn).not.toHaveBeenCalled();
    expect(results.at(-1)).toEqual(
      expect.objectContaining({ stage: "server-test", status: "failed", external: false }),
    );
  }
});

it("scopes each destructive server suite run to its current adapter", async () => {
  const targets = JSON.stringify([
    { adapter: "hollo", origin: "http://hollo.test" },
    { adapter: "hackerspub", origin: "http://hackerspub.test" },
  ]);
  const serverTargets: string[] = [];
  const sequence = spawnSequence([
    {},
    { stdout: '{"adapter":"hollo","origin":"http://hollo.test"}\n' },
    {},
    {},
    { stdout: '{"adapter":"hackerspub","origin":"http://hackerspub.test"}\n' },
    {},
  ]);
  const spawn: Spawn = (command, args, options) => {
    if (args.includes("packages/server/src/e2e.test.ts")) {
      serverTargets.push(options.env?.["ACTIVITYPLUG_FEDIVERSE_TARGETS"] ?? "");
    }
    return sequence(command, args, options);
  };

  await runFediverseE2ETests(
    {
      ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS: "hollo,hackerspub",
      ACTIVITYPLUG_FEDIVERSE_TARGETS: targets,
    },
    { spawn, stat: async () => ({ size: 1 }) },
  );

  expect(serverTargets).toEqual([
    '[{"adapter":"hollo","origin":"http://hollo.test"}]',
    '[{"adapter":"hackerspub","origin":"http://hackerspub.test"}]',
  ]);
});

it.each([
  ["synchronous spawn error", { error: new Error("spawn ENOENT") }],
  ["signal exit", { signal: "SIGTERM" as const }],
  ["nonzero exit", { code: 9 }],
])("reports %s at the exact adapter stage", async (_case, failure) => {
  const results: E2EStageResult[] = [];
  await expect(
    runFediverseE2ETests(
      {
        ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS: "0",
        ACTIVITYPLUG_FEDIVERSE_TARGETS: target,
      },
      dependencies(spawnSequence([{}, failure]), results),
    ),
  ).rejects.toThrow();
  expect(results.at(-1)).toEqual(
    expect.objectContaining({
      target: "hollo",
      stage: "adapter-test",
      status: "failed",
      external: false,
    }),
  );
});

it("resets volumes and preserves stage classification in the matrix", async () => {
  const matrix = await readFile("test/e2e/run-fediverse-matrix.sh", "utf8");
  expect(matrix).toContain("down --volumes --remove-orphans");
  expect(matrix).toContain('record_stage "$target" checkout failed true');
  expect(matrix).toContain('record_stage "$target" build failed true');
  expect(matrix).toContain('record_stage "$target" provision failed true');
  expect(matrix).toContain("ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS=1");
  expect(matrix).toContain("MASTODON_MINIMUM_COMMIT");
  expect(matrix).toContain("ACTIVITYPLUG_E2E_RESULT_FD=3");
  expect(matrix).toContain("3>&1 1>&2");
  expect(matrix).toContain(
    'node --experimental-strip-types "$REPO_ROOT/scripts/run-fediverse-e2e-tests.ts"',
  );
  expect(matrix).toMatch(/if ! target_json=.*jq -e/s);
});
