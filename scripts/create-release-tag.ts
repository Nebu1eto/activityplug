import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { publishablePackages } from "./verify-tarballs.ts";

const execFileAsync = promisify(execFile);
const semanticVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type ReleaseTagOptions = {
  readonly dryRun?: boolean;
  readonly git?: (repositoryRoot: string, args: readonly string[]) => Promise<string>;
  readonly readVersion?: (repositoryRoot: string) => Promise<string>;
};

export type ReleaseTagResult = {
  readonly created: boolean;
  readonly tag: string;
  readonly version: string;
};

/**
 * Reads the single release version shared by every published package.
 *
 * The workspace keeps published packages in one `fixed` changesets group, so a
 * disagreement means the version step did not complete and must not be tagged.
 */
export async function readReleaseVersion(repositoryRoot: string): Promise<string> {
  const versions = new Map<string, string>();
  for (const directory of publishablePackages) {
    const manifestPath = resolve(repositoryRoot, "packages", directory, "package.json");
    let manifest: { readonly name?: string; readonly version?: string };
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
    } catch {
      throw new Error(`Unable to read the manifest for packages/${directory}`);
    }
    const { name, version } = manifest;
    if (name === undefined || version === undefined || !semanticVersion.test(version)) {
      throw new Error(`packages/${directory} must declare a name and an exact version`);
    }
    versions.set(name, version);
  }
  const distinct = new Set(versions.values());
  const [released] = distinct;
  if (distinct.size !== 1 || released === undefined) {
    throw new Error(
      `Published packages must share one version, found ${[...distinct].toSorted().join(", ")}`,
    );
  }
  return released;
}

/**
 * Creates the repository-wide release tag for the current published version.
 *
 * Published packages release together, so the repository carries one annotated
 * tag per release instead of one tag for every package.
 */
export async function createReleaseTag(
  repositoryRoot: string,
  options: ReleaseTagOptions = {},
): Promise<ReleaseTagResult> {
  const git = options.git ?? runGit;
  const version = await (options.readVersion ?? readReleaseVersion)(repositoryRoot);
  const tag = `v${version}`;

  const existing = await git(repositoryRoot, ["tag", "--list", tag]);
  if (existing !== "") return { created: false, tag, version };

  if (options.dryRun === true) return { created: false, tag, version };

  await git(repositoryRoot, ["tag", "--annotate", "--message", `ActivityPlug ${version}`, tag]);
  await git(repositoryRoot, ["push", "origin", tag]);
  return { created: true, tag, version };
}

async function runGit(repositoryRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return stdout.trim();
}

/**
 * Collects the release notes for one version from the published changelogs.
 *
 * Published packages share every release, so internal dependency bumps repeat
 * across all of them. Only packages with their own notes are listed, keeping
 * the release focused on what actually changed.
 */
export async function collectReleaseNotes(
  repositoryRoot: string,
  version: string,
): Promise<string> {
  const sections: string[] = [];
  for (const directory of publishablePackages) {
    const changelogPath = resolve(repositoryRoot, "packages", directory, "CHANGELOG.md");
    let changelog: string;
    try {
      changelog = await readFile(changelogPath, "utf8");
    } catch {
      continue;
    }
    const entry = changelogEntry(changelog, version);
    if (entry === undefined) continue;
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "packages", directory, "package.json"), "utf8"),
    ) as { readonly name: string };
    sections.push(`## ${manifest.name}\n\n${entry}`);
  }
  if (sections.length === 0) {
    return `ActivityPlug ${version} publishes every package with no separate notes.\n`;
  }
  return `${sections.join("\n\n")}\n`;
}

/** Extracts the body of one `## <version>` changelog section. */
export function changelogEntry(changelog: string, version: string): string | undefined {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  const meaningful = withoutDependencyBumps(body);
  return meaningful === "" ? undefined : meaningful;
}

/**
 * Drops internal dependency bumps so shared releases stay readable.
 *
 * A `fixed` group republishes every package, so each changelog repeats the same
 * workspace bumps that carry no information for readers.
 */
function withoutDependencyBumps(body: string): string {
  const kept = body
    .split("\n")
    .filter((line) => !/^\s*-\s+@activityplug\/[^@\s]+@\S+\s*$/.test(line))
    .filter((line) => !/^\s*-\s+Updated dependencies\b/.test(line));
  return kept
    .join("\n")
    .replace(/^###\s+\S.*$(?:\n\s*)*(?=###\s|\s*$)/gmu, "")
    .trim();
}

/** Publishes the GitHub release for the current version when none exists yet. */
export async function publishRelease(
  repositoryRoot: string,
  options: ReleaseTagOptions = {},
): Promise<{ readonly created: boolean; readonly tag: string }> {
  const version = await (options.readVersion ?? readReleaseVersion)(repositoryRoot);
  const tag = `v${version}`;
  try {
    await execFileAsync("gh", ["release", "view", tag], { cwd: repositoryRoot });
    return { created: false, tag };
  } catch {
    // A missing release is the expected path for a new version.
  }
  const notes = await collectReleaseNotes(repositoryRoot, version);
  const directory = await mkdtemp(join(tmpdir(), "activityplug-release-"));
  const notesPath = join(directory, "notes.md");
  try {
    await writeFile(notesPath, notes, { mode: 0o600 });
    if (options.dryRun === true) return { created: false, tag };
    await execFileAsync(
      "gh",
      [
        "release",
        "create",
        tag,
        "--title",
        `ActivityPlug ${version}`,
        "--notes-file",
        notesPath,
        "--verify-tag",
      ],
      { cwd: repositoryRoot },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
  return { created: true, tag };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const dryRun = process.argv.includes("--dry-run");
  if (process.argv.includes("--publish")) {
    const release = await publishRelease(repositoryRoot, { dryRun });
    console.log(
      release.created
        ? `Published the ${release.tag} release.`
        : `Release ${release.tag} already exists.`,
    );
  } else {
    const result = await createReleaseTag(repositoryRoot, { dryRun });
    console.log(
      result.created
        ? `Created and pushed ${result.tag}.`
        : `Release tag ${result.tag} already exists.`,
    );
  }
}
