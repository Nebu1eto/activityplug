import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { verifyComposePins, verifyProductionEnvironment } from "./verify-compose-pins.ts";
import { publishablePackages, verifyTarballs } from "./verify-tarballs.ts";

const execFileAsync = promisify(execFile);
const repositoryScopedGitVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;
const productionImageVariables = [
  "ACTIVITYPLUG_NODE_IMAGE",
  "ACTIVITYPLUG_CADDY_IMAGE",
  "ACTIVITYPLUG_POSTGRES_IMAGE",
  "ACTIVITYPLUG_REDIS_IMAGE",
] as const;
const imageName = "[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*";
const imageTag = "[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}";
const exactImageReference = new RegExp(`^${imageName}:${imageTag}@sha256:[a-f0-9]{64}$`);

export type FinalEvidence = {
  checks: string[];
  dependencyFreshness: { readonly outdatedDirectDependencies: 0 };
  documentationSiblings: string[];
  gitStatus: string[];
  headSha: string;
  imageReferences: string[];
  packageNames: string[];
  productionAudit: { readonly advisories: 0 };
};

export type FinalEvidenceOptions = {
  environment?: NodeJS.ProcessEnv;
  getChangedPaths?: (repositoryRoot: string) => Promise<string[]>;
  getGitStatus?: (repositoryRoot: string) => Promise<string[]>;
  getHeadSha?: (repositoryRoot: string) => Promise<string>;
  output?: string;
  verifyCompose?: (repositoryRoot: URL) => Promise<string[]>;
  verifyDependencyFreshness?: (repositoryRoot: string) => Promise<number>;
  verifyProductionAudit?: (repositoryRoot: string) => Promise<number>;
  verifyPublishedTarballs?: (repositoryRoot: string) => Promise<void>;
};

/** Resolves a usable base commit without assuming a local main branch exists. */
export async function resolveEvidenceBase(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const githubBase = environment["GITHUB_BASE_REF"];
  const candidates = [
    environment["ACTIVITYPLUG_EVIDENCE_BASE"],
    githubBase === undefined || githubBase === "" ? undefined : `origin/${githubBase}`,
    githubBase,
    "main",
    "origin/main",
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    const resolved = await resolveGitCommit(repositoryRoot, candidate);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Returns changed English Markdown paths when a base commit is available. */
export async function getChangedDocumentationPaths(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const base = await resolveEvidenceBase(repositoryRoot, environment);
  if (base === undefined) return [];
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", `${base}...HEAD`, "--"],
    { cwd: repositoryRoot, encoding: "utf8", env: repositoryGitEnvironment() },
  );
  const entries = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length - 1;) {
    const status = entries[index++];
    if (status === undefined || status === "") break;
    if (status.startsWith("R") || status.startsWith("C")) index += 1;
    const path = entries[index++];
    if (path !== undefined && isPublishableEnglishMarkdown(path)) paths.push(path);
  }
  return paths.toSorted();
}

/** Lists published Markdown that must retain translation parity on every ref. */
export function getPublishedDocumentationPaths(): string[] {
  return [
    "docs/production-compose.md",
    ...publishablePackages.map((directory) => `packages/${directory}/README.md`),
  ].toSorted();
}

/** Rejects documentation without complete Korean and Japanese siblings. */
export async function collectDocumentationSiblings(
  repositoryRoot: string,
  changedPaths: readonly string[],
): Promise<string[]> {
  const siblings: string[] = [];
  for (const path of changedPaths) {
    if (!isPublishableEnglishMarkdown(path)) continue;
    const stem = path.slice(0, -".md".length);
    for (const language of ["ko", "ja"] as const) {
      const sibling = `${stem}.${language}.md`;
      let contents: string;
      try {
        contents = await readFile(resolve(repositoryRoot, sibling), "utf8");
      } catch {
        throw new Error(`Published documentation requires a nonempty ${language} sibling`);
      }
      if (contents.trim() === "") {
        throw new Error(`Published documentation requires a nonempty ${language} sibling`);
      }
      siblings.push(sibling);
    }
  }
  return siblings.toSorted();
}

/** Resolves and validates only allowlisted production image references. */
export function resolveProductionImages(environment: NodeJS.ProcessEnv): string[] {
  const violations = [
    ...verifyProductionEnvironment(environment, "durable"),
    ...verifyProductionEnvironment(environment, "memory"),
  ];
  if (violations.length > 0) {
    throw new Error("Production image references are not safely resolved");
  }
  const images = productionImageVariables.map((variable) => environment[variable]);
  if (images.some((image) => image === undefined || !exactImageReference.test(image))) {
    throw new Error("Production image references are not safely resolved");
  }
  return [...new Set(images as string[])].toSorted();
}

/** Fails before output when tracked or untracked worktree changes exist. */
export async function getSanitizedGitStatus(repositoryRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: repositoryGitEnvironment(),
  });
  if (stdout !== "") throw new Error("Git worktree must be clean except ignored output");
  return [];
}

/** Runs the recursive direct-dependency freshness gate without retaining package details. */
export async function verifyDependencyFreshness(repositoryRoot: string): Promise<number> {
  await execFileAsync("pnpm", ["outdated", "--recursive"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
  });
  return 0;
}

/** Runs the production-only advisory gate without retaining advisory details or URLs. */
export async function verifyProductionAudit(repositoryRoot: string): Promise<number> {
  await execFileAsync("pnpm", ["audit", "--prod", "--audit-level", "info"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
  });
  return 0;
}

/** Resolves the complete object ID for the checked-out HEAD commit. */
export async function getExactHeadSha(repositoryRoot: string): Promise<string> {
  let headSha: string;
  try {
    headSha = await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      "HEAD^{commit}",
    ]);
  } catch {
    throw new Error("Unable to resolve the exact HEAD commit");
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(headSha)) {
    throw new Error("Unable to resolve the exact HEAD commit");
  }
  return headSha;
}

export async function verifyFinalEvidence(
  repositoryRoot: string,
  options: FinalEvidenceOptions = {},
): Promise<FinalEvidence> {
  const environment = options.environment ?? process.env;
  const checkCompose = options.verifyCompose ?? verifyComposePins;
  const checkDependencyFreshness = options.verifyDependencyFreshness ?? verifyDependencyFreshness;
  const checkProductionAudit = options.verifyProductionAudit ?? verifyProductionAudit;
  const checkTarballs = options.verifyPublishedTarballs ?? verifyTarballs;
  const changedPaths = await (options.getChangedPaths ?? getChangedDocumentationPaths)(
    repositoryRoot,
  );
  const documentationPaths = [
    ...new Set([...changedPaths, ...getPublishedDocumentationPaths()]),
  ].toSorted();
  const documentationSiblings = await collectDocumentationSiblings(
    repositoryRoot,
    documentationPaths,
  );
  const composeViolations = await checkCompose(pathToFileURL(`${repositoryRoot}/`));
  if (composeViolations.length > 0) throw new Error("Production Compose verification failed");
  const imageReferences = resolveProductionImages(environment);
  await checkTarballs(repositoryRoot);
  const outdatedDirectDependencies = await requireZeroCount(
    checkDependencyFreshness,
    repositoryRoot,
    "Dependency freshness verification failed",
  );
  const productionAdvisories = await requireZeroCount(
    checkProductionAudit,
    repositoryRoot,
    "Production dependency audit failed",
  );
  const gitStatus = await (options.getGitStatus ?? getSanitizedGitStatus)(repositoryRoot);
  if (gitStatus.length > 0) throw new Error("Git worktree must be clean except ignored output");
  const headSha = await getSanitizedHeadSha(repositoryRoot, options.getHeadSha ?? getExactHeadSha);
  const packageNames = await readPublishablePackageNames(repositoryRoot);
  const evidence: FinalEvidence = {
    checks: [
      "changed-documentation",
      "dependency-freshness",
      "git-worktree",
      "head-commit",
      "production-compose",
      "production-dependency-audit",
      "production-image-references",
      "published-tarballs",
    ],
    dependencyFreshness: { outdatedDirectDependencies },
    documentationSiblings,
    gitStatus,
    headSha,
    imageReferences,
    packageNames,
    productionAudit: { advisories: productionAdvisories },
  };
  if (options.output !== undefined)
    await writeEvidenceAtomically(repositoryRoot, options.output, evidence);
  return evidence;
}

async function requireZeroCount(
  probe: (repositoryRoot: string) => Promise<number>,
  repositoryRoot: string,
  errorMessage: string,
): Promise<0> {
  let count: number;
  try {
    count = await probe(repositoryRoot);
  } catch {
    throw new Error(errorMessage);
  }
  if (count !== 0) throw new Error(errorMessage);
  return 0;
}

async function getSanitizedHeadSha(
  repositoryRoot: string,
  getHeadSha: (repositoryRoot: string) => Promise<string>,
): Promise<string> {
  let headSha: string;
  try {
    headSha = await getHeadSha(repositoryRoot);
  } catch {
    throw new Error("Unable to resolve the exact HEAD commit");
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(headSha)) {
    throw new Error("Unable to resolve the exact HEAD commit");
  }
  return headSha;
}

export async function writeEvidenceAtomically(
  repositoryRoot: string,
  output: string,
  evidence: FinalEvidence,
): Promise<void> {
  const outputPath = resolve(repositoryRoot, output);
  const verificationDirectory = resolve(repositoryRoot, "artifacts", "verification");
  if (!isWithin(verificationDirectory, outputPath) || !outputPath.endsWith(".json")) {
    throw new Error("Evidence output must be a JSON file under artifacts/verification");
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await rm(temporaryPath, { force: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isPublishableEnglishMarkdown(path: string): boolean {
  return (
    path.endsWith(".md") &&
    !path.endsWith(".ko.md") &&
    !path.endsWith(".ja.md") &&
    !path.startsWith("docs/superpowers/")
  );
}

function isWithin(directory: string, path: string): boolean {
  const pathRelative = relative(directory, path);
  return pathRelative !== "" && pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`);
}

async function readPublishablePackageNames(repositoryRoot: string): Promise<string[]> {
  const names = await Promise.all(
    publishablePackages.map(async (directory) => {
      const manifest = JSON.parse(
        await readFile(resolve(repositoryRoot, "packages", directory, "package.json"), "utf8"),
      ) as { name: string };
      return manifest.name;
    }),
  );
  return names.toSorted();
}

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: repositoryGitEnvironment(),
  });
  return stdout.trim();
}

/** Lets the requested cwd select Git state even when a parent hook exports its own repository. */
export function repositoryGitEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const isolatedEnvironment = { ...environment };
  for (const variable of repositoryScopedGitVariables) delete isolatedEnvironment[variable];
  return isolatedEnvironment;
}

async function resolveGitCommit(
  repositoryRoot: string,
  reference: string,
): Promise<string | undefined> {
  try {
    return await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${reference}^{commit}`,
    ]);
  } catch {
    return undefined;
  }
}

function isEntrypoint(): boolean {
  return (
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isEntrypoint()) {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
  if (outputIndex !== -1 && (output === undefined || process.argv.length !== outputIndex + 2)) {
    throw new Error("Usage: verify-final-evidence.ts [--output artifacts/verification/name.json]");
  }
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  await verifyFinalEvidence(repositoryRoot, { output });
  console.log("Verified final release evidence.");
}
