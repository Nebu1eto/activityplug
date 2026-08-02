import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  assertFixedGroupVersion,
  createConsumer,
  inspectTarball,
  verifyTarballs,
} from "./verify-tarballs.ts";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "..");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureTarball(
  extraFile?: [path: string, contents: string, kind?: "file" | "symlink"],
  manifestPatch: Record<string, unknown> = {},
  declaration = "export declare const ok: true;\n",
): Promise<{
  tarball: string;
  licenses: Map<string, Buffer>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "activityplug-tarball-test-"));
  temporaryDirectories.push(directory);
  const packageRoot = join(directory, "package");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  const licenses = new Map<string, Buffer>();
  for (const name of ["LICENSE-MIT", "LICENSE-APACHE"] as const) {
    const contents = await readFile(join(repositoryRoot, name));
    licenses.set(name, contents);
    await writeFile(join(packageRoot, name), contents);
  }
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@activityplug/fixture",
      version: "0.1.0",
      types: "./dist/index.d.mts",
      exports: {
        ".": {
          types: "./dist/index.d.mts",
          default: "./dist/index.mjs",
        },
      },
      ...manifestPatch,
    })}\n`,
  );
  const readme = `# Fixture\n\n\`\`\`sh\npnpm add @activityplug/fixture\n\`\`\`\n\n\`\`\`ts\nimport * as activityplug from "@activityplug/fixture";\n\`\`\`\n`;
  await writeFile(join(packageRoot, "README.md"), readme);
  await writeFile(join(packageRoot, "dist/index.mjs"), "export const ok = true;\n");
  await writeFile(join(packageRoot, "dist/index.d.mts"), declaration);
  if (extraFile !== undefined) {
    const [path, contents, kind = "file"] = extraFile;
    await mkdir(join(packageRoot, path, ".."), { recursive: true });
    if (kind === "symlink") {
      await symlink(contents, join(packageRoot, path));
    } else {
      await writeFile(join(packageRoot, path), contents);
    }
  }
  const tarball = join(directory, "fixture.tgz");
  await execFileAsync("tar", ["-czf", tarball, "package"], { cwd: directory });
  return { tarball, licenses };
}

describe("inspectTarball", () => {
  test("accepts only the built artifact and required publication files", async () => {
    const { tarball, licenses } = await fixtureTarball();
    await expect(inspectTarball(tarball, licenses)).resolves.toMatchObject({
      name: "@activityplug/fixture",
      version: "0.1.0",
    });
  });

  test("rejects source files found in the archive bytes", async () => {
    const { tarball, licenses } = await fixtureTarball(["src/private.ts", "export {};\n"]);
    await expect(inspectTarball(tarball, licenses)).rejects.toThrow(
      "forbidden path src/private.ts",
    );
  });

  test("rejects credential-shaped values in otherwise allowed files", async () => {
    const { tarball, licenses } = await fixtureTarball([
      "dist/config.mjs",
      "export const password = 'password=\"0123456789abcdefghijklmn\"';\n",
    ]);
    await expect(inspectTarball(tarball, licenses)).rejects.toThrow("credential-shaped data");
  });

  test("rejects symlinks that could expose adjacent checkout files", async () => {
    const { tarball, licenses } = await fixtureTarball([
      "dist/adjacent.mjs",
      "../../outside.mjs",
      "symlink",
    ]);
    await expect(inspectTarball(tarball, licenses)).rejects.toThrow(
      "non-file entry dist/adjacent.mjs",
    );
  });

  test("rejects every source map even without embedded source content", async () => {
    const { tarball, licenses } = await fixtureTarball([
      "dist/index.mjs.map",
      JSON.stringify({
        sources: ["../src/index.ts"],
      }),
    ]);
    await expect(inspectTarball(tarball, licenses)).rejects.toThrow(
      "forbidden source map dist/index.mjs.map",
    );
  });

  test.each(["dist/index.mjs.MAP", "dist/index.mjs.MaP"])(
    "rejects case-variant source maps regardless of contents: %s",
    async (path) => {
      const { tarball, licenses } = await fixtureTarball([path, "{}\n"]);
      await expect(inspectTarball(tarball, licenses)).rejects.toThrow(
        `forbidden source map ${path}`,
      );
    },
  );

  test("rejects a declared bin that is absent from the archive", async () => {
    const { tarball, licenses } = await fixtureTarball(undefined, {
      bin: { fixture: "./dist/missing.mjs" },
    });
    await expect(inspectTarball(tarball, licenses)).rejects.toThrow(
      "declares missing bin ./dist/missing.mjs",
    );
  });

  test("rejects a package that publishes neither exports nor bin", async () => {
    const { tarball, licenses } = await fixtureTarball(undefined, { exports: undefined });
    await expect(inspectTarball(tarball, licenses)).rejects.toThrow(
      "declares neither exports nor bin",
    );
  });

  test("accepts an executable package without a library export", async () => {
    const { tarball, licenses } = await fixtureTarball(undefined, {
      bin: { fixture: "./dist/index.mjs" },
      exports: undefined,
      types: undefined,
    });
    await expect(inspectTarball(tarball, licenses)).resolves.toMatchObject({
      name: "@activityplug/fixture",
    });
  });

  test("rejects invalid published declarations in a clean-room consumer", async () => {
    const { tarball, licenses } = await fixtureTarball(
      undefined,
      {},
      "export declare const broken: ;\n",
    );
    const manifest = await inspectTarball(tarball, licenses);
    const consumer = await mkdtemp(join(tmpdir(), "activityplug-consumer-test-"));
    temporaryDirectories.push(consumer);
    await expect(
      createConsumer(
        consumer,
        manifest,
        new Map([[manifest.name, tarball]]),
        new Map([[manifest.name, manifest]]),
        repositoryRoot,
      ),
    ).rejects.toThrow();
  });
});

describe("assertFixedGroupVersion", () => {
  test("accepts a future shared semantic version", () => {
    expect(() =>
      assertFixedGroupVersion([
        { name: "@activityplug/one", version: "1.2.3" },
        { name: "@activityplug/two", version: "1.2.3" },
      ]),
    ).not.toThrow();
  });

  test("rejects invalid or divergent package versions", () => {
    expect(() => assertFixedGroupVersion([{ name: "@activityplug/one", version: "1.2" }])).toThrow(
      "invalid semver",
    );
    expect(() =>
      assertFixedGroupVersion([{ name: "@activityplug/one", version: "1.2.3-01" }]),
    ).toThrow("invalid semver");
    expect(() =>
      assertFixedGroupVersion([
        { name: "@activityplug/one", version: "1.2.3" },
        { name: "@activityplug/two", version: "1.2.4" },
      ]),
    ).toThrow("must share one fixed-group version");
  });
});

test("all publishable packages install and import from verified tarballs", async () => {
  await verifyTarballs(repositoryRoot);
}, 180_000);
