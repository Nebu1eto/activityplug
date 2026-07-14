import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  collectDocumentationSiblings,
  getExactHeadSha,
  getPublishedDocumentationPaths,
  resolveProductionImages,
  resolveEvidenceBase,
  repositoryGitEnvironment,
  verifyFinalEvidence,
  writeEvidenceAtomically,
} from "./verify-final-evidence.ts";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const digest = "a".repeat(64);
const headSha = "b".repeat(40);
const safeEnvironment = {
  ACTIVITYPLUG_CADDY_IMAGE: `caddy:2.11@sha256:${digest}`,
  ACTIVITYPLUG_NODE_IMAGE: `node:26@sha256:${digest}`,
  ACTIVITYPLUG_PNPM_VERSION: "11.12.0",
  ACTIVITYPLUG_POSTGRES_IMAGE: `postgres:18@sha256:${digest}`,
  ACTIVITYPLUG_POSTGRES_PASSWORD: "QWN0aXZpdHlQbHVnLXRlc3QtcG9zdGdyZXMtcGFzc3dvcmQ",
  ACTIVITYPLUG_REDIS_IMAGE: `redis:8@sha256:${digest}`,
  ACTIVITYPLUG_REDIS_PASSWORD: "QWN0aXZpdHlQbHVnLXRlc3QtcmVkaXMtcGFzc3dvcmQ",
};
const passingEvidenceProbes = {
  getHeadSha: async () => headSha,
  verifyDependencyFreshness: async () => 0,
  verifyProductionAudit: async () => 0,
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "activityplug-final-evidence-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "docs"), { recursive: true });
  await mkdir(join(directory, "artifacts", "verification"), { recursive: true });
  await writeDocumentationTriplet(directory, "docs/production-compose");
  await Promise.all(
    [
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
    ].map(async (name) => {
      const packageDirectory = join(directory, "packages", name);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({ name: `@activityplug/${name}` }),
      );
      await writeDocumentationTriplet(directory, `packages/${name}/README`);
    }),
  );
  return directory;
}

async function writeDocumentationTriplet(root: string, stem: string): Promise<void> {
  await writeFile(join(root, `${stem}.md`), "# English\n");
  await writeFile(join(root, `${stem}.ko.md`), "# Korean\n");
  await writeFile(join(root, `${stem}.ja.md`), "# Japanese\n");
}

describe("documentation siblings", () => {
  test("rejects missing and empty translated siblings", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
    await writeFile(join(root, "docs", "guide.ko.md"), "\n");
    await expect(collectDocumentationSiblings(root, ["docs/guide.md"])).rejects.toThrow(
      "nonempty ko sibling",
    );
    await writeFile(join(root, "docs", "guide.ko.md"), "# Korean\n");
    await expect(collectDocumentationSiblings(root, ["docs/guide.md"])).rejects.toThrow(
      "nonempty ja sibling",
    );
  });
});

test("always includes published documentation even without a branch diff", () => {
  expect(getPublishedDocumentationPaths()).toEqual(
    expect.arrayContaining(["docs/production-compose.md", "packages/core/README.md"]),
  );
});

describe("evidence base resolution", () => {
  test("returns undefined when no usable base ref is available", async () => {
    const root = await fixtureRoot();
    await expect(resolveEvidenceBase(root, {})).resolves.toBeUndefined();
  });

  test("falls back from a missing GitHub base ref to local main", async () => {
    const root = await fixtureRoot();
    await git(root, ["init", "--initial-branch=main"]);
    await git(root, ["config", "user.email", "test@example.test"]);
    await git(root, ["config", "user.name", "Test User"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "fixture"]);
    const expected = await git(root, ["rev-parse", "HEAD"]);
    await expect(resolveEvidenceBase(root, { GITHUB_BASE_REF: "missing" })).resolves.toBe(expected);
  });

  test("ignores repository state inherited from a parent Git hook", async () => {
    const root = await fixtureRoot();
    await git(root, ["init", "--initial-branch=main"]);
    await git(root, ["config", "user.email", "test@example.test"]);
    await git(root, ["config", "user.name", "Test User"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "fixture"]);
    const expected = await git(root, ["rev-parse", "HEAD"]);

    const inheritedRoot = await fixtureRoot();
    await git(inheritedRoot, ["init", "--initial-branch=main"]);
    vi.stubEnv("GIT_DIR", join(inheritedRoot, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", join(inheritedRoot, ".git", "index"));
    vi.stubEnv("GIT_WORK_TREE", inheritedRoot);

    await expect(resolveEvidenceBase(root, { GITHUB_BASE_REF: "missing" })).resolves.toBe(expected);
  });
});

test("rejects mutable and uppercase image digests", () => {
  expect(() =>
    resolveProductionImages({ ...safeEnvironment, ACTIVITYPLUG_NODE_IMAGE: "node:26" }),
  ).toThrow("not safely resolved");
  expect(() =>
    resolveProductionImages({
      ...safeEnvironment,
      ACTIVITYPLUG_NODE_IMAGE: `node:26@sha256:${"A".repeat(64)}`,
    }),
  ).toThrow("not safely resolved");
  expect(() =>
    resolveProductionImages({
      ...safeEnvironment,
      ACTIVITYPLUG_NODE_IMAGE: `node:26:mutable@sha256:${digest}`,
    }),
  ).toThrow("not safely resolved");
});

test("delegates credential-shaped tarball checks to the published tarball verifier", async () => {
  const root = await fixtureRoot();
  const verifyPublishedTarballs = vi.fn(async () => {
    throw new Error("credential-shaped data");
  });
  await expect(
    verifyFinalEvidence(root, {
      environment: safeEnvironment,
      getChangedPaths: async () => [],
      getGitStatus: async () => [],
      verifyCompose: async () => [],
      verifyPublishedTarballs,
      ...passingEvidenceProbes,
    }),
  ).rejects.toThrow("credential-shaped data");
  expect(verifyPublishedTarballs).toHaveBeenCalledWith(root);
});

test("writes deterministic redacted evidence", async () => {
  const root = await fixtureRoot();
  const output = "artifacts/verification/evidence.json";
  const options = {
    environment: { ...safeEnvironment, UNRELATED_SECRET: "must-not-appear" },
    getChangedPaths: async () => [],
    getGitStatus: async () => [],
    output,
    verifyCompose: async () => [],
    verifyPublishedTarballs: async () => undefined,
    ...passingEvidenceProbes,
  };
  await verifyFinalEvidence(root, options);
  const first = await readFile(join(root, output), "utf8");
  await verifyFinalEvidence(root, options);
  const second = await readFile(join(root, output), "utf8");
  expect(second).toBe(first);
  expect(first).not.toContain("must-not-appear");
  expect(first).not.toContain(safeEnvironment.ACTIVITYPLUG_POSTGRES_PASSWORD);
  expect(first).not.toContain(safeEnvironment.ACTIVITYPLUG_REDIS_PASSWORD);
  expect(JSON.parse(first)).toMatchObject({
    dependencyFreshness: { outdatedDirectDependencies: 0 },
    gitStatus: [],
    headSha,
    imageReferences: expect.any(Array),
    productionAudit: { advisories: 0 },
  });
});

test("fails before writing evidence for outdated direct dependencies", async () => {
  const root = await fixtureRoot();
  const output = "artifacts/verification/evidence.json";
  const verifyProductionAudit = vi.fn(async () => 0);

  await expect(
    verifyFinalEvidence(root, {
      environment: safeEnvironment,
      getChangedPaths: async () => [],
      getGitStatus: async () => [],
      getHeadSha: async () => headSha,
      output,
      verifyCompose: async () => [],
      verifyDependencyFreshness: async () => 2,
      verifyProductionAudit,
      verifyPublishedTarballs: async () => undefined,
    }),
  ).rejects.toThrow("Dependency freshness verification failed");
  await expect(readFile(join(root, output), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(verifyProductionAudit).not.toHaveBeenCalled();
});

test("fails before writing evidence for production advisories", async () => {
  const root = await fixtureRoot();
  const output = "artifacts/verification/evidence.json";

  await expect(
    verifyFinalEvidence(root, {
      environment: safeEnvironment,
      getChangedPaths: async () => [],
      getGitStatus: async () => [],
      getHeadSha: async () => headSha,
      output,
      verifyCompose: async () => [],
      verifyDependencyFreshness: async () => 0,
      verifyProductionAudit: async () => 3,
      verifyPublishedTarballs: async () => undefined,
    }),
  ).rejects.toThrow("Production dependency audit failed");
  await expect(readFile(join(root, output), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("sanitizes production audit probe failures", async () => {
  const root = await fixtureRoot();

  let thrown: unknown;
  try {
    await verifyFinalEvidence(root, {
      environment: safeEnvironment,
      getChangedPaths: async () => [],
      getGitStatus: async () => [],
      getHeadSha: async () => headSha,
      verifyCompose: async () => [],
      verifyDependencyFreshness: async () => 0,
      verifyProductionAudit: async () => {
        throw new Error("https://registry.example/advisory?token=must-not-appear");
      },
      verifyPublishedTarballs: async () => undefined,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toEqual(new Error("Production dependency audit failed"));
  expect(String(thrown)).not.toContain("must-not-appear");
});

test("rejects dirty worktrees without serializing their paths", async () => {
  const root = await fixtureRoot();
  await expect(
    verifyFinalEvidence(root, {
      environment: safeEnvironment,
      getChangedPaths: async () => [],
      getGitStatus: async () => ["M secret-token.txt"],
      verifyCompose: async () => [],
      verifyPublishedTarballs: async () => undefined,
      ...passingEvidenceProbes,
    }),
  ).rejects.toThrow("Git worktree must be clean");
});

test("rejects evidence output path traversal", async () => {
  const root = await fixtureRoot();
  await expect(
    writeEvidenceAtomically(root, "artifacts/verification/../../leak.json", {
      checks: [],
      documentationSiblings: [],
      gitStatus: [],
      imageReferences: [],
      packageNames: [],
      dependencyFreshness: { outdatedDirectDependencies: 0 },
      headSha,
      productionAudit: { advisories: 0 },
    }),
  ).rejects.toThrow("artifacts/verification");
});

test("resolves the exact HEAD while ignoring inherited Git repository state", async () => {
  const root = await fixtureRoot();
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "test@example.test"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "fixture"]);
  const expected = await git(root, ["rev-parse", "HEAD"]);

  const inheritedRoot = await fixtureRoot();
  await git(inheritedRoot, ["init", "--initial-branch=main"]);
  vi.stubEnv("GIT_DIR", join(inheritedRoot, ".git"));
  vi.stubEnv("GIT_INDEX_FILE", join(inheritedRoot, ".git", "index"));
  vi.stubEnv("GIT_WORK_TREE", inheritedRoot);

  await expect(getExactHeadSha(root)).resolves.toBe(expected);
  expect(expected).toMatch(/^[a-f0-9]{40}$/u);
});

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: repositoryGitEnvironment(),
  });
  return stdout.trim();
}
