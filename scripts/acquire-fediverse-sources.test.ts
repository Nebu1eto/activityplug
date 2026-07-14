import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { expect, it, vi } from "vitest";

import { acquireFediverseSource, type Spawn } from "./acquire-fediverse-sources.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

function spawnSequence(
  results: ReadonlyArray<
    | { readonly code?: number; readonly signal?: NodeJS.Signals | null; readonly stdout?: string }
    | { readonly error: Error }
  >,
  calls: string[][] = [],
): Spawn {
  let index = 0;
  return ((command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
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
      if (result.stdout !== undefined) child.stdout.end(result.stdout);
      else child.stdout.end();
      child.stderr.end();
      child.emit("close", result.code ?? 0, result.signal ?? null);
    });
    return child;
  }) as Spawn;
}

it("fetches an exact ref into the external cache and verifies HEAD", async () => {
  const calls: string[][] = [];
  const mkdir = vi.fn(async () => undefined);
  const stat = vi.fn(async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  const spawn = spawnSequence(
    [{}, {}, {}, { stdout: `${commit}\n` }, {}, {}, {}, { stdout: `${commit}\n` }],
    calls,
  );

  await expect(
    acquireFediverseSource(
      {
        software: "pleroma",
        repository: "https://example.test/pleroma.git",
        ref: "v2.10.2",
        commit,
      },
      {
        env: { HOME: "/home/test" },
        fs: { mkdir, stat },
        spawn,
      },
    ),
  ).resolves.toBe(`/home/test/.cache/activityplug/fediverse-sources/pleroma/${commit}`);
  expect(mkdir).toHaveBeenCalledWith("/home/test/.cache/activityplug/fediverse-sources/pleroma", {
    recursive: true,
  });
  expect(calls[3]).toEqual([
    "git",
    "-C",
    `/home/test/.cache/activityplug/fediverse-sources/pleroma/${commit}`,
    "rev-parse",
    "FETCH_HEAD^{commit}",
  ]);
  expect(calls).toContainEqual([
    "git",
    "-C",
    `/home/test/.cache/activityplug/fediverse-sources/pleroma/${commit}`,
    "clean",
    "-ffdx",
  ]);
});

it("uses XDG_CACHE_HOME and rejects a fetched ref at the wrong commit", async () => {
  const wrong = "f".repeat(40);
  await expect(
    acquireFediverseSource(
      {
        software: "pleroma",
        repository: "https://example.test/pleroma.git",
        ref: "v2.10.2",
        commit,
      },
      {
        env: { HOME: "/home/test", XDG_CACHE_HOME: "/cache" },
        fs: {
          mkdir: async () => undefined,
          stat: async () => ({ isDirectory: () => true }),
        },
        spawn: spawnSequence([{}, {}, { stdout: `${wrong}\n` }]),
      },
    ),
  ).rejects.toThrow(`resolved to ${wrong}, expected ${commit}`);
});
