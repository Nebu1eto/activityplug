import { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { expect, it, vi } from "vitest";

import { buildPleromaE2E, type Spawn } from "./build-pleroma-e2e.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

function spawnSequence(
  results: ReadonlyArray<
    { readonly code?: number; readonly stdout?: string } | { readonly error: Error }
  >,
  calls: string[][] = [],
  options: SpawnOptions[] = [],
): Spawn {
  let index = 0;
  return ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    calls.push([command, ...args]);
    options.push(spawnOptions);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const result = results[index++];
    queueMicrotask(() => {
      if (result === undefined) throw new Error(`Unexpected spawn: ${command}`);
      if ("error" in result) {
        child.emit("error", result.error);
        child.emit("close", 1, null);
        return;
      }
      child.stdout.end(result.stdout ?? "");
      child.stderr.end();
      child.emit("close", result.code ?? 0, null);
    });
    return child;
  }) as Spawn;
}

it("builds from the verified checkout without changing upstream source", async () => {
  const calls: string[][] = [];
  const options: SpawnOptions[] = [];
  const spawn = spawnSequence([{ stdout: `${commit}\n` }, {}, { stdout: "" }], calls, options);

  await expect(
    buildPleromaE2E(
      { sourceDirectory: "/cache/pleroma", commit, repositoryRoot: "/repo" },
      { spawn },
    ),
  ).resolves.toBe(`activityplug-pleroma-e2e:${commit}`);
  expect(calls[1]).toEqual([
    "docker",
    "build",
    "--file",
    "/repo/test/e2e/pleroma/Dockerfile",
    "--build-context",
    "pleroma_source=/cache/pleroma",
    "--build-arg",
    `SOURCE_REF=${commit}`,
    "--tag",
    `activityplug-pleroma-e2e:${commit}`,
    "--tag",
    "activityplug-fediverse-e2e-pleroma-web",
    "/repo",
  ]);
  expect(calls.at(-1)).toEqual(["git", "-C", "/cache/pleroma", "status", "--porcelain"]);
  expect(options[1]?.stdio).toEqual(["ignore", process.stderr, process.stderr]);
});

it("classifies Docker build failures as external build failures", async () => {
  const onResult = vi.fn();
  await expect(
    buildPleromaE2E(
      { sourceDirectory: "/cache/pleroma", commit, repositoryRoot: "/repo" },
      {
        onResult,
        spawn: spawnSequence([{ stdout: `${commit}\n` }, { code: 17 }]),
      },
    ),
  ).rejects.toThrow("code 17");
  expect(onResult).toHaveBeenLastCalledWith(
    expect.objectContaining({
      target: "pleroma",
      stage: "build",
      status: "failed",
      external: true,
    }),
  );
});

it("fails if the builder modifies Pleroma application source", async () => {
  await expect(
    buildPleromaE2E(
      { sourceDirectory: "/cache/pleroma", commit, repositoryRoot: "/repo" },
      {
        spawn: spawnSequence([
          { stdout: `${commit}\n` },
          {},
          { stdout: " M lib/pleroma/application.ex\n" },
        ]),
      },
    ),
  ).rejects.toThrow("modified the verified Pleroma checkout");
});
