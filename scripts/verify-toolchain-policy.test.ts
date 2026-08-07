import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { verifyToolchainPolicy } from "./verify-toolchain-policy.js";

it("requires the approved literal-latest architecture", async () => {
  expect(await verifyToolchainPolicy(new URL("../", import.meta.url))).toEqual([]);
});

it("rejects override policy in every workspace manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "activityplug-policy-"));
  try {
    await Promise.all([
      writeManifest(join(root, "package.json"), {
        devDependencies: { graphql: "^17.0.2", typescript: "^7.0.2" },
        engines: { node: ">=26 <27", pnpm: ">=11 <12" },
        packageManager: "pnpm@11.20.0",
      }),
      writeManifest(join(root, "examples/peer/package.json"), {
        name: "@fixture/peer",
        pnpm: { peerDependencyRules: { allowedVersions: { graphql: "17" } } },
      }),
      writeManifest(join(root, "packages/direct/package.json"), {
        name: "@fixture/direct",
        overrides: { graphql: "17.0.2" },
      }),
      writeManifest(join(root, "packages/pnpm/package.json"), {
        name: "@fixture/pnpm",
        pnpm: { overrides: { graphql: "17.0.2" } },
      }),
      writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - examples/*\n"),
    ]);

    expect(await verifyToolchainPolicy(pathToFileURL(`${root}/`))).toEqual([
      "examples/peer/package.json: pnpm.peerDependencyRules is forbidden",
      "packages/direct/package.json: overrides is forbidden",
      "packages/pnpm/package.json: pnpm.overrides is forbidden",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeManifest(path: string, manifest: unknown): Promise<void> {
  await mkdir(new URL("./", pathToFileURL(path)), { recursive: true });
  await writeFile(path, JSON.stringify(manifest));
}
