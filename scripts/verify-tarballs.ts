import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const publishablePackages = [
  "core",
  "hackerspub",
  "hollo",
  "mastodon-base",
  "mastodon",
  "misskey",
  "pleroma",
  "server",
  "session-postgres",
  "session-redis",
] as const;

const requiredArchiveFiles = [
  "package.json",
  "README.md",
  "LICENSE-MIT",
  "LICENSE-APACHE",
] as const;

const forbiddenPathPattern =
  /(^|\/)(?:src|test|tests|__tests__|\.env(?:\..*)?|[^/]*(?:password|passwd|secret|credential|private[-_.]?key|access[-_.]?token|api[-_.]?key)[^/]*)(?:\/|$)/i;
const compiledTestPattern = /(^|\/)[^/]*\.(?:test|spec)\.[^/]+$/i;
const sourceMapPattern = /\.map$/i;
const credentialValuePattern =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bnpm_[A-Za-z0-9]{20,}\b|(?:authorization|password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|api[_-]?key)["']?\s*[=:]\s*["'][A-Za-z0-9_./+:-]{24,}["'])/i;

export type PackageManifest = {
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  name: string;
  peerDependencies?: Record<string, string>;
  types?: string;
  version: string;
  exports?: unknown;
};

export function assertFixedGroupVersion(manifests: readonly PackageManifest[]): void {
  const versions = new Set(
    manifests.map((manifest) => {
      const matchesSemver =
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
          manifest.version,
        );
      const prerelease = manifest.version.split("+", 1)[0]?.split("-").slice(1).join("-");
      const hasLeadingZeroPrerelease = prerelease
        ?.split(".")
        .some((identifier) => /^0\d+$/.test(identifier));
      if (!matchesSemver || hasLeadingZeroPrerelease) {
        throw new Error(`${manifest.name} has invalid semver ${manifest.version}`);
      }
      return manifest.version;
    }),
  );
  if (versions.size !== 1) {
    throw new Error(`Publishable packages must share one fixed-group version`);
  }
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  timeout = 120_000,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string };
    throw new Error(
      [failure.message, failure.stdout?.trim(), failure.stderr?.trim()].filter(Boolean).join("\n"),
      { cause: error },
    );
  }
}

function archivePath(entry: string): string {
  return entry.replace(/^\.\//, "").replace(/^package\//, "");
}

function collectExportSpecifiers(packageName: string, exportsField: unknown): string[] {
  if (exportsField === undefined) return [packageName];
  if (
    typeof exportsField === "string" ||
    Array.isArray(exportsField) ||
    (typeof exportsField === "object" &&
      exportsField !== null &&
      !Object.keys(exportsField).some((key) => key.startsWith(".")))
  ) {
    return [packageName];
  }

  return Object.keys(exportsField as Record<string, unknown>)
    .filter((key) => key === "." || (key.startsWith("./") && !key.includes("*")))
    .map((key) => (key === "." ? packageName : `${packageName}/${key.slice(2)}`));
}

export async function inspectTarball(
  tarball: string,
  rootLicenses: ReadonlyMap<string, Buffer>,
): Promise<PackageManifest> {
  const listing = await run("tar", ["-tzf", tarball], process.cwd());
  const entries = listing.split("\n").filter(Boolean);
  const paths = entries.map(archivePath);

  for (const required of requiredArchiveFiles) {
    if (!paths.includes(required)) {
      throw new Error(`${basename(tarball)} is missing ${required}`);
    }
  }

  for (const path of paths) {
    if (path === "" || path.endsWith("/")) continue;
    if (forbiddenPathPattern.test(path) || compiledTestPattern.test(path)) {
      throw new Error(`${basename(tarball)} contains forbidden path ${path}`);
    }
    if (
      !requiredArchiveFiles.includes(path as (typeof requiredArchiveFiles)[number]) &&
      !path.startsWith("dist/")
    ) {
      throw new Error(`${basename(tarball)} contains adjacent file ${path}`);
    }
  }

  const extraction = await mkdtemp(join(tmpdir(), "activityplug-archive-"));
  try {
    await run("tar", ["-xzf", tarball, "-C", extraction], process.cwd());
    const packageRoot = join(extraction, "package");
    for (const licenseName of ["LICENSE-MIT", "LICENSE-APACHE"] as const) {
      const actual = await readFile(join(packageRoot, licenseName));
      const expected = rootLicenses.get(licenseName);
      if (expected === undefined || !actual.equals(expected)) {
        throw new Error(`${basename(tarball)} has a noncanonical ${licenseName}`);
      }
    }

    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as PackageManifest;
    const binPaths =
      typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
    for (const binPath of binPaths) {
      const normalizedBinPath = binPath.replace(/^\.\//, "");
      if (!normalizedBinPath.startsWith("dist/") || !paths.includes(normalizedBinPath)) {
        throw new Error(`${basename(tarball)} declares missing bin ${binPath}`);
      }
    }
    for (const readme of ["README.md"] as const) {
      const contents = await readFile(join(packageRoot, readme), "utf8");
      if (contents.trim() === "") {
        throw new Error(`${basename(tarball)} contains an empty ${readme}`);
      }
      if (
        !contents.includes(`pnpm add ${manifest.name}`) ||
        !contents.includes(`import * as activityplug from "${manifest.name}";`) ||
        !/^(?:```|~~~~) ?sh$/m.test(contents) ||
        !/^(?:```|~~~~) ?ts$/m.test(contents)
      ) {
        throw new Error(`${basename(tarball)} contains malformed ${readme}`);
      }
    }

    for (const entryPath of paths.filter((path) => path && !path.endsWith("/"))) {
      const extractedPath = join(packageRoot, entryPath);
      const metadata = await lstat(extractedPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`${basename(tarball)} contains non-file entry ${entryPath}`);
      }
      const bytes = await readFile(extractedPath);
      if (sourceMapPattern.test(entryPath)) {
        throw new Error(`${basename(tarball)} contains forbidden source map ${entryPath}`);
      }
      if (credentialValuePattern.test(bytes.toString("utf8"))) {
        throw new Error(`${basename(tarball)} contains credential-shaped data in ${entryPath}`);
      }
    }

    return manifest;
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

export async function createConsumer(
  directory: string,
  target: PackageManifest,
  tarballs: ReadonlyMap<string, string>,
  manifests: ReadonlyMap<string, PackageManifest>,
  repositoryRoot: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const tarballReferences = Object.fromEntries(
    [...tarballs].map(([name, tarball]) => [name, `file:${tarball}`]),
  );
  const peerDependencies: Record<string, string> = {};
  const pending = [target];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const manifest = pending.pop();
    if (manifest === undefined || visited.has(manifest.name)) continue;
    visited.add(manifest.name);
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const selected = tarballReferences[name] ?? range;
      const existing = peerDependencies[name];
      if (existing !== undefined && existing !== selected) {
        throw new Error(`${target.name} has conflicting peer ranges for ${name}`);
      }
      peerDependencies[name] = selected;
    }
    for (const name of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]) {
      const localManifest = manifests.get(name);
      if (localManifest !== undefined) pending.push(localManifest);
    }
  }
  const dependencies = {
    "@types/node": "26.1.1",
    ...peerDependencies,
    [target.name]: tarballReferences[target.name],
  };
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    `overrides:\n${Object.entries(tarballReferences)
      .map(([name, tarball]) => `  ${JSON.stringify(name)}: ${JSON.stringify(tarball)}`)
      .join("\n")}\n`,
  );
  await run("pnpm", ["install", "--ignore-scripts", "--frozen-lockfile=false"], directory);

  const specifiers = collectExportSpecifiers(target.name, target.exports);
  const imports = specifiers
    .map(
      (specifier, index) =>
        `import * as exported${index} from ${JSON.stringify(specifier)};\nvoid exported${index};`,
    )
    .join("\n");
  await writeFile(
    join(directory, "verify.mjs"),
    `${specifiers.map((specifier) => `await import(${JSON.stringify(specifier)});`).join("\n")}\n`,
  );
  await run("node", ["verify.mjs"], directory);
  await writeFile(join(directory, "verify.ts"), `${imports}\n`);
  await writeFile(
    join(directory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2024",
          types: ["node"],
          lib: ["ES2024", "ESNext.Disposable", "DOM"],
        },
        files: ["verify.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await run("node", [join(repositoryRoot, "node_modules", "typescript", "bin", "tsc")], directory);

  const binPaths = typeof target.bin === "string" ? [target.bin] : Object.values(target.bin ?? {});
  const installedPackage = join(directory, "node_modules", ...target.name.split("/"));
  for (const binPath of binPaths) {
    await run("node", [join(installedPackage, binPath), "--help"], directory, 15_000);
  }
}

export async function verifyTarballs(repositoryRoot: string): Promise<void> {
  const pnpmVersion = await run("pnpm", ["--version"], repositoryRoot);
  if (!pnpmVersion.startsWith("11.")) {
    throw new Error(`Tarball consumers require pnpm 11, received ${pnpmVersion}`);
  }

  const workspace = await mkdtemp(join(tmpdir(), "activityplug-tarballs-"));
  const packDirectory = join(workspace, "packs");
  await mkdir(packDirectory);

  try {
    const rootLicenses = new Map(
      await Promise.all(
        (["LICENSE-MIT", "LICENSE-APACHE"] as const).map(
          async (name) => [name, await readFile(join(repositoryRoot, name))] as const,
        ),
      ),
    );
    const tarballs = new Map<string, string>();
    const manifests = new Map<string, PackageManifest>();

    for (const packageDirectory of publishablePackages) {
      const cwd = join(repositoryRoot, "packages", packageDirectory);
      await run("pnpm", ["pack", "--pack-destination", packDirectory], cwd);
      const candidates = (await readdir(packDirectory))
        .filter((name) => name.endsWith(".tgz"))
        .map((name) => join(packDirectory, name));
      const newest = candidates.find((candidate) => ![...tarballs.values()].includes(candidate));
      if (newest === undefined) throw new Error(`pnpm pack produced no archive for ${cwd}`);

      const manifest = await inspectTarball(newest, rootLicenses);
      tarballs.set(manifest.name, resolve(newest));
      manifests.set(manifest.name, manifest);
    }

    assertFixedGroupVersion([...manifests.values()]);

    for (const [name, manifest] of manifests) {
      const slug = name.replace(/^@/, "").replaceAll("/", "-");
      await createConsumer(
        join(workspace, "consumers", slug),
        manifest,
        tarballs,
        manifests,
        repositoryRoot,
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  await verifyTarballs(repositoryRoot);
  console.log("Verified publishable package tarballs in clean-room consumers.");
}
